import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { SDKMessage } from "cyrus-claude-runner";
import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	CyrusAgentSession,
	IAgentRunner,
	ILogger,
} from "cyrus-core";
import { createLogger } from "cyrus-core";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { RunnerConfigBuilder } from "./RunnerConfigBuilder.js";

/**
 * Defines what each event surface must provide for the shared agent-session lifecycle.
 *
 * Implementations are stateless data mappers — they translate surface-specific
 * events into the common operations the lifecycle service needs.
 */
export type AgentSessionSurfaceName = "slack" | "linear" | "github" | "generic";

export interface AgentSessionSurfaceAdapter<TEvent> {
	readonly platformName: AgentSessionSurfaceName;

	/** Extract the user's task text from the raw event */
	extractTaskInstructions(event: TEvent): string;

	/**
	 * Whether this event is allowed to *start* a brand-new session for its
	 * thread. Events that may only continue an already-bound thread (e.g. a
	 * plain Slack message that isn't an @mention) return false, so the lifecycle
	 * ignores them when no session exists yet.
	 *
	 * Optional — when omitted, every event is treated as session-initiating
	 * (the behaviour for platforms where every event is an explicit invocation).
	 */
	isSessionInitiatingEvent?(event: TEvent): boolean;

	/** Derive a unique thread key for session tracking (e.g., "C123:1704110400.000100") */
	getThreadKey(event: TEvent): string;

	/** Get the unique event ID */
	getEventId(event: TEvent): string;

	/**
	 * Optionally derive a stable internal session id from the event. Surfaces with
	 * durable bindings should return the same id for every follow-up prompt so
	 * sessions can be restored after process restarts.
	 */
	getSessionId?(event: TEvent, threadKey: string): string;

	/** Whether this event requests that the bound session stop. */
	isStopEvent?(event: TEvent): boolean;

	/** Build a platform-specific system prompt */
	buildSystemPrompt(event: TEvent): string;

	/** Fetch thread context as formatted string. Returns "" if not applicable */
	fetchThreadContext(event: TEvent): Promise<string>;

	/** Post the agent's final response back to the platform */
	postReply(event: TEvent, runner: IAgentRunner): Promise<void>;

	/** Acknowledge receipt of the event (e.g., emoji reaction). Fire-and-forget */
	acknowledgeReceipt(event: TEvent): Promise<void>;

	/**
	 * Acknowledge that the agent finished processing the event (e.g., swap the
	 * receipt reaction for a "done" one). Called after the turn completes,
	 * whether or not a reply was actually posted — this is what tells users a
	 * message was seen even when the agent chose to stay silent.
	 *
	 * Optional — platforms without a processed indicator omit it. Fire-and-forget.
	 */
	acknowledgeProcessed?(event: TEvent): Promise<void>;

	/** Notify the user that a previous request is still processing */
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;

	/** Notify the user that a stop request was accepted. */
	notifyStopped?(event: TEvent, threadKey: string): Promise<void>;
}

/**
 * Callbacks for EdgeWorker integration (same pattern as RepositoryRouterDeps).
 */
export interface AgentSessionLifecycleServiceDeps {
	cyrusHome: string;
	/** Shared session manager used for persistence, status, and shutdown */
	sessionManager: AgentSessionManager;
	/** Provider for live repository paths, default repo, and workspace ID */
	repositoryProvider: ChatRepositoryProvider;
	/** Shared RunnerConfigBuilder for constructing runner configs */
	runnerConfigBuilder: RunnerConfigBuilder;
	/** Factory function that creates the appropriate runner based on config.defaultRunner */
	createRunner: (config: AgentRunnerConfig) => IAgentRunner;
	/**
	 * Live read of the workspace-level custom-integration MCP config paths
	 * for the event surface this service is bound to (e.g.
	 * `config.slackMcpConfigs` for Slack). Surface sessions are repo-agnostic,
	 * so `repository.mcpConfigPath` is not consulted; only this list
	 * determines which custom `.mcp.json` files load. When empty/omitted,
	 * no custom files load (native MCP servers still run as usual).
	 */
	getPlatformMcpConfigOverrides?: () => readonly string[] | undefined;
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onStateChange: () => Promise<void>;
	onClaudeError: (error: Error) => void;
}

/**
 * Generic session lifecycle engine for event-surface integrations.
 *
 * Manages the create/resume/inject/reply session lifecycle independent of any
 * specific event surface. Surface-specific behavior is provided via a
 * AgentSessionSurfaceAdapter.
 */
export class AgentSessionLifecycleService<TEvent> {
	private adapter: AgentSessionSurfaceAdapter<TEvent>;
	private sessionManager: AgentSessionManager;
	private threadSessions: Map<string, string> = new Map();
	private managedSessionIds: Set<string> = new Set();
	private deps: AgentSessionLifecycleServiceDeps;
	private logger: ILogger;
	// Queue of events awaiting a reply, keyed by sessionId. Each entry is
	// enqueued when a new prompt (initial/resume/follow-up-inject) is sent to
	// the runner, and the queue is drained when a `result` message arrives on
	// the runner's message stream. This decouples reply posting from
	// `startStreaming()` resolution, which never resolves when warm sessions
	// hold the streaming prompt open across turns.
	//
	// Drained wholesale, NOT one-per-result: messages injected in quick
	// succession get merged by the runner into a single turn (one `result`
	// answering several queued prompts), so a strict FIFO pairing would leave
	// orphaned entries that never get acknowledged — and would pair them with
	// the wrong later turns.
	private pendingReplyEvents: Map<string, TEvent[]> = new Map();
	// Last event enqueued per session. When a merged turn drained the queue
	// ahead of schedule, a subsequent `result` finds the queue empty — this
	// remembers where to post that turn's reply (all events in a session share
	// one thread, so any recent event addresses it correctly).
	private lastReplyEvent: Map<string, TEvent> = new Map();

	constructor(
		adapter: AgentSessionSurfaceAdapter<TEvent>,
		deps: AgentSessionLifecycleServiceDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger =
			logger ?? createLogger({ component: "AgentSessionLifecycleService" });
		this.sessionManager = deps.sessionManager;
	}

	/**
	 * Main entry point for a single event-surface webhook.
	 */
	async handleEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();

		try {
			const eventId = this.adapter.getEventId(event);
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${eventId}`,
			);

			// Fire-and-forget acknowledgement (e.g., emoji reaction)
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			const taskInstructions = this.adapter.extractTaskInstructions(event);
			const threadKey = this.adapter.getThreadKey(event);
			const existingSessionId = this.resolveExistingSessionId(event, threadKey);

			if (this.adapter.isStopEvent?.(event)) {
				await this.stopSession(event, threadKey, existingSessionId);
				return;
			}

			if (existingSessionId) {
				const existingSession =
					this.sessionManager.getSession(existingSessionId);
				const existingRunner =
					this.sessionManager.getAgentRunner(existingSessionId);

				if (existingSession && existingRunner?.isRunning()) {
					if (
						existingRunner.addStreamMessage &&
						existingRunner.isStreaming?.()
					) {
						this.logger.info(
							`Injecting follow-up prompt into running session ${existingSessionId} (thread ${threadKey})`,
						);
						this.enqueueReply(existingSessionId, event);
						existingRunner.addStreamMessage(taskInstructions);
					} else {
						this.logger.info(
							`Session ${existingSessionId} is still running, notifying user (thread ${threadKey})`,
						);
						await this.adapter.notifyBusy(event, threadKey);
					}
					return;
				}

				if (existingSession) {
					const resumeSessionId = this.getRunnerSessionId(existingSession);
					this.logger.info(
						resumeSessionId
							? `Resuming completed ${this.adapter.platformName} session ${existingSessionId} (thread ${threadKey})`
							: `Starting new runner for existing ${this.adapter.platformName} session ${existingSessionId} (thread ${threadKey})`,
					);

					try {
						await this.startSession(event, existingSession, existingSessionId, {
							taskInstructions,
							resumeSessionId,
							includeThreadContext: false,
						});
					} catch (error) {
						this.logger.error(
							`Failed to resume ${this.adapter.platformName} session ${existingSessionId}`,
							error instanceof Error ? error : new Error(String(error)),
						);
					}
					return;
				}

				this.logger.info(
					`Previous session ${existingSessionId} for thread ${threadKey} is missing, creating new session`,
				);
			}

			// No session exists for this thread. Only events explicitly allowed to
			// start a session may do so — e.g. a Slack @mention. A plain follow-up
			// message in an unbound thread must be ignored, otherwise every message
			// in any channel Cyrus can see would spin up a session.
			if (
				!existingSessionId &&
				this.adapter.isSessionInitiatingEvent?.(event) === false
			) {
				this.logger.info(
					`Ignoring non-initiating ${this.adapter.platformName} event for unbound thread ${threadKey}`,
				);
				return;
			}

			const workspace = await this.createWorkspace(threadKey);
			if (!workspace) {
				this.logger.error(
					`Failed to create workspace for ${this.adapter.platformName} thread ${threadKey}`,
				);
				return;
			}

			this.logger.info(
				`${this.adapter.platformName} workspace created at: ${workspace.path}`,
			);

			const sessionId = this.buildSessionId(event, threadKey);
			this.sessionManager.createChatSession(
				sessionId,
				workspace,
				this.adapter.platformName,
			);

			const session = this.sessionManager.getSession(sessionId);
			if (!session) {
				this.logger.error(
					`Failed to create session for ${this.adapter.platformName} webhook ${eventId}`,
				);
				return;
			}

			this.bindThreadToSession(threadKey, sessionId);
			session.metadata = {
				...session.metadata,
				surface: this.adapter.platformName,
				bindingKey: threadKey,
				eventId,
			};

			await this.startSession(event, session, sessionId, {
				taskInstructions,
				includeThreadContext: true,
			});
		} catch (error) {
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	private resolveExistingSessionId(
		event: TEvent,
		threadKey: string,
	): string | undefined {
		const boundSessionId = this.threadSessions.get(threadKey);
		if (boundSessionId) {
			this.managedSessionIds.add(boundSessionId);
			return boundSessionId;
		}

		const stableSessionId = this.adapter.getSessionId?.(event, threadKey);
		if (!stableSessionId) {
			return undefined;
		}

		if (!this.sessionManager.getSession(stableSessionId)) {
			return undefined;
		}

		this.bindThreadToSession(threadKey, stableSessionId);
		return stableSessionId;
	}

	private bindThreadToSession(threadKey: string, sessionId: string): void {
		this.threadSessions.set(threadKey, sessionId);
		this.managedSessionIds.add(sessionId);
	}

	private buildSessionId(event: TEvent, threadKey: string): string {
		return (
			this.adapter.getSessionId?.(event, threadKey) ??
			`${this.adapter.platformName}-${this.adapter.getEventId(event)}`
		);
	}

	private getRunnerSessionId(session: CyrusAgentSession): string | undefined {
		return (
			session.claudeSessionId ??
			session.geminiSessionId ??
			session.codexSessionId ??
			session.cursorSessionId
		);
	}

	private async stopSession(
		event: TEvent,
		threadKey: string,
		sessionId: string | undefined,
	): Promise<void> {
		if (!sessionId) {
			this.logger.info(
				`Ignoring stop request for unbound ${this.adapter.platformName} thread ${threadKey}`,
			);
			return;
		}

		const runner = this.sessionManager.getAgentRunner(sessionId);
		this.sessionManager.requestSessionStop(sessionId);
		this.clearPendingReplies(sessionId);

		if (runner?.isRunning()) {
			runner.stop();
		}

		await this.adapter.notifyStopped?.(event, threadKey);
		this.adapter.acknowledgeProcessed?.(event).catch((err: unknown) => {
			this.logger.warn(
				`Failed to acknowledge processed ${this.adapter.platformName} stop event: ${err instanceof Error ? err.message : err}`,
			);
		});
		await this.deps.onStateChange();
	}

	private async startSession(
		event: TEvent,
		session: CyrusAgentSession,
		sessionId: string,
		options: {
			taskInstructions: string;
			resumeSessionId?: string;
			includeThreadContext: boolean;
		},
	): Promise<void> {
		const systemPrompt = this.adapter.buildSystemPrompt(event);
		const runnerConfig = this.buildRunnerConfig(
			session.workspace.path,
			sessionId,
			systemPrompt,
			sessionId,
			options.resumeSessionId,
		);
		const runner = this.deps.createRunner(runnerConfig);

		this.sessionManager.addAgentRunner(sessionId, runner);
		await this.deps.onStateChange();

		const threadContext = options.includeThreadContext
			? await this.adapter.fetchThreadContext(event)
			: "";
		const userPrompt = threadContext
			? `${threadContext}\n\n${options.taskInstructions}`
			: options.taskInstructions;

		const eventId = this.adapter.getEventId(event);
		this.logger.info(
			options.resumeSessionId
				? `Resuming runner for ${this.adapter.platformName} event ${eventId}`
				: `Starting runner for ${this.adapter.platformName} event ${eventId}`,
		);

		this.enqueueReply(sessionId, event);
		const startPromise =
			runner.supportsStreamingInput && runner.startStreaming
				? runner.startStreaming(userPrompt)
				: runner.start(userPrompt);
		startPromise
			.then((sessionInfo: AgentSessionInfo) => {
				this.logger.info(
					options.resumeSessionId
						? `${this.adapter.platformName} session resumed: ${sessionInfo.sessionId} (was ${options.resumeSessionId})`
						: `${this.adapter.platformName} session started: ${sessionInfo.sessionId}`,
				);
			})
			.catch((error: unknown) => {
				this.logger.error(
					options.resumeSessionId
						? `${this.adapter.platformName} resume session error for ${sessionId}`
						: `${this.adapter.platformName} session error for event ${eventId}`,
					error instanceof Error ? error : new Error(String(error)),
				);
				this.clearPendingReplies(sessionId);
			})
			.finally(() => {
				this.deps.onStateChange().catch((error: unknown) => {
					this.logger.error(
						`onStateChange failed after ${this.adapter.platformName} session ${sessionId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
				});
			});
	}

	/** Returns true if any runner managed by this service is currently busy */
	isAnyRunnerBusy(): boolean {
		for (const runner of this.getAllRunners()) {
			if (runner.isRunning()) {
				return true;
			}
		}
		return false;
	}

	/** Returns all runners managed by this service (for shutdown) */
	getAllRunners(): IAgentRunner[] {
		return Array.from(this.managedSessionIds)
			.map((sessionId) => this.sessionManager.getAgentRunner(sessionId))
			.filter((runner): runner is IAgentRunner => runner !== undefined);
	}

	/**
	 * Test/inspection: list all known thread keys and their session IDs.
	 * Used by F1 to discover chat sessions for follow-up prompts and replay.
	 */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, sessionId]) => ({ threadKey, sessionId }),
		);
	}

	/**
	 * Test/inspection: resolve a chat thread to its runner. Returns undefined
	 * when the thread is unknown or the runner has been disposed.
	 */
	getRunnerForThread(threadKey: string): IAgentRunner | undefined {
		const sessionId = this.threadSessions.get(threadKey);
		if (!sessionId) return undefined;
		return this.sessionManager.getAgentRunner(sessionId);
	}

	/**
	 * Handle agent messages for surface sessions.
	 * Routes through the shared AgentSessionManager, and posts a reply when the
	 * SDK emits a `result` message (signalling turn completion).
	 */
	private async handleAgentMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		await this.sessionManager.handleClaudeMessage(sessionId, message);

		if (message.type === "result") {
			// A `result` ends the turn, and the turn has seen every prompt
			// injected so far — drain the whole queue, not just one entry
			// (quick-succession messages get merged into a single turn).
			const events = this.drainReplies(sessionId);
			const runner = this.sessionManager.getAgentRunner(sessionId);
			// Queue already drained by an earlier merged turn? The reply still
			// belongs to this session's thread — post it via the last event.
			const replyEvent = events[0] ?? this.lastReplyEvent.get(sessionId);
			if (replyEvent && runner) {
				try {
					await this.adapter.postReply(replyEvent, runner);
				} catch (error) {
					this.logger.error(
						`Failed to post ${this.adapter.platformName} reply for session ${sessionId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
				// Fire-and-forget processed acknowledgement for every drained
				// event (e.g., swap the receipt reaction) — runs even when
				// postReply stayed silent.
				for (const event of events) {
					this.adapter.acknowledgeProcessed?.(event).catch((err: unknown) => {
						this.logger.warn(
							`Failed to acknowledge processed ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
						);
					});
				}
			} else if (!replyEvent) {
				this.logger.warn(
					`Received result for session ${sessionId} with no pending reply event — nothing to post`,
				);
			}
		}
	}

	private enqueueReply(sessionId: string, event: TEvent): void {
		const queue = this.pendingReplyEvents.get(sessionId) ?? [];
		queue.push(event);
		this.pendingReplyEvents.set(sessionId, queue);
		this.lastReplyEvent.set(sessionId, event);
	}

	private drainReplies(sessionId: string): TEvent[] {
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return [];
		this.pendingReplyEvents.delete(sessionId);
		return queue;
	}

	/**
	 * Discard all queued reply events for a session. Called when the runner
	 * rejects before emitting a final `result` — without this, a later
	 * startSession() on the same sessionId would pair the stale events with
	 * the first `result` of the new runner.
	 */
	private clearPendingReplies(sessionId: string): void {
		this.lastReplyEvent.delete(sessionId);
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return;
		this.logger.warn(
			`Discarding ${queue.length} pending ${this.adapter.platformName} reply event(s) for session ${sessionId} after runner error`,
		);
		this.pendingReplyEvents.delete(sessionId);
	}

	/**
	 * Create an empty workspace directory for a surface thread.
	 * Unlike repository-associated sessions, surface sessions use plain directories (not git worktrees).
	 */
	private async createWorkspace(
		threadKey: string,
	): Promise<{ path: string; isGitWorktree: boolean } | null> {
		try {
			const sanitizedKey = threadKey.replace(/[^a-zA-Z0-9.-]/g, "_");
			const workspacePath = join(
				this.deps.cyrusHome,
				`${this.adapter.platformName}-workspaces`,
				sanitizedKey,
			);

			await mkdir(workspacePath, { recursive: true });

			return { path: workspacePath, isGitWorktree: false };
		} catch (error) {
			this.logger.error(
				`Failed to create ${this.adapter.platformName} workspace for thread ${threadKey}`,
				error instanceof Error ? error : new Error(String(error)),
			);
			return null;
		}
	}

	/**
	 * Build a runner config for a surface session.
	 * Delegates to RunnerConfigBuilder for config assembly.
	 */
	private buildRunnerConfig(
		workspacePath: string,
		workspaceName: string | undefined,
		systemPrompt: string,
		sessionId: string,
		resumeSessionId?: string,
	): AgentRunnerConfig {
		const sessionLogger = this.logger.withContext({
			sessionId,
			platform: this.adapter.platformName,
		});

		// Read live values from the provider at session-build time
		const provider = this.deps.repositoryProvider;

		return this.deps.runnerConfigBuilder.buildChatConfig({
			workspacePath,
			workspaceName,
			systemPrompt,
			sessionId,
			resumeSessionId,
			cyrusHome: this.deps.cyrusHome,
			platformName: this.adapter.platformName,
			linearWorkspaceId: provider.getDefaultLinearWorkspaceId(),
			repository: provider.getDefaultRepository(),
			repositoryPaths: provider.getRepositoryPaths(),
			platformMcpConfigOverrides: this.deps.getPlatformMcpConfigOverrides?.(),
			logger: sessionLogger,
			onMessage: (message: SDKMessage) =>
				this.handleAgentMessage(sessionId, message),
			onError: (error: Error) => this.deps.onClaudeError(error),
		});
	}
}
