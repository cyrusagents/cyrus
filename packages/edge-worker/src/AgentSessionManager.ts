import { EventEmitter } from "node:events";
import type {
	APIAssistantMessage,
	APIUserMessage,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "cyrus-claude-runner";
import {
	AgentSessionStatus,
	AgentSessionType,
	type CyrusAgentSession,
	type CyrusAgentSessionEntry,
	createLogger,
	type IAgentRunner,
	type ILogger,
	type IssueMinimal,
	type SerializedCyrusAgentSession,
	type SerializedCyrusAgentSessionEntry,
	type Workspace,
} from "cyrus-core";
import type { ProcedureAnalyzer } from "./procedures/ProcedureAnalyzer.js";
import type { ValidationLoopMetadata } from "./procedures/types.js";
import type { SharedApplicationServer } from "./SharedApplicationServer.js";
import type {
	ActivityPostOptions,
	ActivitySignal,
	IActivitySink,
} from "./sinks/index.js";
import {
	DEFAULT_VALIDATION_LOOP_CONFIG,
	parseValidationResult,
	renderValidationFixerPrompt,
} from "./validation/index.js";

/**
 * Events emitted by AgentSessionManager
 */
export interface AgentSessionManagerEvents {
	subroutineComplete: (data: {
		sessionId: string;
		session: CyrusAgentSession;
	}) => void;
	/**
	 * Emitted when validation fails and we need to run the validation-fixer
	 * The EdgeWorker should respond by running the fixer prompt and then re-running verifications
	 */
	validationLoopIteration: (data: {
		sessionId: string;
		session: CyrusAgentSession;
		/** The fixer prompt to run (already rendered with failure context) */
		fixerPrompt: string;
		/** Current iteration (1-based) */
		iteration: number;
		/** Maximum iterations allowed */
		maxIterations: number;
	}) => void;
	/**
	 * Emitted when we need to re-run the verifications subroutine
	 */
	validationLoopRerun: (data: {
		sessionId: string;
		session: CyrusAgentSession;
		/** Current iteration (1-based) */
		iteration: number;
	}) => void;
}

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
 * CURRENTLY BEING HANDLED 'per repository'
 */
export class AgentSessionManager extends EventEmitter {
	private logger: ILogger;
	private activitySink: IActivitySink;
	private sessions: Map<string, CyrusAgentSession> = new Map();
	private entries: Map<string, CyrusAgentSessionEntry[]> = new Map(); // Stores a list of session entries per each session by its id
	private activeTasksBySession: Map<string, string> = new Map(); // Maps session ID to active Task tool use ID
	private toolCallsByToolUseId: Map<string, { name: string; input: any }> =
		new Map(); // Track tool calls by their tool_use_id
	private taskSubjectsByToolUseId: Map<string, string> = new Map(); // Cache TaskCreate subjects by toolUseId until result arrives with task ID
	private taskSubjectsById: Map<string, string> = new Map(); // Cache task subjects by task ID (e.g., "1" → "Fix login bug")
	private activeStatusActivitiesBySession: Map<string, string> = new Map(); // Maps session ID to active compacting status activity ID
	private stopRequestedSessions: Set<string> = new Set(); // Sessions explicitly stopped by user signal
	private procedureAnalyzer?: ProcedureAnalyzer;
	private sharedApplicationServer?: SharedApplicationServer;
	private getParentSessionId?: (childSessionId: string) => string | undefined;
	private resumeParentSession?: (
		parentSessionId: string,
		prompt: string,
		childSessionId: string,
	) => Promise<void>;

	constructor(
		activitySink: IActivitySink,
		getParentSessionId?: (childSessionId: string) => string | undefined,
		resumeParentSession?: (
			parentSessionId: string,
			prompt: string,
			childSessionId: string,
		) => Promise<void>,
		procedureAnalyzer?: ProcedureAnalyzer,
		sharedApplicationServer?: SharedApplicationServer,
		logger?: ILogger,
	) {
		super();
		this.logger = logger ?? createLogger({ component: "AgentSessionManager" });
		this.activitySink = activitySink;
		this.getParentSessionId = getParentSessionId;
		this.resumeParentSession = resumeParentSession;
		this.procedureAnalyzer = procedureAnalyzer;
		this.sharedApplicationServer = sharedApplicationServer;
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
	 */
	createLinearAgentSession(
		sessionId: string,
		issueId: string,
		issueMinimal: IssueMinimal,
		workspace: Workspace,
		platform: "linear" | "github" | "slack" = "linear",
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
	 * Unlike {@link createLinearAgentSession}, this does NOT require issue
	 * context — the session lives in a standalone workspace with no issue
	 * tracker linkage.
	 */
	createChatSession(
		sessionId: string,
		workspace: Workspace,
		platform: string,
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
			workspace,
		};

		this.sessions.set(sessionId, agentSession);
		this.entries.set(sessionId, []);

		return agentSession;
	}

	/**
	 * Update Agent Session with session ID from system initialization
	 * Automatically detects whether it's Claude or Gemini based on the runner
	 */
	updateAgentSessionWithClaudeSessionId(
		sessionId: string,
		claudeSystemMessage: SDKSystemMessage,
	): void {
		const linearSession = this.sessions.get(sessionId);
		if (!linearSession) {
			const log = this.sessionLog(sessionId);
			log.warn(`No session found`);
			return;
		}

		// Determine which runner is being used
		const runner = linearSession.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		// Update the appropriate session ID based on runner type
		if (runnerType === "gemini") {
			linearSession.geminiSessionId = claudeSystemMessage.session_id;
		} else if (runnerType === "codex") {
			linearSession.codexSessionId = claudeSystemMessage.session_id;
		} else if (runnerType === "cursor") {
			linearSession.cursorSessionId = claudeSystemMessage.session_id;
		} else {
			linearSession.claudeSessionId = claudeSystemMessage.session_id;
		}

		linearSession.updatedAt = Date.now();
		linearSession.metadata = {
			...linearSession.metadata, // Preserve existing metadata
			model: claudeSystemMessage.model,
			tools: claudeSystemMessage.tools,
			permissionMode: claudeSystemMessage.permissionMode,
			apiKeySource: claudeSystemMessage.apiKeySource,
		};
	}

	/**
	 * Create a session entry from user/assistant message (without syncing to Linear)
	 */
	private async createSessionEntry(
		sessionId: string,
		sdkMessage: SDKUserMessage | SDKAssistantMessage,
	): Promise<CyrusAgentSessionEntry> {
		// Extract tool info if this is an assistant message
		const toolInfo =
			sdkMessage.type === "assistant" ? this.extractToolInfo(sdkMessage) : null;
		// Extract tool_use_id and error status if this is a user message with tool_result
		const toolResultInfo =
			sdkMessage.type === "user"
				? this.extractToolResultInfo(sdkMessage)
				: null;
		// Extract SDK error from assistant messages (e.g., rate_limit, billing_error)
		// SDKAssistantMessage has optional `error?: SDKAssistantMessageError` field
		// See: @anthropic-ai/claude-agent-sdk sdk.d.ts lines 1013-1022
		// Evidence from ~/.cyrus/logs/CYGROW-348 session jsonl shows assistant messages with
		// "error":"rate_limit" field when usage limits are hit
		const sdkError =
			sdkMessage.type === "assistant" ? sdkMessage.error : undefined;

		// Determine which runner is being used
		const session = this.sessions.get(sessionId);
		const runner = session?.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		const sessionEntry: CyrusAgentSessionEntry = {
			// Set the appropriate session ID based on runner type
			...(runnerType === "gemini"
				? { geminiSessionId: sdkMessage.session_id }
				: runnerType === "codex"
					? { codexSessionId: sdkMessage.session_id }
					: runnerType === "cursor"
						? { cursorSessionId: sdkMessage.session_id }
						: { claudeSessionId: sdkMessage.session_id }),
			type: sdkMessage.type,
			content: this.extractContent(sdkMessage),
			metadata: {
				timestamp: Date.now(),
				parentToolUseId: sdkMessage.parent_tool_use_id || undefined,
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
	 * Complete a session from Claude result message
	 */
	async completeSession(
		sessionId: string,
		resultMessage: SDKResultMessage,
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

		// Clear tool calls tracking for this session
		// Note: We should ideally track by session, but for now clearing all is safer
		// to prevent memory leaks

		const wasStopRequested = this.consumeStopRequest(sessionId);
		const status = wasStopRequested
			? AgentSessionStatus.Error
			: resultMessage.subtype === "success"
				? AgentSessionStatus.Complete
				: AgentSessionStatus.Error;

		// Update session status and metadata
		await this.updateSessionStatus(sessionId, status, {
			totalCostUsd: resultMessage.total_cost_usd,
			usage: resultMessage.usage,
		});

		// Handle result using procedure routing system (skip for sessions without procedures, e.g. Slack)
		if (!this.procedureAnalyzer) {
			log.info(`Session completed (no procedure routing)`);
			return;
		}

		if (wasStopRequested) {
			log.info(
				`Session ${sessionId} was stopped by user; skipping procedure continuation`,
			);
			return;
		}

		if ("result" in resultMessage && resultMessage.result) {
			await this.handleProcedureCompletion(session, sessionId, resultMessage);
		} else if (
			resultMessage.subtype !== "success" &&
			this.shouldRecoverFromPreviousSubroutine(resultMessage)
		) {
			// Error result (e.g. error_max_turns from singleTurn subroutines) — try to
			// recover from the last completed subroutine's result so the procedure can still complete.
			const recoveredText =
				this.procedureAnalyzer?.getLastSubroutineResult(session);
			if (recoveredText) {
				log.info(
					`Recovered result from previous subroutine (subtype: ${resultMessage.subtype}), treating as success for procedure completion`,
				);
				// Create a synthetic success result for procedure routing
				const syntheticResult: SDKResultMessage = {
					...resultMessage,
					subtype: "success",
					result: recoveredText,
					is_error: false,
				};
				await this.handleProcedureCompletion(
					session,
					sessionId,
					syntheticResult,
				);
			} else {
				log.warn(
					`Error result with no recoverable text (subtype: ${resultMessage.subtype}), posting error to Linear`,
				);
				await this.addResultEntry(sessionId, resultMessage);
			}
		} else if (resultMessage.subtype !== "success") {
			// Non-recoverable errors (e.g. stop/abort) should not advance procedures.
			await this.addResultEntry(sessionId, resultMessage);
		}
	}

	private shouldRecoverFromPreviousSubroutine(
		resultMessage: SDKResultMessage,
	): boolean {
		if (resultMessage.subtype === "error_max_turns") {
			return true;
		}

		const errorText = [
			resultMessage.subtype,
			...("errors" in resultMessage && Array.isArray(resultMessage.errors)
				? resultMessage.errors
				: []),
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result
				: "",
		]
			.join(" ")
			.toLowerCase();

		return (
			errorText.includes("max turn") ||
			errorText.includes("turn limit") ||
			errorText.includes("turns limit")
		);
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
	 * Handle completion using procedure routing system
	 */
	private async handleProcedureCompletion(
		session: CyrusAgentSession,
		sessionId: string,
		resultMessage: SDKResultMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		if (!this.procedureAnalyzer) {
			throw new Error("ProcedureAnalyzer not available");
		}

		// Check if error occurred
		if (resultMessage.subtype !== "success") {
			log.info(
				`Subroutine completed with error, not triggering next subroutine`,
			);
			return;
		}

		// Get the runner session ID (Claude, Gemini, Codex, or Cursor)
		const runnerSessionId =
			session.claudeSessionId ||
			session.geminiSessionId ||
			session.codexSessionId ||
			session.cursorSessionId;
		if (!runnerSessionId) {
			log.error(`No runner session ID found for procedure session`);
			return;
		}

		// Check if there's a next subroutine
		const nextSubroutine = this.procedureAnalyzer.getNextSubroutine(session);

		if (nextSubroutine) {
			// More subroutines to run - check if current subroutine requires approval
			const currentSubroutine =
				this.procedureAnalyzer.getCurrentSubroutine(session);

			if (currentSubroutine?.requiresApproval) {
				log.info(
					`Current subroutine "${currentSubroutine.name}" requires approval before proceeding`,
				);

				// Check if SharedApplicationServer is available
				if (!this.sharedApplicationServer) {
					log.error(
						`SharedApplicationServer not available for approval workflow`,
					);
					await this.createErrorActivity(
						sessionId,
						"Approval workflow failed: Server not available",
					);
					return;
				}

				// Extract the final result from the completed subroutine
				const subroutineResult =
					"result" in resultMessage && resultMessage.result
						? resultMessage.result
						: "No result available";

				try {
					// Register approval request with server
					const approvalRequest =
						this.sharedApplicationServer.registerApprovalRequest(sessionId);

					// Post approval elicitation to Linear with auth signal URL
					const approvalMessage = `The previous step has completed. Please review the result below and approve to continue:\n\n${subroutineResult}`;

					await this.createApprovalElicitation(
						sessionId,
						approvalMessage,
						approvalRequest.url,
					);

					log.info(`Waiting for approval at URL: ${approvalRequest.url}`);

					// Wait for approval with timeout (30 minutes)
					const approvalTimeout = 30 * 60 * 1000;
					const timeoutPromise = new Promise<never>((_, reject) =>
						setTimeout(
							() => reject(new Error("Approval timeout")),
							approvalTimeout,
						),
					);

					const { approved, feedback } = await Promise.race([
						approvalRequest.promise,
						timeoutPromise,
					]);

					if (!approved) {
						log.info(`Approval rejected`);
						await this.createErrorActivity(
							sessionId,
							`Workflow stopped: User rejected approval.${feedback ? `\n\nFeedback: ${feedback}` : ""}`,
						);
						return; // Stop workflow
					}

					log.info(`Approval granted, continuing to next subroutine`);

					// Optionally post feedback as a thought
					if (feedback) {
						await this.createThoughtActivity(
							sessionId,
							`User feedback: ${feedback}`,
						);
					}

					// Continue with advancement (fall through to existing code)
				} catch (error) {
					const errorMessage = (error as Error).message;
					if (errorMessage === "Approval timeout") {
						log.info(`Approval timed out`);
						await this.createErrorActivity(
							sessionId,
							"Workflow stopped: Approval request timed out after 30 minutes.",
						);
					} else {
						log.error(`Approval request failed:`, error);
						await this.createErrorActivity(
							sessionId,
							`Workflow stopped: Approval request failed - ${errorMessage}`,
						);
					}
					return; // Stop workflow
				}
			}

			// Check if current subroutine uses validation loop
			if (currentSubroutine?.usesValidationLoop) {
				const handled = await this.handleValidationLoopCompletion(
					session,
					sessionId,
					resultMessage,
					runnerSessionId,
					nextSubroutine,
				);
				if (handled) {
					return; // Validation loop took over control flow
				}
				// If not handled (validation passed or max retries), continue with normal advancement
			}

			// Advance procedure state
			log.info(
				`Subroutine completed, advancing to next: ${nextSubroutine.name}`,
			);
			const subroutineResult =
				"result" in resultMessage ? resultMessage.result : undefined;
			this.procedureAnalyzer.advanceToNextSubroutine(
				session,
				runnerSessionId,
				subroutineResult,
			);

			// Emit event for EdgeWorker to handle subroutine transition
			// This replaces the callback pattern and allows EdgeWorker to subscribe
			this.emit("subroutineComplete", {
				sessionId,
				session,
			});
		} else {
			// Procedure complete - post final result
			log.info(`All subroutines completed, posting final result to Linear`);
			await this.addResultEntry(sessionId, resultMessage);

			// Handle child session completion
			const isChildSession = this.getParentSessionId?.(sessionId);
			if (isChildSession && this.resumeParentSession) {
				await this.handleChildSessionCompletion(sessionId, resultMessage);
			}
		}
	}

	/**
	 * Handle validation loop completion for subroutines that use usesValidationLoop
	 * Returns true if the validation loop took over control flow (needs fixer or retry)
	 * Returns false if validation passed or max retries reached (continue with normal advancement)
	 */
	private async handleValidationLoopCompletion(
		session: CyrusAgentSession,
		sessionId: string,
		resultMessage: SDKResultMessage,
		_runnerSessionId: string,
		_nextSubroutine: { name: string } | null,
	): Promise<boolean> {
		const log = this.sessionLog(sessionId);
		const maxIterations = DEFAULT_VALIDATION_LOOP_CONFIG.maxIterations;

		// Get or initialize validation loop state
		let validationLoop = session.metadata?.procedure?.validationLoop;
		if (!validationLoop) {
			validationLoop = {
				iteration: 0,
				inFixerMode: false,
				attempts: [],
			};
		}

		// Check if we're coming back from the fixer
		if (validationLoop.inFixerMode) {
			// Fixer completed, now we need to re-run verifications
			log.info(
				`Validation fixer completed for iteration ${validationLoop.iteration}, re-running verifications`,
			);

			// Clear fixer mode flag
			validationLoop.inFixerMode = false;
			this.updateValidationLoopState(session, validationLoop);

			// Emit event to re-run verifications
			this.emit("validationLoopRerun", {
				sessionId,
				session,
				iteration: validationLoop.iteration,
			});

			return true;
		}

		// Parse the validation result from the response
		const resultText =
			"result" in resultMessage ? resultMessage.result : undefined;
		const structuredOutput =
			"structured_output" in resultMessage
				? (resultMessage as { structured_output?: unknown }).structured_output
				: undefined;

		const validationResult = parseValidationResult(
			resultText,
			structuredOutput,
		);

		// Record this attempt
		const newIteration = validationLoop.iteration + 1;
		validationLoop.iteration = newIteration;
		validationLoop.attempts.push({
			iteration: newIteration,
			pass: validationResult.pass,
			reason: validationResult.reason,
			timestamp: Date.now(),
		});

		log.info(
			`Validation result for iteration ${newIteration}/${maxIterations}: pass=${validationResult.pass}, reason="${validationResult.reason.substring(0, 100)}..."`,
		);

		// Update state in session
		this.updateValidationLoopState(session, validationLoop);

		// Check if validation passed
		if (validationResult.pass) {
			log.info(`Validation passed after ${newIteration} iteration(s)`);
			// Clear validation loop state for next subroutine
			this.clearValidationLoopState(session);
			return false; // Continue with normal advancement
		}

		// Check if we've exceeded max retries
		if (newIteration >= maxIterations) {
			log.info(
				`Validation failed after ${newIteration} iterations, continuing anyway`,
			);
			// Post a thought about the failures
			await this.createThoughtActivity(
				sessionId,
				`Validation loop exhausted after ${newIteration} attempts. Last failure: ${validationResult.reason}`,
			);
			// Clear validation loop state for next subroutine
			this.clearValidationLoopState(session);
			return false; // Continue with normal advancement
		}

		// Validation failed and we have retries left - run the fixer
		log.info(
			`Validation failed, running fixer (iteration ${newIteration}/${maxIterations})`,
		);

		// Set fixer mode flag
		validationLoop.inFixerMode = true;
		this.updateValidationLoopState(session, validationLoop);

		// Render the fixer prompt with context
		const previousAttempts = validationLoop.attempts.slice(0, -1).map((a) => ({
			iteration: a.iteration,
			reason: a.reason,
		}));

		const fixerPrompt = renderValidationFixerPrompt({
			failureReason: validationResult.reason,
			iteration: newIteration,
			maxIterations,
			previousAttempts,
		});

		// Emit event for EdgeWorker to run the fixer
		this.emit("validationLoopIteration", {
			sessionId,
			session,
			fixerPrompt,
			iteration: newIteration,
			maxIterations,
		});

		return true; // Validation loop took over control flow
	}

	/**
	 * Update validation loop state in session metadata
	 */
	private updateValidationLoopState(
		session: CyrusAgentSession,
		validationLoop: ValidationLoopMetadata,
	): void {
		if (!session.metadata) {
			session.metadata = {};
		}
		if (!session.metadata.procedure) {
			return; // No procedure metadata, can't update
		}
		session.metadata.procedure.validationLoop = validationLoop;
	}

	/**
	 * Clear validation loop state from session metadata
	 */
	private clearValidationLoopState(session: CyrusAgentSession): void {
		if (session.metadata?.procedure) {
			delete session.metadata.procedure.validationLoop;
		}
	}

	/**
	 * Handle child session completion and resume parent
	 */
	private async handleChildSessionCompletion(
		sessionId: string,
		resultMessage: SDKResultMessage,
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
	 * Handle streaming Claude messages and route to appropriate methods
	 */
	async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			switch (message.type) {
				case "system":
					if (message.subtype === "init") {
						this.updateAgentSessionWithClaudeSessionId(sessionId, message);

						// Post model notification
						const systemMessage = message as SDKSystemMessage;
						if (systemMessage.model) {
							await this.postModelNotificationThought(
								sessionId,
								systemMessage.model,
							);
						}
					} else if (message.subtype === "status") {
						// Handle status updates (compacting, etc.)
						await this.handleStatusMessage(
							sessionId,
							message as SDKStatusMessage,
						);
					}
					break;

				case "user": {
					const userEntry = await this.createSessionEntry(
						sessionId,
						message as SDKUserMessage,
					);
					await this.syncEntryToActivitySink(userEntry, sessionId);
					break;
				}

				case "assistant": {
					const assistantEntry = await this.createSessionEntry(
						sessionId,
						message as SDKAssistantMessage,
					);
					await this.syncEntryToActivitySink(assistantEntry, sessionId);
					break;
				}

				case "result":
					await this.completeSession(sessionId, message as SDKResultMessage);
					break;

				default:
					log.warn(`Unknown message type: ${(message as any).type}`);
			}
		} catch (error) {
			log.error(`Error handling message:`, error);
			// Mark session as error state
			await this.updateSessionStatus(sessionId, AgentSessionStatus.Error);
		}
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
		resultMessage: SDKResultMessage,
	): Promise<void> {
		// Determine which runner is being used
		const session = this.sessions.get(sessionId);
		const runner = session?.agentRunner;
		const runnerType =
			runner?.constructor.name === "GeminiRunner"
				? "gemini"
				: runner?.constructor.name === "CodexRunner"
					? "codex"
					: runner?.constructor.name === "CursorRunner"
						? "cursor"
						: "claude";

		// For error results, content may be in errors[] rather than result
		const content =
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result
				: resultMessage.is_error &&
						"errors" in resultMessage &&
						Array.isArray(resultMessage.errors) &&
						resultMessage.errors.length > 0
					? resultMessage.errors.join("\n")
					: "";

		const resultEntry: CyrusAgentSessionEntry = {
			// Set the appropriate session ID based on runner type
			...(runnerType === "gemini"
				? { geminiSessionId: resultMessage.session_id }
				: runnerType === "codex"
					? { codexSessionId: resultMessage.session_id }
					: runnerType === "cursor"
						? { cursorSessionId: resultMessage.session_id }
						: { claudeSessionId: resultMessage.session_id }),
			type: "result",
			content,
			metadata: {
				timestamp: Date.now(),
				durationMs: resultMessage.duration_ms,
				isError: resultMessage.is_error,
			},
		};

		// DON'T store locally - syncEntryToActivitySink will do it
		// Sync to Linear
		await this.syncEntryToActivitySink(resultEntry, sessionId);
	}

	/**
	 * Extract content from Claude message
	 */
	private extractContent(
		sdkMessage: SDKUserMessage | SDKAssistantMessage,
	): string {
		const message =
			sdkMessage.type === "user"
				? (sdkMessage.message as APIUserMessage)
				: (sdkMessage.message as APIAssistantMessage);

		if (typeof message.content === "string") {
			return message.content;
		}

		if (Array.isArray(message.content)) {
			return message.content
				.map((block) => {
					if (block.type === "text") {
						return block.text;
					} else if (block.type === "tool_use") {
						// For tool use blocks, return the input as JSON string
						return JSON.stringify(block.input, null, 2);
					} else if (block.type === "tool_result") {
						// For tool_result blocks, extract just the text content
						// Also store the error status in metadata if needed
						if ("is_error" in block && block.is_error) {
							// Mark this as an error result - we'll handle this elsewhere
						}
						if (typeof block.content === "string") {
							return block.content;
						}
						if (Array.isArray(block.content)) {
							return block.content
								.filter((contentBlock: any) => contentBlock.type === "text")
								.map((contentBlock: any) => contentBlock.text)
								.join("\n");
						}
						return "";
					}
					return "";
				})
				.filter(Boolean)
				.join("\n");
		}

		return "";
	}

	/**
	 * Extract tool information from Claude assistant message
	 */
	private extractToolInfo(
		sdkMessage: SDKAssistantMessage,
	): { id: string; name: string; input: any } | null {
		const message = sdkMessage.message as APIAssistantMessage;

		if (Array.isArray(message.content)) {
			const toolUse = message.content.find(
				(block) => block.type === "tool_use",
			);
			if (
				toolUse &&
				"id" in toolUse &&
				"name" in toolUse &&
				"input" in toolUse
			) {
				return {
					id: toolUse.id,
					name: toolUse.name,
					input: toolUse.input,
				};
			}
		}
		return null;
	}

	/**
	 * Extract tool_use_id and error status from Claude user message containing tool_result
	 */
	private extractToolResultInfo(
		sdkMessage: SDKUserMessage,
	): { toolUseId: string; isError: boolean } | null {
		const message = sdkMessage.message as APIUserMessage;

		if (Array.isArray(message.content)) {
			const toolResult = message.content.find(
				(block) => block.type === "tool_result",
			);
			if (toolResult && "tool_use_id" in toolResult) {
				return {
					toolUseId: toolResult.tool_use_id,
					isError: "is_error" in toolResult && toolResult.is_error === true,
				};
			}
		}
		return null;
	}

	/**
	 * Extract tool result content and error status from session entry
	 */
	private extractToolResult(
		entry: CyrusAgentSessionEntry,
	): { content: string; isError: boolean } | null {
		// Check if we have the error status in metadata
		const isError = entry.metadata?.toolResultError || false;

		return {
			content: entry.content,
			isError: isError,
		};
	}

	/**
	 * Sync session entry to external tracker (create AgentActivity)
	 */
	private async syncEntryToActivitySink(
		entry: CyrusAgentSessionEntry,
		sessionId: string,
	): Promise<void> {
		const log = this.sessionLog(sessionId);
		try {
			const session = this.sessions.get(sessionId);
			if (!session) {
				log.warn(`No session found`);
				return;
			}

			// Store entry locally first
			const entries = this.entries.get(sessionId) || [];
			entries.push(entry);
			this.entries.set(sessionId, entries);

			// Build activity content based on entry type
			let content: any;
			let ephemeral = false;
			switch (entry.type) {
				case "user": {
					const activeTaskId = this.activeTasksBySession.get(sessionId);
					if (activeTaskId && activeTaskId === entry.metadata?.toolUseId) {
						content = {
							type: "thought",
							body: `✅ Task Completed\n\n\n\n${entry.content}\n\n---\n\n`,
						};
						this.activeTasksBySession.delete(sessionId);
					} else if (entry.metadata?.toolUseId) {
						// This is a tool result - create an action activity with the result
						const toolResult = this.extractToolResult(entry);
						if (toolResult) {
							// Get the original tool information
							const originalTool = this.toolCallsByToolUseId.get(
								entry.metadata.toolUseId,
							);
							const toolName = originalTool?.name || "Tool";
							const toolInput = originalTool?.input || "";

							// Clean up the tool call from our tracking map
							if (entry.metadata.toolUseId) {
								this.toolCallsByToolUseId.delete(entry.metadata.toolUseId);
							}

							// Handle TaskCreate results: cache the task ID → subject mapping
							const baseToolName = toolName.replace("↪ ", "");
							if (baseToolName === "TaskCreate" && entry.metadata?.toolUseId) {
								const cachedSubject = this.taskSubjectsByToolUseId.get(
									entry.metadata.toolUseId,
								);
								if (cachedSubject) {
									// Parse task ID from result like "Task #1 created successfully: ..."
									const taskIdMatch = toolResult.content?.match(/Task #(\d+)/);
									if (taskIdMatch?.[1]) {
										this.taskSubjectsById.set(taskIdMatch[1], cachedSubject);
									}
									this.taskSubjectsByToolUseId.delete(
										entry.metadata.toolUseId!,
									);
								}
							}

							// Handle TaskUpdate/TaskGet results: post enriched thought with subject
							if (baseToolName === "TaskUpdate" || baseToolName === "TaskGet") {
								const formatter = session.agentRunner?.getFormatter();
								if (!formatter) {
									log.warn(`No formatter available for session ${sessionId}`);
									return;
								}

								// Try to enrich toolInput with subject from cache or result
								const enrichedInput = { ...toolInput };
								if (!enrichedInput.subject) {
									const taskId = enrichedInput.taskId || "";
									// First try: look up subject from our cache
									const cachedSubject = this.taskSubjectsById.get(taskId);
									if (cachedSubject) {
										enrichedInput.subject = cachedSubject;
									} else if (baseToolName === "TaskGet" && toolResult.content) {
										// Second try: parse subject from TaskGet result content
										// Format: "ID: 123\nSubject: Fix bug\nStatus: ..."
										const subjectMatch =
											toolResult.content.match(/^Subject:\s*(.+)$/m);
										if (subjectMatch?.[1]) {
											enrichedInput.subject = subjectMatch[1].trim();
											// Also cache it for future TaskUpdate calls
											if (taskId) {
												this.taskSubjectsById.set(
													taskId,
													enrichedInput.subject,
												);
											}
										}
									} else if (
										baseToolName === "TaskUpdate" &&
										toolResult.content
									) {
										// Try to parse subject from TaskUpdate result content
										// Format: "Updated task #3 subject" or may contain task details
										const subjectMatch =
											toolResult.content.match(/^Subject:\s*(.+)$/m);
										if (subjectMatch?.[1]) {
											enrichedInput.subject = subjectMatch[1].trim();
											if (taskId) {
												this.taskSubjectsById.set(
													taskId,
													enrichedInput.subject,
												);
											}
										}
									}
								}

								const formattedTask = formatter.formatTaskParameter(
									baseToolName,
									enrichedInput,
								);
								content = {
									type: "thought",
									body: formattedTask,
								};
								ephemeral = false;
								break;
							}

							// Skip creating activity for TodoWrite/write_todos results since they already created a non-ephemeral thought
							// Skip TaskCreate/TaskList results since they already created a non-ephemeral thought
							// Skip ToolSearch results since they already created a non-ephemeral thought
							// Skip AskUserQuestion results since it's custom handled via Linear's select signal elicitation
							if (
								toolName === "TodoWrite" ||
								toolName === "↪ TodoWrite" ||
								toolName === "write_todos" ||
								toolName === "TaskCreate" ||
								toolName === "↪ TaskCreate" ||
								toolName === "TaskList" ||
								toolName === "↪ TaskList" ||
								toolName === "ToolSearch" ||
								toolName === "↪ ToolSearch" ||
								toolName === "AskUserQuestion" ||
								toolName === "↪ AskUserQuestion"
							) {
								return;
							}

							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Format parameter and result using runner's formatter
							const formattedParameter = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							const formattedResult = formatter.formatToolResult(
								toolName,
								toolInput,
								toolResult.content?.trim() || "",
								toolResult.isError,
							);

							// Format the action name (with description for Bash tool)
							const formattedAction = formatter.formatToolActionName(
								toolName,
								toolInput,
								toolResult.isError,
							);

							content = {
								type: "action",
								action: formattedAction,
								parameter: formattedParameter,
								result: formattedResult,
							};
						} else {
							return;
						}
					} else {
						return;
					}
					break;
				}
				case "assistant": {
					// Assistant messages can be thoughts or responses
					if (entry.metadata?.toolUseId) {
						const toolName = entry.metadata.toolName || "Tool";

						// Store tool information for later use in tool results
						if (entry.metadata.toolUseId) {
							// Check if this is a subtask with arrow prefix
							let storedName = toolName;
							if (entry.metadata?.parentToolUseId) {
								const activeTaskId = this.activeTasksBySession.get(sessionId);
								if (activeTaskId === entry.metadata?.parentToolUseId) {
									storedName = `↪ ${toolName}`;
								}
							}

							this.toolCallsByToolUseId.set(entry.metadata.toolUseId, {
								name: storedName,
								input: entry.metadata.toolInput || entry.content,
							});
						}

						// Skip AskUserQuestion tool - it's custom handled via Linear's select signal elicitation
						if (toolName === "AskUserQuestion") {
							return;
						}

						// Special handling for TodoWrite tool (Claude) and write_todos (Gemini) - treat as thought instead of action
						if (toolName === "TodoWrite" || toolName === "write_todos") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							const formattedTodos = formatter.formatTodoWriteParameter(
								entry.content,
							);
							content = {
								type: "thought",
								body: formattedTodos,
							};
							// TodoWrite/write_todos is not ephemeral
							ephemeral = false;
						} else if (toolName === "TaskCreate" || toolName === "TaskList") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available for session ${sessionId}`);
								return;
							}

							// Special handling for Task tools - format as thought instead of action
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedTask = formatter.formatTaskParameter(
								toolName,
								toolInput,
							);
							content = {
								type: "thought",
								body: formattedTask,
							};
							// Task tools are not ephemeral
							ephemeral = false;

							// Cache TaskCreate subject by toolUseId so we can map it to task ID when result arrives
							if (
								toolName === "TaskCreate" &&
								toolInput?.subject &&
								entry.metadata.toolUseId
							) {
								this.taskSubjectsByToolUseId.set(
									entry.metadata.toolUseId,
									toolInput.subject,
								);
							}
						} else if (toolName === "TaskUpdate" || toolName === "TaskGet") {
							// Skip posting at tool_use time — defer to tool_result time
							// so we can enrich with subject from result or cache
							return;
						} else if (toolName === "ToolSearch") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available for session ${sessionId}`);
								return;
							}

							// Special handling for ToolSearch - format as thought instead of action
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedParam = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							content = {
								type: "thought",
								body: formattedParam,
							};
							// ToolSearch is not ephemeral
							ephemeral = false;
						} else if (toolName === "Task") {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Special handling for Task tool - add start marker and track active task
							const toolInput = entry.metadata.toolInput || entry.content;
							const formattedParameter = formatter.formatToolParameter(
								toolName,
								toolInput,
							);
							const displayName = toolName;

							// Track this as the active Task for this session
							if (entry.metadata?.toolUseId) {
								this.activeTasksBySession.set(
									sessionId,
									entry.metadata.toolUseId,
								);
							}

							content = {
								type: "action",
								action: displayName,
								parameter: formattedParameter,
								// result will be added later when we get tool result
							};
							// Task is not ephemeral
							ephemeral = false;
						} else {
							// Get formatter from runner
							const formatter = session.agentRunner?.getFormatter();
							if (!formatter) {
								log.warn(`No formatter available`);
								return;
							}

							// Other tools - check if they're within an active Task
							const toolInput = entry.metadata.toolInput || entry.content;
							let displayName = toolName;

							if (entry.metadata?.parentToolUseId) {
								const activeTaskId = this.activeTasksBySession.get(sessionId);
								if (activeTaskId === entry.metadata?.parentToolUseId) {
									displayName = `↪ ${toolName}`;
								}
							}

							const formattedParameter = formatter.formatToolParameter(
								displayName,
								toolInput,
							);

							content = {
								type: "action",
								action: displayName,
								parameter: formattedParameter,
								// result will be added later when we get tool result
							};
							// Standard tool calls are ephemeral
							ephemeral = true;
						}
					} else if (entry.metadata?.sdkError) {
						// Assistant message with SDK error (e.g., rate_limit, billing_error)
						// Create an error type so it's visible to users (not just a thought)
						// Per CYPACK-719: usage limits should trigger "error" type activity
						content = {
							type: "error",
							body: entry.content,
						};
					} else {
						// Regular assistant message - create a thought
						content = {
							type: "thought",
							body: entry.content,
						};
					}
					break;
				}

				case "system":
					// System messages are thoughts
					content = {
						type: "thought",
						body: entry.content,
					};
					break;

				case "result":
					// Result messages can be responses or errors
					if (entry.metadata?.isError) {
						content = {
							type: "error",
							body: entry.content,
						};
					} else {
						content = {
							type: "response",
							body: entry.content,
						};
					}
					break;

				default:
					// Default to thought
					content = {
						type: "thought",
						body: entry.content,
					};
			}

			// Check if current subroutine has suppressThoughtPosting enabled
			// If so, suppress thoughts and actions (but still post responses and results)
			const currentSubroutine =
				this.procedureAnalyzer?.getCurrentSubroutine(session);
			if (currentSubroutine?.suppressThoughtPosting) {
				// Only suppress thoughts and actions, not responses or results
				if (content.type === "thought" || content.type === "action") {
					log.debug(
						`Suppressing ${content.type} posting for subroutine "${currentSubroutine.name}"`,
					);
					return; // Don't post to tracker
				}
			}

			// Ensure we have an external session ID for activity posting
			if (!session.externalSessionId) {
				log.debug(
					`Skipping activity sync - no external session ID (platform: ${session.issueContext?.trackerId || "unknown"})`,
				);
				return;
			}

			const options: ActivityPostOptions = {};
			if (ephemeral) {
				options.ephemeral = true;
			}

			const result = await this.activitySink.postActivity(
				session.externalSessionId,
				content,
				options,
			);

			if (result.activityId) {
				entry.linearAgentActivityId = result.activityId;
				if (entry.type === "result") {
					log.info(
						`Result message emitted to Linear (activity ${entry.linearAgentActivityId})`,
					);
				} else {
					log.debug(
						`Created ${content.type} activity ${entry.linearAgentActivityId}`,
					);
				}
			}
		} catch (error) {
			log.error(`Failed to sync entry to activity sink:`, error);
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
		const log = this.sessionLog(sessionId);
		const session = this.sessions.get(sessionId);

		if (!session || !session.externalSessionId) {
			log.debug(
				`Skipping ${label} - no external session ID (platform: ${session?.issueContext?.trackerId || "unknown"})`,
			);
			return null;
		}

		try {
			const options: ActivityPostOptions = {};
			if (input.ephemeral !== undefined) {
				options.ephemeral = input.ephemeral;
			}
			if (input.signal) {
				options.signal = input.signal;
			}
			if (input.signalMetadata) {
				options.signalMetadata = input.signalMetadata;
			}

			const result = await this.activitySink.postActivity(
				session.externalSessionId,
				input.content,
				options,
			);

			if (result.activityId) {
				log.debug(`Created ${label} activity ${result.activityId}`);
				return result.activityId;
			}
			log.debug(`Created ${label}`);
			return null;
		} catch (error) {
			log.error(`Error creating ${label}:`, error);
			return null;
		}
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

		// Restore sessions
		for (const [sessionId, sessionData] of Object.entries(serializedSessions)) {
			const session: CyrusAgentSession = {
				...sessionData,
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
	 * Post the procedure selection result as a non-ephemeral thought
	 */
	async postProcedureSelectionThought(
		sessionId: string,
		procedureName: string,
		classification: string,
	): Promise<void> {
		await this.postActivity(
			sessionId,
			{
				content: {
					type: "thought",
					body: `Selected procedure: **${procedureName}** (classified as: ${classification})`,
				},
				ephemeral: false,
			},
			"procedure selection",
		);
	}

	/**
	 * Handle status messages (compacting, etc.)
	 */
	private async handleStatusMessage(
		sessionId: string,
		message: SDKStatusMessage,
	): Promise<void> {
		const session = this.sessions.get(sessionId);
		if (!session || !session.externalSessionId) {
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
