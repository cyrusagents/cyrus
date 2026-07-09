import { EventEmitter } from "node:events";
import {
	type AgentAssistantMessage,
	type AgentMessage,
	type AgentPendingWork,
	type AgentRateLimitMessage,
	type AgentResultMessage,
	AgentSessionStatus,
	AgentSessionType,
	type AgentStatusMessage,
	type AgentSystemInitMessage,
	type AgentUserMessage,
	type CyrusAgentSession,
	type CyrusAgentSessionEntry,
	createLogger,
	type IAgentRunner,
	type ILogger,
	type IssueMinimal,
	type RepositoryContext,
	type SerializedCyrusAgentSession,
	type SerializedCyrusAgentSessionEntry,
	type Workspace,
} from "cyrus-core";

import type { Activity, ActivitySignal } from "./activity/Activity.js";
import { ActivityMapper, normalizeTool } from "./activity/ActivityMapper.js";
import type { MapContext } from "./activity/MapContext.js";
import {
	formatPendingWorkThought,
	formatScheduleWakeupResponse,
	tryParseScheduleWakeupInput,
} from "./PendingWorkFormatter.js";
import type { IActivitySink } from "./sinks/index.js";

/**
 * Payload for {@link AgentSessionManagerEvents.sessionComplete}. Raw session facts; EdgeWorker
 * enriches (repositoryId → repo name) before re-emitting on its own bus for the loop adapter.
 */
export interface SessionCompleteEvent {
	sessionId: string;
	/** Internal issue id (issueContext.issueId, falling back to the deprecated issueId). */
	issueId?: string;
	/** Human issue identifier, e.g. `DEV-123` — what the loop's run_id is keyed on. */
	issueIdentifier?: string;
	/** Primary repository id for the session (repositories[0]). */
	repositoryId?: string;
	/** The session's worktree path. */
	worktree: string;
	/** Resolved terminal status. */
	status: AgentSessionStatus;
}

/**
 * Events emitted by AgentSessionManager
 */
export type AgentSessionManagerEvents = {
	/** Fired once when a session reaches a terminal state via the normal (non-user-stop) path. */
	sessionComplete: (payload: SessionCompleteEvent) => void;
};

/**
 * Type-safe event emitter interface for AgentSessionManager
 */
export declare interface AgentSessionManager {
	on<K extends keyof AgentSessionManagerEvents>(
		event: K,
		listener: AgentSessionManagerEvents[K],
	): this;
	emit<K extends keyof AgentSessionManagerEvents>(
		event: K,
		...args: Parameters<AgentSessionManagerEvents[K]>
	): boolean;
}

/**
 * Manages Agent Sessions integration with Claude Code SDK
 * Transforms Claude streaming messages into Agent Session format
 * Handles session lifecycle: create → active → complete/error
 *
 * Single instance shared across all repositories. Activity sinks are
 * registered per-session so each session posts to the correct tracker.
 */
export class AgentSessionManager extends EventEmitter {
	private logger: ILogger;
	private activitySinks: Map<string, IActivitySink> = new Map(); // Per-session activity sinks
	private sessions: Map<string, CyrusAgentSession> = new Map();
	private entries: Map<string, CyrusAgentSessionEntry[]> = new Map(); // Stores a list of session entries per each session by its id
	private activeTasksBySession: Map<string, string> = new Map(); // Maps session ID to active Task tool use ID
	private toolCallsByToolUseId: Map<string, { name: string; input: any }> =
		new Map(); // Track tool calls by their tool_use_id
	private lastAssistantBodyBySession: Map<string, string> = new Map(); // Buffer: last assistant text per session for posting as response on result
	private lastAssistantBodyIsToolInputBySession: Map<string, boolean> =
		new Map(); // Whether the buffered body above is a tool_use input JSON (no trailing assistant text) — guards against posting raw JSON as the "response" (CYPACK-1177)
	private bufferedAssistantEntryBySession: Map<
		string,
		{ message: AgentAssistantMessage; entry: CyrusAgentSessionEntry }
	> = new Map(); // One-behind buffer: holds last assistant message+entry until next message or result
	private taskSubjectsByToolUseId: Map<string, string> = new Map(); // Cache TaskCreate subjects by toolUseId until result arrives with task ID
	private taskSubjectsById: Map<string, string> = new Map(); // Cache task subjects by task ID (e.g., "1" → "Fix login bug")
	private activeStatusActivitiesBySession: Map<string, string> = new Map(); // Maps session ID to active compacting status activity ID
	private stopRequestedSessions: Set<string> = new Set(); // Sessions explicitly stopped by user signal
	// Per-session serialization queue for handleClaudeMessage. The EdgeWorker's
	// onMessage callback is fire-and-forget, so without serialization the async
	// handlers can interleave — causing tool_result to be processed before its
	// matching tool_use registers in toolCallsByToolUseId (seen with parallel
	// deferred tools like ToolSearch, where a tool_use and its tool_result can
	// arrive back-to-back in the same microtask batch).
	private messageProcessingQueues: Map<string, Promise<void>> = new Map();
	private getParentSessionId?: (childSessionId: string) => string | undefined;
	private resumeParentSession?: (
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	) => Promise<void>;
	/**
	 * The single per-tool render table. Pure: given a neutral message + a
	 * MapContext snapshot of this session's state, returns the activities to
	 * post. All the state it reads is written by this manager before each map().
	 */
	private readonly mapper = new ActivityMapper();

	constructor(
		getParentSessionId?: (childSessionId: string) => string | undefined,
		resumeParentSession?: (
			parentSessionId: string,
			prompt: string,
			childSessionId: string,
		) => Promise<void>,
		logger?: ILogger,
	) {
		super();
		this.logger = logger ?? createLogger({ component: "AgentSessionManager" });
		this.getParentSessionId = getParentSessionId;
		this.resumeParentSession = resumeParentSession;
	}

	/**
	 * Register an activity sink for a specific session.
	 * This associates the session with the correct issue tracker for activity posting.
	 */
	setActivitySink(sessionId: string, sink: IActivitySink): void {
		this.activitySinks.set(sessionId, sink);
	}

	/**
	 * Get the activity sink for a session.
	 */
	private getActivitySink(sessionId: string): IActivitySink | undefined {
		return this.activitySinks.get(sessionId);
	}

	/**
	 * Get a session-scoped logger with context (sessionId, platform, issueIdentifier).
	 */
	private sessionLog(sessionId: string): ILogger {
		const session = this.sessions.get(sessionId);
		return this.logger.withContext({
			sessionId,
			platform: session?.issueContext?.trackerId,
			issueIdentifier: session?.issueContext?.issueIdentifier,
		});
	}

	/**
	 * Initialize an agent session from webhook
	 * The session is already created by the platform, we just need to track it
	 *
	 * @param sessionId - Internal session ID
	 * @param issueId - Issue/PR identifier
	 * @param issueMinimal - Minimal issue data
	 * @param workspace - Workspace configuration
	 * @param platform - Source platform ("linear", "github", "slack"). Defaults to "linear".
	 *                   Only "linear" sessions will have activities streamed to Linear.
	 * @param repositories - Repository contexts for the session (defaults to empty array)
	 */
	createCyrusAgentSession(
		sessionId: string,
		issueId: string,
		issueMinimal: IssueMinimal,
		workspace: Workspace,
		platform: "linear" | "github" | "slack" = "linear",
		repositories: RepositoryContext[] = [],
	): CyrusAgentSession {
		const log = this.logger.withContext({
			sessionId,
			platform,
			issueIdentifier: issueMinimal.identifier,
		});
		log.info(`Tracking session for issue ${issueId}`);

		const agentSession: CyrusAgentSession = {
			id: sessionId,
			// Only Linear sessions have a valid external session ID for posting activities
			externalSessionId: platform === "linear" ? sessionId : undefined,
			type: AgentSessionType.CommentThread,
			status: AgentSessionStatus.Active,
			context: AgentSessionType.CommentThread,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			issueContext: {
				trackerId: platform,
				issueId: issueId,
				issueIdentifier: issueMinimal.identifier,
			},
			issueId, // Kept for backwards compatibility
			issue: issueMinimal,
			repositories,
			workspace: workspace,
		};

		// Store locally
		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Create an agent session for chat-style platforms (Slack, etc.) that are
	 * not tied to a specific issue or repository.
	 *
	 * Unlike {@link createCyrusAgentSession}, this does NOT require issue
	 * context — the session lives in a standalone workspace with no issue
	 * tracker linkage.
	 *
	 * @param repositories - Repository contexts for the session (defaults to empty array for chatbot sessions)
	 */
	createChatSession(
		sessionId: string,
		workspace: Workspace,
		platform: string,
		repositories: RepositoryContext[] = [],
	): CyrusAgentSession {
		const log = this.logger.withContext({ sessionId, platform });
		log.info("Creating chat session");

		const agentSession: CyrusAgentSession = {
			id: sessionId,
			type: AgentSessionType.CommentThread,
			status: AgentSessionStatus.Active,
			context: AgentSessionType.CommentThread,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			repositories,
			workspace,
		};

		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Update Agent Session with session ID from system initialization.
	 * Records the session id against the runner that produced it (Claude or
	 * Cursor) so resumes stick with the same harness.
	 */
	updateAgentSessionWithRunnerSessionId(
		sessionId: string,
		initMessage: AgentSystemInitMessage,
	): void {
		const linearSession = this.sessions.get(sessionId);
		if (!linearSession) {
			const log = this.sessionLog(sessionId);
			log.warn(`No session found`);
			return;
		}

		if (linearSession.agentRunner?.provider === "cursor") {
			linearSession.cursorSessionId = initMessage.sessionId;
		} else {
			linearSession.claudeSessionId = initMessage.sessionId;
		}

		linearSession.updatedAt = Date.now();
		linearSession.metadata = {
			...linearSession.metadata, // Preserve existing metadata
			model: initMessage.model,
			tools: initMessage.tools,
			permissionMode: initMessage.permissionMode,
			apiKeySource: initMessage.apiKeySource,
		};
	}

	/**
	 * Create a session entry from user/assistant message (without syncing to Linear)
	 */
	private async createSessionEntry(
		sessionId: string,
		message: AgentUserMessage | AgentAssistantMessage,
	): Promise<CyrusAgentSessionEntry> {
		// Extract tool info if this is an assistant message
		const toolInfo =
			message.type === "assistant" ? this.extractToolInfo(message) : null;
		// Extract tool_use_id and error status if this is a user message with tool_result
		const toolResultInfo =
			message.type === "user" ? this.extractToolResultInfo(message) : null;
		// Extract provider error from assistant messages (e.g., rate_limit,
		// billing_error). The neutral AgentAssistantMessage carries the optional
		// `error?: SDKAssistantMessageError` tag through from the runner.
		const sdkError = message.type === "assistant" ? message.error : undefined;

		// Record the runner session id against the runner that produced it.
		const runner = this.sessions.get(sessionId)?.agentRunner;

		const sessionEntry: CyrusAgentSessionEntry = {
			...(runner?.provider === "cursor"
				? { cursorSessionId: message.sessionId }
				: { claudeSessionId: message.sessionId }),
			type: message.type,
			content: this.extractContent(message),
			metadata: {
				timestamp: Date.now(),
				parentToolUseId: message.parentToolUseId || undefined,
				...(toolInfo && {
					toolUseId: toolInfo.id,
					toolName: toolInfo.name,
					toolInput: toolInfo.input,
				}),
				...(toolResultInfo && {
					toolUseId: toolResultInfo.toolUseId,
					toolResultError: toolResultInfo.isError,
				}),
				...(sdkError && { sdkError }),
			},
		};

		// DON'T store locally yet - wait until we actually post to Linear
		return sessionEntry;
	}

	/**
	 * Complete a session from Claude result message.
	 * Posts the final result to the issue tracker and handles child session completion.
	 */
	async completeSession(
		sessionId: string,
		resultMessage: AgentResultMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) {
			const log = this.sessionLog(sessionId);
			log.error(`No session found`);
			return;
		}

		const log = this.sessionLog(sessionId);

		// Clear any active Task when session completes
		this.activeTasksBySession.delete(sessionId);

		const wasStopRequested = this.consumeStopRequest(sessionId);
		const status = wasStopRequested
			? AgentSessionStatus.Error
			: resultMessage.subtype === "success"
				? AgentSessionStatus.Complete
				: AgentSessionStatus.Error;

		// Update session status and metadata
		await this.updateSessionStatus(sessionId, status, {
			totalCostUsd: resultMessage.usage.costUsd,
			usage: resultMessage.usage,
		});

		if (wasStopRequested) {
			log.info(`Session was stopped by user`);
			return;
		}

		// Post final result to issue tracker
		await this.addResultEntry(sessionId, resultMessage);

		// When the turn ended with work still scheduled or in flight
		// (ScheduleWakeup/cron timers, backgrounded tasks), the runner holds
		// its session open and the wakeup will stream new messages in later.
		// Post a thought AFTER the response so Linear's agent panel returns
		// to its working state and the user can see what the session is
		// waiting on.
		if (resultMessage.subtype === "success") {
			const pendingWork = this.getRunnerPendingWork(sessionId);
			if (pendingWork) {
				const thoughtBody = formatPendingWorkThought(pendingWork);
				if (thoughtBody) {
					await this.createThoughtActivity(sessionId, thoughtBody);
					log.info(
						`Posted pending-work thought (${pendingWork.sessionCrons.length} crons, ${pendingWork.backgroundTasks.length} background tasks)`,
					);
				}
			}
		}

		// Handle child session completion
		const parentSessionId = this.getParentSessionId?.(sessionId);
		if (parentSessionId && this.resumeParentSession) {
			await this.handleChildSessionCompletion(sessionId, resultMessage);
		}

		log.info(`Session completed (subtype: ${resultMessage.subtype})`);
	}

	/**
	 * Pending work (scheduled wakeups/crons, in-flight background tasks) for
	 * the session's runner, or null when the runner doesn't support pending
	 * work reporting or nothing is pending.
	 */
	private getRunnerPendingWork(sessionId: string): AgentPendingWork | null {
		const runner = this.sessions.get(sessionId)?.agentRunner;
		if (!runner?.getPendingWork) return null;
		const pendingWork = runner.getPendingWork();
		return pendingWork.sessionCrons.length > 0 ||
			pendingWork.backgroundTasks.length > 0
			? pendingWork
			: null;
	}

	private consumeStopRequest(linearAgentActivitySessionId: string): boolean {
		if (!this.stopRequestedSessions.has(linearAgentActivitySessionId)) {
			return false;
		}

		this.stopRequestedSessions.delete(linearAgentActivitySessionId);
		return true;
	}

	requestSessionStop(linearAgentActivitySessionId: string): void {
		this.stopRequestedSessions.add(linearAgentActivitySessionId);
	}

	/**
	 * Handle child session completion and resume parent
	 */
	private async handleChildSessionCompletion(
		sessionId: string,
		resultMessage: AgentResultMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		if (!this.getParentSessionId || !this.resumeParentSession) {
			return;
		}

		const parentAgentSessionId = this.getParentSessionId(sessionId);

		if (!parentAgentSessionId) {
			log.error(`No parent session ID found for child session`);
			return;
		}

		log.info(
			`Child session completed, resuming parent ${parentAgentSessionId}`,
		);

		try {
			const childResult =
				"result" in resultMessage
					? resultMessage.result
					: "No result available";
			const promptToParent = `Child agent session ${sessionId} completed with result:\n\n${childResult}`;

			await this.resumeParentSession(
				parentAgentSessionId,
				promptToParent,
				sessionId,
			);

			log.info(`Successfully resumed parent session ${parentAgentSessionId}`);
		} catch (error) {
			log.error(`Failed to resume parent session:`, error);
		}
	}

	/**
	 * Handle streaming Claude messages and route to appropriate methods.
	 *
	 * Serializes processing per session so concurrent onMessage callbacks from
	 * the runner (which is fire-and-forget) do not interleave their async work.
	 * Without this serialization, a tool_result message could run its handler
	 * ahead of the matching tool_use registration in toolCallsByToolUseId,
	 * producing a fallback action="Tool" activity in Linear (seen with parallel
	 * deferred tools like ToolSearch).
	 */
	async handleClaudeMessage(
		sessionId: string,
		message: AgentMessage,
	): Promise<void> {
		const prev =
			this.messageProcessingQueues.get(sessionId) ?? Promise.resolve();
		const next = prev.then(() => this.processClaudeMessage(sessionId, message));
		// Swallow errors in the chained promise so one failure does not block
		// future messages for this session. The concrete handler already logs
		// errors internally.
		this.messageProcessingQueues.set(
			sessionId,
			next.catch(() => undefined),
		);
		return next;
	}

	/**
	 * Actual message dispatch. Invoked only via the per-session queue in
	 * handleClaudeMessage so at most one instance runs for a given session.
	 */
	private async processClaudeMessage(
		sessionId: string,
		message: AgentMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			switch (message.type) {
				case "system":
					if (message.subtype === "init") {
						this.updateAgentSessionWithRunnerSessionId(sessionId, message);

						// Post model notification
						if (message.model) {
							await this.postModelNotificationThought(sessionId, message.model);
						}
					} else if (message.subtype === "status") {
						// Handle status updates (compacting, etc.)
						await this.handleStatusMessage(sessionId, message);
					}
					break;

				case "user": {
					const userEntry = await this.createSessionEntry(sessionId, message);
					await this.renderAndPost(sessionId, message, userEntry);
					break;
				}

				case "assistant": {
					const assistantEntry = await this.createSessionEntry(
						sessionId,
						message,
					);
					// Buffer the text content so addResultEntry can post it as the response.
					// Track whether this body is a tool_use input (JSON) rather than real
					// assistant prose, so addResultEntry never posts raw tool JSON as the
					// final "response" when a turn ends on a tool call (CYPACK-1177).
					if (assistantEntry.content) {
						this.lastAssistantBodyBySession.set(
							sessionId,
							assistantEntry.content,
						);
						this.lastAssistantBodyIsToolInputBySession.set(
							sessionId,
							!!assistantEntry.metadata?.toolUseId,
						);
					}
					if (assistantEntry.metadata?.toolUseId) {
						// Tool-use message: flush any buffered text first (preserves ordering),
						// then post immediately for real-time "in progress" display
						await this.flushBufferedAssistant(sessionId);
						await this.renderAndPost(sessionId, message, assistantEntry);
					} else {
						// Text-only message: buffer it so the LAST one can be posted as "response"
						// Flush any previous buffered text first (posts as thought)
						await this.flushBufferedAssistant(sessionId);
						// Skip empty/whitespace-only text turns — otherwise they post as
						// blank thoughts in Linear, showing up as an extra blank line
						// between activities (e.g. between "Using model: ..." and the
						// first real assistant turn).
						if (assistantEntry.content?.trim()) {
							this.bufferedAssistantEntryBySession.set(sessionId, {
								message,
								entry: assistantEntry,
							});
						}
					}
					break;
				}

				case "result":
					// Result arrived: discard buffered entry (addResultEntry uses lastAssistantBodyBySession
					// to post the content as a response activity)
					this.bufferedAssistantEntryBySession.delete(sessionId);
					await this.completeSession(sessionId, message);
					break;

				case "rate_limit":
					this.handleRateLimitEvent(sessionId, message);
					break;

				default:
					log.warn(
						`Unknown message type: ${(message as { type: string }).type}`,
					);
			}
		} catch (error) {
			log.error(`Error handling message:`, error);
			// Mark session as error state
			await this.updateSessionStatus(sessionId, AgentSessionStatus.Error);
		}
	}

	/**
	 * Flush the buffered assistant entry as thought/action (non-result flush).
	 * Called when a new message arrives before result, to post the previous
	 * assistant message as a thought/action activity.
	 */
	private async flushBufferedAssistant(sessionId: string): Promise<void> {
		const buffered = this.bufferedAssistantEntryBySession.get(sessionId);
		if (!buffered) return;
		this.bufferedAssistantEntryBySession.delete(sessionId);
		// Defensive guard: never post a blank thought — it would appear as an
		// empty line between real activities in Linear.
		if (!buffered.entry.content?.trim()) return;
		await this.renderAndPost(sessionId, buffered.message, buffered.entry);
	}

	/**
	 * Handle rate limit events from Claude runners
	 */
	private handleRateLimitEvent(
		sessionId: string,
		message: AgentRateLimitMessage,
	): void {
		const log = this.sessionLog(sessionId);
		const info = message.info;

		if (info.status === "rejected") {
			const resetsAt = info.resetsAt
				? new Date(info.resetsAt * 1000).toISOString()
				: "unknown";
			log.warn(
				`Rate limited (${info.rateLimitType ?? "unknown"}), resets at ${resetsAt}`,
			);
		} else if (info.status === "allowed_warning") {
			log.info(
				`Rate limit warning: ${Math.round((info.utilization ?? 0) * 100)}% utilization (${info.rateLimitType ?? "unknown"})`,
			);
		}
		// "allowed" status is a no-op — fires frequently and provides no actionable information
	}

	/**
	 * Mark a session active again after a message is appended to its live stream.
	 *
	 * A completed turn sets the session to `Complete` even when the runner stays
	 * warm and idle. Without this, an appended follow-up would keep working under
	 * a `Complete` session, which `getActiveSessionsByIssueId` consumers skip.
	 */
	async markSessionActive(sessionId: string): Promise<void> {
		await this.updateSessionStatus(sessionId, AgentSessionStatus.Active);
	}

	/**
	 * Update session status and metadata
	 */
	private async updateSessionStatus(
		sessionId: string,
		status: AgentSessionStatus,
		additionalMetadata?: Partial<CyrusAgentSession["metadata"]>,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		session.status = status;
		session.updatedAt = Date.now();

		if (additionalMetadata) {
			session.metadata = { ...session.metadata, ...additionalMetadata };
		}

		this.sessions.set(sessionId, session);
	}

	/**
	 * Add result entry from result message
	 */
	private async addResultEntry(
		sessionId: string,
		resultMessage: AgentResultMessage,
	): Promise<void> {
		// For error results, content may be in errors[] rather than result.
		const resultText =
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result.trim()
				: "";

		// For success results, prefer the buffered last assistant message
		// (structured content) over result.result (a plain-text duplicate). But
		// when a turn ENDS on a tool call with no trailing assistant text, that
		// buffered body is the tool's raw input JSON — which must never be posted
		// as the Linear "response" (CYPACK-1177 / CYHOST-905: sessions showed a
		// "Finished" entry whose body was raw ScheduleWakeup / background-Bash
		// JSON).
		const bufferedAssistant = this.lastAssistantBodyBySession.get(sessionId);
		const bufferedIsToolInput =
			this.lastAssistantBodyIsToolInputBySession.get(sessionId) ?? false;
		this.lastAssistantBodyBySession.delete(sessionId);
		this.lastAssistantBodyIsToolInputBySession.delete(sessionId);

		let content: string;
		if (resultMessage.isError) {
			content = (
				"errors" in resultMessage &&
				Array.isArray(resultMessage.errors) &&
				resultMessage.errors.length > 0
					? resultMessage.errors.join("\n")
					: resultText
			).trim();
		} else if (bufferedIsToolInput) {
			// Turn ended on a tool call. Render a friendly response for a
			// ScheduleWakeup (gated on the runner actually reporting a pending
			// cron so a finished session is never rewritten); otherwise fall back
			// to the SDK's result text and, failing that, post nothing — the raw
			// tool JSON is never surfaced. Any pending work is declared by the
			// separate "Standing by" thought, so an empty response here is fine.
			const pendingWork = this.getRunnerPendingWork(sessionId);
			const wakeupInput =
				pendingWork && pendingWork.sessionCrons.length > 0
					? tryParseScheduleWakeupInput(bufferedAssistant ?? "")
					: null;
			content = wakeupInput
				? formatScheduleWakeupResponse(wakeupInput)
				: resultText;
		} else {
			content = (bufferedAssistant ?? resultText).trim();
		}

		// Never post an empty/blank "response" activity — that renders as a
		// bare "Finished" with no body. Skip it entirely (the timeline already
		// shows the trailing action, and pending work has its own thought).
		if (!content.trim()) {
			return;
		}

		const runner = this.sessions.get(sessionId)?.agentRunner;
		const resultEntry: CyrusAgentSessionEntry = {
			...(runner?.provider === "cursor"
				? { cursorSessionId: resultMessage.sessionId }
				: { claudeSessionId: resultMessage.sessionId }),
			type: "result",
			content,
			metadata: {
				timestamp: Date.now(),
				durationMs: resultMessage.durationMs,
				isError: resultMessage.isError,
			},
		};

		// Store the entry, then post it as a response (or error) through the sink.
		this.storeEntry(sessionId, resultEntry);
		const activity: Activity = resultMessage.isError
			? { type: "error", body: content }
			: { type: "response", body: content };
		const activityId = await this.postToSink(sessionId, activity, "result");
		if (activityId) {
			resultEntry.linearAgentActivityId = activityId;
			const log = this.sessionLog(sessionId);
			log.info(`Result message emitted to Linear (activity ${activityId})`);
		}
	}

	/**
	 * Extract flattened content from a neutral agent message. The runner's
	 * projection layer already flattened tool_result blocks to strings (incl.
	 * the ToolSearch `tool_reference` names), so this just joins the block
	 * texts: text/thinking surface their prose, tool_use serializes its input,
	 * tool_result emits its already-flattened content.
	 */
	private extractContent(
		message: AgentUserMessage | AgentAssistantMessage,
	): string {
		return message.content
			.map((block) => {
				if (block.type === "text") {
					return block.text;
				}
				if (block.type === "thinking") {
					// Surface reasoning as text instead of dropping it (Cursor
					// thinking previously never reached the timeline).
					return block.thinking;
				}
				if (block.type === "tool_use") {
					// For tool use blocks, return the input as JSON string
					return JSON.stringify(block.input, null, 2);
				}
				if (block.type === "tool_result") {
					// Already flattened to a string by the runner projection.
					return block.content;
				}
				return "";
			})
			.filter(Boolean)
			.join("\n");
	}

	/**
	 * Extract tool information from a neutral assistant message
	 */
	private extractToolInfo(
		message: AgentAssistantMessage,
	): { id: string; name: string; input: any } | null {
		const toolUse = message.content.find((block) => block.type === "tool_use");
		if (toolUse && toolUse.type === "tool_use") {
			return {
				id: toolUse.id,
				name: toolUse.name,
				input: toolUse.input,
			};
		}
		return null;
	}

	/**
	 * Extract tool_use_id and error status from a neutral user message
	 * containing a tool_result block
	 */
	private extractToolResultInfo(
		message: AgentUserMessage,
	): { toolUseId: string; isError: boolean } | null {
		const toolResult = message.content.find(
			(block) => block.type === "tool_result",
		);
		if (toolResult && toolResult.type === "tool_result") {
			return {
				toolUseId: toolResult.toolUseId,
				isError: toolResult.isError,
			};
		}
		return null;
	}

	/**
	 * Store a session entry locally (timeline history / serialization).
	 */
	private storeEntry(sessionId: string, entry: CyrusAgentSessionEntry): void {
		const entries = this.entries.get(sessionId) || [];
		entries.push(entry);
		this.entries.set(sessionId, entries);
	}

	/**
	 * Render a neutral message into activities via the pure ActivityMapper and
	 * post them through the session's sink.
	 *
	 * The manager owns all the mutable state the mapper reads: it performs the
	 * tool-call registration / active-Task / subject-cache writes the old switch
	 * did inline (BEFORE snapshotting MapContext), snapshots the context, calls
	 * the pure mapper, posts each activity, then performs the deferred cleanup
	 * writes (tool-call delete, active-Task clear) AFTER the map.
	 */
	private async renderAndPost(
		sessionId: string,
		message: AgentUserMessage | AgentAssistantMessage,
		entry: CyrusAgentSessionEntry,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				log.warn(`No session found`);
				return;
			}

			// Store entry locally first (matches previous behavior: entries are
			// recorded when they are posted, not when buffered).
			this.storeEntry(sessionId, entry);

			// State writes that must land BEFORE the MapContext snapshot.
			this.applyPreMapMutations(sessionId, message);

			const ctx = this.buildMapContext(sessionId);
			const activities = this.mapper.map(message, ctx);

			// Deferred cleanup writes (must run AFTER the map read the snapshot).
			this.applyPostMapMutations(sessionId, message);

			for (const activity of activities) {
				const activityId = await this.postToSink(
					sessionId,
					activity,
					activity.type,
				);
				// Correlate the first posted activity id back onto the stored entry.
				if (activityId && !entry.linearAgentActivityId) {
					entry.linearAgentActivityId = activityId;
					log.debug(`Created ${activity.type} activity ${activityId}`);
				}
			}
		} catch (error) {
			log.error(`Failed to render/post message:`, error);
		}
	}

	/**
	 * Build a read-only MapContext snapshot of this session's current state.
	 */
	private buildMapContext(sessionId: string): MapContext {
		const session = this.sessions.get(sessionId);
		const provider = session?.agentRunner?.provider ?? "claude";
		return {
			provider,
			toolCall: (toolUseId) => this.toolCallsByToolUseId.get(toolUseId),
			activeTaskUseId: this.activeTasksBySession.get(sessionId),
			taskSubjectById: (taskId) => this.taskSubjectsById.get(taskId),
			workingDirectory: session?.workspace?.path,
		};
	}

	/**
	 * State writes the old per-tool switch performed at tool_use / tool_result
	 * time. These must run BEFORE the MapContext snapshot so the pure mapper
	 * observes them (e.g. TaskUpdate/TaskGet subject enrichment).
	 */
	private applyPreMapMutations(
		sessionId: string,
		message: AgentUserMessage | AgentAssistantMessage,
	): void {
		const session = this.sessions.get(sessionId);
		const provider = session?.agentRunner?.provider ?? "claude";
		const workingDirectory = session?.workspace?.path;

		if (message.type === "assistant") {
			const toolUse = message.content.find((b) => b.type === "tool_use");
			if (!toolUse || toolUse.type !== "tool_use") return;

			const { name: baseName, input } = normalizeTool(
				provider,
				toolUse.name,
				toolUse.input,
				workingDirectory,
			);

			// Register the tool call (with subtask arrow prefix) for its future
			// tool_result. The stored name is canonical so the result render needs
			// no re-normalization.
			let storedName = baseName;
			if (message.parentToolUseId) {
				const activeTaskId = this.activeTasksBySession.get(sessionId);
				if (activeTaskId === message.parentToolUseId) {
					storedName = `↪ ${baseName}`;
				}
			}
			this.toolCallsByToolUseId.set(toolUse.id, { name: storedName, input });

			// Track the active Task so its children get the arrow prefix and its
			// result renders as "Task Completed".
			if (baseName === "Task") {
				this.activeTasksBySession.set(sessionId, toolUse.id);
			}

			// Cache TaskCreate subject by tool_use id until the result carries the id.
			if (
				baseName === "TaskCreate" &&
				input &&
				typeof input === "object" &&
				typeof (input as { subject?: unknown }).subject === "string"
			) {
				this.taskSubjectsByToolUseId.set(
					toolUse.id,
					(input as { subject: string }).subject,
				);
			}
			return;
		}

		// user tool_result
		const toolResult = message.content.find((b) => b.type === "tool_result");
		if (!toolResult || toolResult.type !== "tool_result") return;

		const toolUseId = toolResult.toolUseId;
		const activeTaskId = this.activeTasksBySession.get(sessionId);
		if (activeTaskId === toolUseId) {
			// Active-Task completion clears in the post-map phase.
			return;
		}

		const originalTool = this.toolCallsByToolUseId.get(toolUseId);
		const toolName = originalTool?.name || "Tool";
		const baseToolName = toolName.replace("↪ ", "");
		const resultContent = toolResult.content;
		const toolInput =
			originalTool?.input && typeof originalTool.input === "object"
				? (originalTool.input as Record<string, unknown>)
				: {};

		// TaskCreate result: map the parsed task id to its cached subject.
		if (baseToolName === "TaskCreate") {
			const cachedSubject = this.taskSubjectsByToolUseId.get(toolUseId);
			if (cachedSubject) {
				const taskIdMatch = resultContent?.match(/Task #(\d+)/);
				if (taskIdMatch?.[1]) {
					this.taskSubjectsById.set(taskIdMatch[1], cachedSubject);
				}
				this.taskSubjectsByToolUseId.delete(toolUseId);
			}
		}

		// TaskUpdate/TaskGet result: cache the subject parsed from the result so
		// future lookups (and the mapper's enrichment) can use it.
		if (
			(baseToolName === "TaskUpdate" || baseToolName === "TaskGet") &&
			!toolInput.subject &&
			resultContent
		) {
			const taskId =
				typeof toolInput.taskId === "string" ? toolInput.taskId : "";
			if (taskId && !this.taskSubjectsById.has(taskId)) {
				const subjectMatch = resultContent.match(/^Subject:\s*(.+)$/m);
				if (subjectMatch?.[1]) {
					this.taskSubjectsById.set(taskId, subjectMatch[1].trim());
				}
			}
		}
	}

	/**
	 * Deferred cleanup writes that must run AFTER the mapper read the snapshot:
	 * clearing the active Task on its completion and removing a consumed tool
	 * call from the lookup map.
	 */
	private applyPostMapMutations(
		sessionId: string,
		message: AgentUserMessage | AgentAssistantMessage,
	): void {
		if (message.type !== "user") return;
		const toolResult = message.content.find((b) => b.type === "tool_result");
		if (!toolResult || toolResult.type !== "tool_result") return;

		const toolUseId = toolResult.toolUseId;
		const activeTaskId = this.activeTasksBySession.get(sessionId);
		if (activeTaskId === toolUseId) {
			this.activeTasksBySession.delete(sessionId);
			return;
		}
		this.toolCallsByToolUseId.delete(toolUseId);
	}

	/**
	 * Guarded post to the session's activity sink. Returns the created activity
	 * id (when the tracker reports one), or null when skipped/failed. This is the
	 * single funnel every activity-post path in this manager collapses onto.
	 */
	private async postToSink(
		sessionId: string,
		activity: Activity,
		label: string,
	): Promise<string | null> {
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);

		if (!session?.externalSessionId) {
			log.debug(
				`Skipping ${label} - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return null;
		}

		const activitySink = this.getActivitySink(sessionId);
		if (!activitySink) {
			log.debug(`Skipping ${label} - no activity sink registered for session`);
			return null;
		}

		try {
			const result = await activitySink.post(
				session.externalSessionId,
				activity,
			);
			return result.activityId ?? null;
		} catch (error) {
			log.error(`Error creating ${label}:`, error);
			return null;
		}
	}

	/**
	 * Get session by ID
	 */
	getSession(sessionId: string): CyrusAgentSession | undefined {
		return this.sessions.get(sessionId);
	}

	/**
	 * Get session entries by session ID
	 */
	getSessionEntries(sessionId: string): CyrusAgentSessionEntry[] {
		return this.entries.get(sessionId) || [];
	}

	/**
	 * Get all active sessions
	 */
	getActiveSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => session.status === AgentSessionStatus.Active,
		);
	}

	/**
	 * Add or update agent runner for a session
	 */
	addAgentRunner(sessionId: string, agentRunner: IAgentRunner): void {
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);
		if (!session) {
			log.warn(`No session found`);
			return;
		}

		session.agentRunner = agentRunner;
		session.updatedAt = Date.now();
		log.debug(`Added agent runner`);
	}

	/**
	 *  Get all agent runners
	 */
	getAllAgentRunners(): IAgentRunner[] {
		return Array.from(this.sessions.values())
			.map((session) => session.agentRunner)
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Resolve the issue ID from a session, checking issueContext first then deprecated issueId.
	 */
	private getSessionIssueId(session: CyrusAgentSession): string | undefined {
		return session.issueContext?.issueId ?? session.issueId;
	}

	/**
	 * Get all agent runners for a specific issue
	 */
	getAgentRunnersForIssue(issueId: string): IAgentRunner[] {
		return Array.from(this.sessions.values())
			.filter((session) => this.getSessionIssueId(session) === issueId)
			.map((session) => session.agentRunner)
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Get sessions by issue ID
	 */
	getSessionsByIssueId(issueId: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) => this.getSessionIssueId(session) === issueId,
		);
	}

	/**
	 * Get active sessions by issue ID
	 */
	getActiveSessionsByIssueId(issueId: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				this.getSessionIssueId(session) === issueId &&
				session.status === AgentSessionStatus.Active,
		);
	}

	/**
	 * Get active sessions where the issue's branch name matches the given branch.
	 * Useful for detecting when multiple sessions share the same worktree.
	 */
	getActiveSessionsByBranchName(branchName: string): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				session.status === AgentSessionStatus.Active &&
				session.issue?.branchName === branchName,
		);
	}

	/**
	 * Get active sessions tracking a given base branch for a specific repository.
	 * Used by GitHub push webhook handling to notify agents when their base branch receives new commits.
	 */
	getSessionsByBaseBranch(
		baseBranchName: string,
		repositoryId: string,
	): CyrusAgentSession[] {
		return Array.from(this.sessions.values()).filter(
			(session) =>
				session.status === AgentSessionStatus.Active &&
				session.repositories.some(
					(r) =>
						r.repositoryId === repositoryId &&
						r.baseBranchName === baseBranchName,
				),
		);
	}

	/**
	 * Find an active multi-repo session that includes the given repository.
	 * Used by GitHub webhook handling to resolve the correct sub-worktree
	 * when a @ mention targets a specific repo within a multi-repo workspace.
	 */
	getActiveMultiRepoSessionForRepository(
		repositoryId: string,
	): CyrusAgentSession | null {
		for (const session of this.sessions.values()) {
			if (session.status !== AgentSessionStatus.Active) continue;
			if (!session.workspace.repoPaths) continue; // not multi-repo
			const matchesRepo = session.repositories.some(
				(r) => r.repositoryId === repositoryId,
			);
			if (matchesRepo) {
				return session;
			}
		}
		return null;
	}

	/**
	 * Get all sessions
	 */
	getAllSessions(): CyrusAgentSession[] {
		return Array.from(this.sessions.values());
	}

	/**
	 * Get agent runner for a specific session
	 */
	getAgentRunner(sessionId: string): IAgentRunner | undefined {
		const session = this.sessions.get(sessionId);
		return session?.agentRunner;
	}

	/**
	 * Check if an agent runner exists for a session
	 */
	hasAgentRunner(sessionId: string): boolean {
		const session = this.sessions.get(sessionId);
		return session?.agentRunner !== undefined;
	}

	/**
	 * Post an activity to the activity sink for a session.
	 * Consolidates session lookup, externalSessionId guard, try/catch, and logging.
	 *
	 * @returns The activity ID when resolved, `null` otherwise.
	 */
	private async postActivity(
		sessionId: string,
		input: {
			content: any;
			ephemeral?: boolean;
			signal?: ActivitySignal;
			signalMetadata?: Record<string, unknown>;
		},
		label: string,
	): Promise<string | null> {
		const activity: Activity = {
			...input.content,
			...(input.ephemeral !== undefined && { ephemeral: input.ephemeral }),
			...(input.signal && { signal: input.signal }),
			...(input.signalMetadata && { signalMetadata: input.signalMetadata }),
		};
		return this.postToSink(sessionId, activity, label);
	}

	/**
	 * Create a thought activity
	 */
	async createThoughtActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "thought", body } },
			"thought",
		);
	}

	/**
	 * Create an action activity
	 */
	async createActionActivity(
		sessionId: string,
		action: string,
		parameter: string,
		result?: string,
	): Promise<void> {
		const content: any = { type: "action", action, parameter };
		if (result !== undefined) {
			content.result = result;
		}
		await this.postActivity(sessionId, { content }, "action");
	}

	/**
	 * Create a response activity
	 */
	async createResponseActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "response", body } },
			"response",
		);
	}

	/**
	 * Create an error activity
	 */
	async createErrorActivity(sessionId: string, body: string): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "error", body } },
			"error",
		);
	}

	/**
	 * Create an elicitation activity
	 */
	async createElicitationActivity(
		sessionId: string,
		body: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "elicitation", body } },
			"elicitation",
		);
	}

	/**
	 * Create an approval elicitation activity with auth signal
	 */
	async createApprovalElicitation(
		sessionId: string,
		body: string,
		approvalUrl: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{
				content: { type: "elicitation", body },
				signal: "auth",
				signalMetadata: { url: approvalUrl },
			},
			"approval elicitation",
		);
	}

	/**
	 * Mark a session as failed after an unrecoverable runner crash.
	 *
	 * The normal terminal path (`completeSession`) only runs when the SDK
	 * emits a `result` message. When the subprocess dies without one — a
	 * crash, a non-143 exit, a stream that errors — no result ever arrives,
	 * so without this the session stays `Active` with no runner and the
	 * Linear issue sits "In Progress" forever with no user-visible signal.
	 *
	 * Posts an `error` activity to the issue tracker so the user knows the
	 * session died and can retry, then transitions the session to `Error`.
	 * Idempotent: a no-op when the session is unknown or already terminal,
	 * so it's safe to call from a crash handler that may race `completeSession`.
	 */
	async failSession(sessionId: string, body: string): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session) return;

		// Don't clobber a session that already reached a terminal state (e.g.
		// a result message landed just before the error event fired).
		if (
			session.status === AgentSessionStatus.Complete ||
			session.status === AgentSessionStatus.Error
		) {
			return;
		}

		const log = this.sessionLog(sessionId);
		this.activeTasksBySession.delete(sessionId);
		await this.updateSessionStatus(sessionId, AgentSessionStatus.Error);
		try {
			await this.createErrorActivity(sessionId, body);
		} catch (error) {
			log.error("Failed to post crash error activity", error);
		}
		log.info("Session marked failed after runner crash");
	}

	/**
	 * Remove a session and all associated tracking state.
	 * Use for immediate cleanup when a session is permanently done
	 * (e.g., issue moved to terminal state).
	 */
	removeSession(sessionId: string): void {
		const log = this.sessionLog(sessionId);
		this.sessions.delete(sessionId);
		this.entries.delete(sessionId);
		this.activitySinks.delete(sessionId);
		this.activeTasksBySession.delete(sessionId);
		this.activeStatusActivitiesBySession.delete(sessionId);
		this.stopRequestedSessions.delete(sessionId);
		this.lastAssistantBodyBySession.delete(sessionId);
		this.bufferedAssistantEntryBySession.delete(sessionId);
		this.messageProcessingQueues.delete(sessionId);
		log.debug("Removed session");
	}

	/**
	 * Clear completed sessions older than specified time
	 */
	cleanup(olderThanMs: number = 24 * 60 * 60 * 1000): void {
		const cutoff = Date.now() - olderThanMs;

		for (const [sessionId, session] of this.sessions.entries()) {
			if (
				(session.status === "complete" || session.status === "error") &&
				session.updatedAt < cutoff
			) {
				const log = this.sessionLog(sessionId);
				this.sessions.delete(sessionId);
				this.entries.delete(sessionId);
				log.debug(`Cleaned up session`);
			}
		}
	}

	/**
	 * Serialize Agent Session state for persistence
	 */
	serializeState(): {
		sessions: Record<string, SerializedCyrusAgentSession>;
		entries: Record<string, SerializedCyrusAgentSessionEntry[]>;
	} {
		const sessions: Record<string, SerializedCyrusAgentSession> = {};
		const entries: Record<string, SerializedCyrusAgentSessionEntry[]> = {};

		// Serialize sessions
		for (const [sessionId, session] of this.sessions.entries()) {
			// Exclude agentRunner from serialization as it's not serializable
			const { agentRunner: _agentRunner, ...serializableSession } = session;
			sessions[sessionId] = serializableSession;
		}

		// Serialize entries
		for (const [sessionId, sessionEntries] of this.entries.entries()) {
			entries[sessionId] = sessionEntries.map((entry) => ({
				...entry,
			}));
		}

		return { sessions, entries };
	}

	/**
	 * Restore Agent Session state from serialized data
	 */
	restoreState(
		serializedSessions: Record<string, SerializedCyrusAgentSession>,
		serializedEntries: Record<string, SerializedCyrusAgentSessionEntry[]>,
	): void {
		// Clear existing state
		this.sessions.clear();
		this.entries.clear();

		// Restore sessions (migrate old sessions without repositories field)
		for (const [sessionId, sessionData] of Object.entries(serializedSessions)) {
			const session: CyrusAgentSession = {
				...sessionData,
				repositories: sessionData.repositories ?? [],
			};
			this.sessions.set(sessionId, session);
		}

		// Restore entries
		for (const [sessionId, entriesData] of Object.entries(serializedEntries)) {
			const sessionEntries: CyrusAgentSessionEntry[] = entriesData.map(
				(entryData) => ({
					...entryData,
				}),
			);
			this.entries.set(sessionId, sessionEntries);
		}

		this.logger.debug(
			`Restored ${this.sessions.size} sessions, ${Object.keys(serializedEntries).length} entry collections`,
		);
	}

	/**
	 * Reconcile sessions that were mid-flight when the process died.
	 *
	 * Runners live only in memory and are never serialized, so every session
	 * restored from disk comes back with no `agentRunner`. A session persisted
	 * as `Active` (working) or `AwaitingInput` (waiting on a question) is
	 * therefore a zombie: it still claims to be live, `getActiveSessions()`
	 * counts it, but its runner is gone — a stop signal is a no-op and the
	 * Linear issue shows a working indicator that never resolves.
	 *
	 * Transition those sessions to `Error` (interrupted) so local state matches
	 * reality. The `!agentRunner` guard makes this safe to call at any time:
	 * a session that already has a live runner is left untouched, so calling
	 * this after startup (once runners exist) can never kill a running session.
	 *
	 * Returns the ids of the sessions that were reconciled so the caller can
	 * notify the user (e.g. post an "interrupted, comment to resume" activity).
	 */
	markInterruptedSessions(): string[] {
		const interrupted: string[] = [];
		for (const [sessionId, session] of this.sessions.entries()) {
			const isNonTerminal =
				session.status === AgentSessionStatus.Active ||
				session.status === AgentSessionStatus.AwaitingInput;
			if (isNonTerminal && !session.agentRunner) {
				session.status = AgentSessionStatus.Error;
				session.updatedAt = Date.now();
				interrupted.push(sessionId);
			}
		}
		if (interrupted.length > 0) {
			this.logger.info(
				`Reconciled ${interrupted.length} interrupted session(s) with no runner to Error`,
			);
		}
		return interrupted;
	}

	/**
	 * Post a thought about the model being used
	 */
	private async postModelNotificationThought(
		sessionId: string,
		model: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{ content: { type: "thought", body: `Using model: ${model}` } },
			"model notification",
		);
	}

	/**
	 * Post an ephemeral "Analyzing your request..." thought and return the activity ID
	 */
	async postAnalyzingThought(sessionId: string): Promise<string | null> {
		return this.postActivity(
			sessionId,
			{
				content: { type: "thought", body: "Analyzing your request…" },
				ephemeral: true,
			},
			"analyzing thought",
		);
	}

	/**
	 * Handle status messages (compacting, etc.)
	 */
	private async handleStatusMessage(
		sessionId: string,
		message: AgentStatusMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session?.externalSessionId) {
			const log = this.sessionLog(sessionId);
			log.debug(
				`Skipping status message - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return;
		}

		if (message.status === "compacting") {
			const activityId = await this.postActivity(
				sessionId,
				{
					content: {
						type: "thought",
						body: "Compacting conversation history…",
					},
					ephemeral: true,
				},
				"compacting status",
			);
			if (activityId) {
				this.activeStatusActivitiesBySession.set(sessionId, activityId);
			}
		} else if (message.status === null) {
			// Clear the status - post a non-ephemeral thought to replace the ephemeral one
			await this.postActivity(
				sessionId,
				{
					content: { type: "thought", body: "Conversation history compacted" },
					ephemeral: false,
				},
				"status clear",
			);
			// Clean up the stored activity ID regardless — stale IDs do no harm
			this.activeStatusActivitiesBySession.delete(sessionId);
		}
	}
}
