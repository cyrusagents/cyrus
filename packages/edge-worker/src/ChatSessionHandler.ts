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
import { AgentSessionManager } from "./AgentSessionManager.js";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { RunnerConfigBuilder } from "./RunnerConfigBuilder.js";

/**
 * Defines what each chat platform must provide for the generic session lifecycle.
 *
 * Implementations are stateless data mappers — they translate platform-specific
 * events into the common operations the ChatSessionHandler needs.
 */
/** Platform identifiers supported by the session manager */
export type ChatPlatformName = "slack" | "linear" | "github";

export interface ChatPlatformAdapter<TEvent> {
	readonly platformName: ChatPlatformName;

	/** Extract the user's task text from the raw event */
	extractTaskInstructions(event: TEvent): string;

	/** Derive a unique thread key for session tracking (e.g., "C123:1704110400.000100") */
	getThreadKey(event: TEvent): string;

	/** Get the unique event ID */
	getEventId(event: TEvent): string;

	/** Build a platform-specific system prompt */
	buildSystemPrompt(event: TEvent): string;

	/** Fetch thread context as formatted string. Returns "" if not applicable */
	fetchThreadContext(event: TEvent): Promise<string>;

	/** Post the agent's final response back to the platform */
	postReply(event: TEvent, runner: IAgentRunner): Promise<void>;

	/** Acknowledge receipt of the event (e.g., emoji reaction). Fire-and-forget */
	acknowledgeReceipt(event: TEvent): Promise<void>;

	/** Notify the user that a previous request is still processing */
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;

	/**
	 * Notify the user that Cyrus can't start a new session right now (e.g.
	 * host is under memory pressure or at concurrency cap). Expected to
	 * post a user-visible message back to the platform.
	 */
	notifyUnavailable(
		event: TEvent,
		threadKey: string,
		message: string,
	): Promise<void>;
}

/**
 * Callbacks for EdgeWorker integration (same pattern as RepositoryRouterDeps).
 */
export interface ChatSessionHandlerDeps {
	cyrusHome: string;
	/** Provider for live repository paths, default repo, and workspace ID */
	chatRepositoryProvider: ChatRepositoryProvider;
	/** Shared RunnerConfigBuilder for constructing runner configs */
	runnerConfigBuilder: RunnerConfigBuilder;
	/** Factory function that creates the appropriate runner based on config.defaultRunner */
	createRunner: (config: AgentRunnerConfig) => IAgentRunner;
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onStateChange: () => Promise<void>;
	onClaudeError: (error: Error) => void;
	/**
	 * Optional pre-flight gate evaluated before spawning a new runner.
	 * Return `{ ok: true }` to proceed, or `{ ok: false, userMessage }`
	 * to reject with a user-facing message. If omitted, no gating occurs.
	 */
	checkRunnerGate?: () => { ok: true } | { ok: false; userMessage: string };
}

/**
 * Generic session lifecycle engine for chat platform integrations.
 *
 * Manages the create/resume/inject/reply session lifecycle independent of any
 * specific chat platform. Platform-specific behavior is provided via a
 * ChatPlatformAdapter.
 */
export class ChatSessionHandler<TEvent> {
	private adapter: ChatPlatformAdapter<TEvent>;
	private sessionManager: AgentSessionManager;
	private threadSessions: Map<string, string> = new Map();
	private deps: ChatSessionHandlerDeps;
	private logger: ILogger;
	// FIFO queue of events awaiting a reply, keyed by sessionId. Each entry is
	// enqueued when a new prompt (initial/resume/follow-up-inject) is sent to
	// the runner, and consumed when the corresponding `result` message arrives
	// on the runner's message stream. This decouples reply posting from
	// `startStreaming()` resolution, which never resolves when warm sessions
	// hold the streaming prompt open across turns.
	private pendingReplyEvents: Map<string, TEvent[]> = new Map();

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: ChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger = logger ?? createLogger({ component: "ChatSessionHandler" });

		// Initialize a dedicated AgentSessionManager (not tied to any repository)
		this.sessionManager = new AgentSessionManager(
			undefined, // No parent session lookup
			undefined, // No resume parent session
		);
	}

	/**
	 * Main entry point — handles a single chat platform event.
	 *
	 * Replaces the per-platform handleXxxWebhook method in EdgeWorker.
	 */
	async handleEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();

		try {
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${this.adapter.getEventId(event)}`,
			);

			// Fire-and-forget acknowledgement (e.g., emoji reaction)
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			const taskInstructions = this.adapter.extractTaskInstructions(event);
			const threadKey = this.adapter.getThreadKey(event);

			// Check if there's already an active session for this thread
			const existingSessionId = this.threadSessions.get(threadKey);
			if (existingSessionId) {
				const existingSession =
					this.sessionManager.getSession(existingSessionId);
				const existingRunner =
					this.sessionManager.getAgentRunner(existingSessionId);

				if (existingSession && existingRunner?.isRunning()) {
					// Session is actively running — inject the follow-up via streaming input
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
						// Runner doesn't support streaming input or isn't in streaming mode — notify user
						this.logger.info(
							`Session ${existingSessionId} is still running, notifying user (thread ${threadKey})`,
						);
						await this.adapter.notifyBusy(event, threadKey);
					}
					return;
				}

				if (existingSession && existingRunner) {
					// Session exists but is not running — resume with --continue
					this.logger.info(
						`Resuming completed ${this.adapter.platformName} session ${existingSessionId} (thread ${threadKey})`,
					);

					const resumeSessionId =
						existingSession.claudeSessionId || existingSession.geminiSessionId;

					if (resumeSessionId) {
						try {
							await this.resumeSession(
								event,
								existingSession,
								existingSessionId,
								resumeSessionId,
								taskInstructions,
							);
						} catch (error) {
							this.logger.error(
								`Failed to resume ${this.adapter.platformName} session ${existingSessionId}`,
								error instanceof Error ? error : new Error(String(error)),
							);
						}
						return;
					}
				}

				// Session exists but runner was lost — fall through to create a new session
				this.logger.info(
					`Previous session ${existingSessionId} for thread ${threadKey} has no runner, creating new session`,
				);
			}

			// Pre-flight memory/concurrency gate — reject before spawning
			if (this.deps.checkRunnerGate) {
				const gate = this.deps.checkRunnerGate();
				if (!gate.ok) {
					await this.adapter.notifyUnavailable(
						event,
						threadKey,
						gate.userMessage,
					);
					return;
				}
			}

			// Create an empty workspace directory for this thread
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

			// Create a chat session (not tied to any issue or repository)
			const eventId = this.adapter.getEventId(event);
			const sessionId = `${this.adapter.platformName}-${eventId}`;
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

			// Track this thread → session mapping for follow-up messages
			this.threadSessions.set(threadKey, sessionId);

			// Initialize session metadata
			if (!session.metadata) {
				session.metadata = {};
			}

			// Build the system prompt
			const systemPrompt = this.adapter.buildSystemPrompt(event);

			// Build runner config
			const runnerConfig = this.buildRunnerConfig(
				session.workspace.path,
				sessionId,
				systemPrompt,
				sessionId,
			);

			const runner = this.deps.createRunner(runnerConfig);

			// Store the runner in the session manager
			this.sessionManager.addAgentRunner(sessionId, runner);

			// Save persisted state
			await this.deps.onStateChange();

			// Fetch thread context for threaded mentions
			const threadContext = await this.adapter.fetchThreadContext(event);
			const userPrompt = threadContext
				? `${threadContext}\n\n${taskInstructions}`
				: taskInstructions;

			this.logger.info(
				`Starting runner for ${this.adapter.platformName} event ${eventId}`,
			);

			// Start in streaming mode if supported (allows follow-up message injection),
			// otherwise fall back to non-streaming start.
			//
			// Reply posting happens from handleAgentMessage() when a `result`
			// message arrives on the runner's stream — we do NOT await turn
			// completion here, because with warm sessions the streaming prompt
			// stays open and the start() promise doesn't resolve until the
			// whole session ends.
			this.enqueueReply(sessionId, event);
			const startPromise =
				runner.supportsStreamingInput && runner.startStreaming
					? runner.startStreaming(userPrompt)
					: runner.start(userPrompt);
			startPromise
				.then((sessionInfo: AgentSessionInfo) => {
					this.logger.info(
						`${this.adapter.platformName} session started: ${sessionInfo.sessionId}`,
					);
				})
				.catch((error: unknown) => {
					this.logger.error(
						`${this.adapter.platformName} session error for event ${eventId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
					// Runner died before emitting a final `result`. Drop any
					// still-queued reply events for this session so a later
					// resumeSession() doesn't pair them with a future turn.
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
		} catch (error) {
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	/** Returns true if any runner managed by this handler is currently busy */
	isAnyRunnerBusy(): boolean {
		for (const runner of this.sessionManager.getAllAgentRunners()) {
			if (runner.isRunning()) {
				return true;
			}
		}
		return false;
	}

	/** Returns all runners managed by this handler (for shutdown) */
	getAllRunners(): IAgentRunner[] {
		return this.sessionManager.getAllAgentRunners();
	}

	/**
	 * Resume an existing session with a new prompt (--continue behavior).
	 */
	private async resumeSession(
		event: TEvent,
		existingSession: CyrusAgentSession,
		sessionId: string,
		resumeSessionId: string,
		taskInstructions: string,
	): Promise<void> {
		// Pre-flight memory/concurrency gate — reject before spawning
		if (this.deps.checkRunnerGate) {
			const gate = this.deps.checkRunnerGate();
			if (!gate.ok) {
				const threadKey = this.adapter.getThreadKey(event);
				await this.adapter.notifyUnavailable(
					event,
					threadKey,
					gate.userMessage,
				);
				return;
			}
		}

		const systemPrompt = this.adapter.buildSystemPrompt(event);

		const runnerConfig = this.buildRunnerConfig(
			existingSession.workspace.path,
			sessionId,
			systemPrompt,
			sessionId,
			resumeSessionId,
		);

		const runner = this.deps.createRunner(runnerConfig);
		this.sessionManager.addAgentRunner(sessionId, runner);

		// Reply posting is driven by `result` messages on the runner's stream
		// (see handleAgentMessage). We must not await turn completion here —
		// warm sessions hold the streaming prompt open across turns so the
		// start() promise only resolves when the whole session ends.
		this.enqueueReply(sessionId, event);
		const startPromise =
			runner.supportsStreamingInput && runner.startStreaming
				? runner.startStreaming(taskInstructions)
				: runner.start(taskInstructions);
		startPromise
			.then((sessionInfo: AgentSessionInfo) => {
				this.logger.info(
					`${this.adapter.platformName} session resumed: ${sessionInfo.sessionId} (was ${resumeSessionId})`,
				);
			})
			.catch((error: unknown) => {
				this.logger.error(
					`${this.adapter.platformName} resume session error for ${sessionId}`,
					error instanceof Error ? error : new Error(String(error)),
				);
				this.clearPendingReplies(sessionId);
			});
	}

	/**
	 * Handle agent messages for chat sessions.
	 * Routes to the dedicated AgentSessionManager, and posts a reply when the
	 * SDK emits a `result` message (signalling turn completion).
	 */
	private async handleAgentMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		await this.sessionManager.handleClaudeMessage(sessionId, message);

		if (message.type === "result") {
			const event = this.dequeueReply(sessionId);
			const runner = this.sessionManager.getAgentRunner(sessionId);
			if (event && runner) {
				try {
					await this.adapter.postReply(event, runner);
				} catch (error) {
					this.logger.error(
						`Failed to post ${this.adapter.platformName} reply for session ${sessionId}`,
						error instanceof Error ? error : new Error(String(error)),
					);
				}
			} else if (!event) {
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
	}

	private dequeueReply(sessionId: string): TEvent | undefined {
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return undefined;
		const event = queue.shift();
		if (queue.length === 0) {
			this.pendingReplyEvents.delete(sessionId);
		}
		return event;
	}

	/**
	 * Discard all queued reply events for a session. Called when the runner
	 * rejects before emitting a final `result` — without this, a later
	 * resumeSession() on the same sessionId would pair the stale event with
	 * the first `result` of the new runner and shift all subsequent replies
	 * by one turn.
	 */
	private clearPendingReplies(sessionId: string): void {
		const queue = this.pendingReplyEvents.get(sessionId);
		if (!queue || queue.length === 0) return;
		this.logger.warn(
			`Discarding ${queue.length} pending ${this.adapter.platformName} reply event(s) for session ${sessionId} after runner error`,
		);
		this.pendingReplyEvents.delete(sessionId);
	}

	/**
	 * Create an empty workspace directory for a chat thread.
	 * Unlike repository-associated sessions, chat sessions use plain directories (not git worktrees).
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
	 * Build a runner config for a chat session.
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
		const provider = this.deps.chatRepositoryProvider;

		return this.deps.runnerConfigBuilder.buildChatConfig({
			workspacePath,
			workspaceName,
			systemPrompt,
			sessionId,
			resumeSessionId,
			cyrusHome: this.deps.cyrusHome,
			linearWorkspaceId: provider.getDefaultLinearWorkspaceId(),
			repository: provider.getDefaultRepository(),
			repositoryPaths: provider.getRepositoryPaths(),
			logger: sessionLogger,
			onMessage: (message: SDKMessage) =>
				this.handleAgentMessage(sessionId, message),
			onError: (error: Error) => this.deps.onClaudeError(error),
		});
	}
}
