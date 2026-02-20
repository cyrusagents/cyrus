import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { McpServerConfig, SDKMessage } from "cyrus-claude-runner";
import { ClaudeRunner, getAllTools } from "cyrus-claude-runner";
import type { CyrusAgentSession, IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import { AgentSessionManager } from "./AgentSessionManager.js";
import { NoopActivitySink } from "./sinks/NoopActivitySink.js";

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
}

/**
 * Callbacks for EdgeWorker integration (same pattern as RepositoryRouterDeps).
 */
export interface ChatSessionHandlerDeps {
	cyrusHome: string;
	defaultModel?: string;
	defaultFallbackModel?: string;
	mcpConfig?: Record<string, McpServerConfig>;
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onStateChange: () => Promise<void>;
	onClaudeError: (error: Error) => void;
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

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: ChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger = logger ?? createLogger({ component: "ChatSessionHandler" });

		// Initialize a dedicated AgentSessionManager (not tied to any repository)
		const activitySink = new NoopActivitySink(adapter.platformName);
		this.sessionManager = new AgentSessionManager(
			activitySink,
			undefined, // No parent session lookup
			undefined, // No resume parent session
			undefined, // No procedure analyzer
			undefined, // No shared application server
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

			// Initialize procedure metadata
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

			const runner = new ClaudeRunner(runnerConfig);

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
				`Starting Claude runner for ${this.adapter.platformName} event ${eventId}`,
			);

			// Start in streaming mode so follow-up messages in the same thread
			// can be injected via addStreamMessage() while the session is running
			try {
				const sessionInfo = await runner.startStreaming!(userPrompt);
				this.logger.info(
					`${this.adapter.platformName} session started: ${sessionInfo.sessionId}`,
				);

				// When session completes, post the reply back
				await this.adapter.postReply(event, runner);
			} catch (error) {
				this.logger.error(
					`${this.adapter.platformName} session error for event ${eventId}`,
					error instanceof Error ? error : new Error(String(error)),
				);
			} finally {
				await this.deps.onStateChange();
			}
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
		const systemPrompt = this.adapter.buildSystemPrompt(event);

		const runnerConfig = this.buildRunnerConfig(
			existingSession.workspace.path,
			sessionId,
			systemPrompt,
			sessionId,
			resumeSessionId,
		);

		const runner = new ClaudeRunner(runnerConfig);
		this.sessionManager.addAgentRunner(sessionId, runner);

		try {
			const sessionInfo = await runner.startStreaming!(taskInstructions);
			this.logger.info(
				`${this.adapter.platformName} session resumed: ${sessionInfo.sessionId} (was ${resumeSessionId})`,
			);

			await this.adapter.postReply(event, runner);
		} catch (error) {
			this.logger.error(
				`${this.adapter.platformName} resume session error for ${sessionId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * Handle Claude messages for chat sessions.
	 * Routes to the dedicated AgentSessionManager.
	 */
	private async handleClaudeMessage(
		sessionId: string,
		message: SDKMessage,
	): Promise<void> {
		await this.sessionManager.handleClaudeMessage(sessionId, message);
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
	 * Build a ClaudeRunner config for a chat session.
	 * Used by both handleEvent (new session) and resumeSession to eliminate duplication.
	 */
	private buildRunnerConfig(
		workspacePath: string,
		workspaceName: string | undefined,
		systemPrompt: string,
		sessionId: string,
		resumeSessionId?: string,
	): {
		workingDirectory: string;
		allowedTools: string[];
		disallowedTools: string[];
		allowedDirectories: string[];
		workspaceName: string | undefined;
		cyrusHome: string;
		appendSystemPrompt: string;
		model: string | undefined;
		fallbackModel: string | undefined;
		mcpConfig?: Record<string, McpServerConfig>;
		resumeSessionId?: string;
		logger: ILogger;
		maxTurns: number;
		onMessage: (message: SDKMessage) => void;
		onError: (error: Error) => void;
	} {
		// When MCP servers are configured, include their tool permissions
		const mcpToolPermissions = this.deps.mcpConfig
			? Object.keys(this.deps.mcpConfig).map((server) => `mcp__${server}`)
			: [];

		return {
			workingDirectory: workspacePath,
			allowedTools: [...getAllTools(), ...mcpToolPermissions],
			disallowedTools: [] as string[],
			allowedDirectories: [workspacePath],
			workspaceName,
			cyrusHome: this.deps.cyrusHome,
			appendSystemPrompt: systemPrompt,
			model: this.deps.defaultModel,
			fallbackModel: this.deps.defaultFallbackModel,
			...(this.deps.mcpConfig ? { mcpConfig: this.deps.mcpConfig } : {}),
			...(resumeSessionId ? { resumeSessionId } : {}),
			logger: this.logger.withContext({
				sessionId,
				platform: this.adapter.platformName,
			}),
			maxTurns: 200,
			onMessage: (message: SDKMessage) => {
				this.handleClaudeMessage(sessionId, message);
			},
			onError: (error: Error) => this.deps.onClaudeError(error),
		};
	}
}
