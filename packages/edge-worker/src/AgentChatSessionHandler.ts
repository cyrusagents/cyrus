import type {
	AgentSession,
	CreateAgentSessionConfig,
	TranscriptEvent,
} from "cyrus-agent-runtime";
import { createAgentSession } from "cyrus-agent-runtime";
import type { ILogger, ProviderType } from "cyrus-core";
import { createLogger } from "cyrus-core";

/**
 * Generic chat platform adapter for the agent-runtime-backed handler.
 *
 * NOTE: `postReply` here takes a plain string (the final assistant text
 * extracted by the harness adapter), not an `IAgentRunner`. This decouples
 * platform adapters from the runner machinery — they only need to know how
 * to convert agent output back into a platform message.
 */
export type ChatPlatformName = "slack" | "linear" | "github";

export interface ChatPlatformAdapter<TEvent> {
	readonly platformName: ChatPlatformName;
	extractTaskInstructions(event: TEvent): string;
	getThreadKey(event: TEvent): string;
	getEventId(event: TEvent): string;
	buildSystemPrompt(event: TEvent): string;
	fetchThreadContext(event: TEvent): Promise<string>;
	postReply(event: TEvent, finalText: string): Promise<void>;
	acknowledgeReceipt(event: TEvent): Promise<void>;
	notifyBusy(event: TEvent, threadKey: string): Promise<void>;
}

export interface AgentChatSessionHandlerDeps {
	onWebhookStart: () => void;
	onWebhookEnd: () => void;
	onError: (error: Error) => void;
	/**
	 * How long a thread's warm session can sit idle before the handler
	 * destroys it (sandbox torn down, slot freed). Default 15 minutes.
	 * Next mention after eviction starts a fresh sandbox + fresh Claude
	 * session.
	 */
	idleTtlMs?: number;
	/**
	 * Sandbox provider to run sessions in. Defaults to `"local"`.
	 *
	 * - `"local"`: harness runs directly on the host. The host must have
	 *   `claude` on `PATH` (or `claudeCliPath` set). No `DAYTONA_API_KEY`
	 *   required. `destroyWhileInactive` is a no-op for this provider.
	 * - `"daytona"`: each thread gets a Daytona sandbox. Requires
	 *   `DAYTONA_API_KEY` in the environment; Claude CLI is installed
	 *   inside the sandbox via `npm install -g`. Idle sandboxes are
	 *   paused between turns (preserving on-disk state for `--continue`)
	 *   and destroyed after the idle TTL.
	 */
	provider?: ProviderType;
	/**
	 * Override the `claude` binary path for local sessions. When unset,
	 * the harness resolves `claude` via the host's `PATH`. Ignored for
	 * the daytona provider, which always uses the in-sandbox install
	 * path.
	 */
	claudeCliPath?: string;
}

const DEFAULT_IDLE_TTL_MS = 15 * 60 * 1000; // 15 minutes

// Default Daytona working directory — matches the directory used in the
// streaming spike that validated this end-to-end. Daytona's container puts
// the user at /home/daytona.
const DAYTONA_WORKING_DIR = "/home/daytona";

// Where claude lands after `npm install -g` with our custom npm prefix.
const CLAUDE_CLI_PATH = `${DAYTONA_WORKING_DIR}/.npm-global/bin/claude`;

// Setup commands that run inside the fresh Daytona sandbox before the
// harness invocation. Each runs via the sandbox's default shell PATH.
const DAYTONA_CLAUDE_SETUP_COMMANDS = [
	`npm config set prefix ${DAYTONA_WORKING_DIR}/.npm-global`,
	"npm install -g @anthropic-ai/claude-code@latest >/dev/null 2>&1",
	`${CLAUDE_CLI_PATH} --version`,
];

/**
 * Discriminated union of the two Claude auth modes the handler accepts.
 * They are NOT interchangeable — Claude Code treats them as different
 * sources with different billing semantics, so we preserve which one
 * came in and forward only that env var to the harness.
 *
 * - `oauth`: token from `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code Pro/Max
 *   subscription).
 * - `apiKey`: key from `ANTHROPIC_API_KEY` (direct Anthropic API
 *   access).
 */
type ClaudeCredential =
	| { kind: "oauth"; token: string }
	| { kind: "apiKey"; token: string };

function readClaudeCredential(): ClaudeCredential | undefined {
	// OAuth takes precedence: subscription users running Claude Code
	// against their plan generally want that to be the active path
	// even if an `ANTHROPIC_API_KEY` happens to be set in the env.
	const oauth = process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
	if (oauth) return { kind: "oauth", token: oauth };
	const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
	if (apiKey) return { kind: "apiKey", token: apiKey };
	return undefined;
}

// Guard against multiple compute.setConfig() calls — ComputeSDK uses a
// module-global config so we only need to set it once per process.
let computeConfigured = false;

async function configureDaytonaCompute(apiKey: string): Promise<void> {
	if (computeConfigured) return;
	const { daytona } = await import("@computesdk/daytona");
	const { compute } = await import("computesdk");
	compute.setConfig({
		provider: daytona({ apiKey, timeout: 300_000 }),
	});
	computeConfigured = true;
}

interface ThreadState<TEvent> {
	session: AgentSession;
	lastActivityAt: number;
	/**
	 * In-flight run promise, if any. Used so a second webhook for the
	 * same thread can detect "busy" without racing on session.run().
	 */
	inFlight?: Promise<unknown>;
	/** Last event the handler answered for; used as the busy-notify target. */
	lastEvent: TEvent;
}

/**
 * Chat-session handler built on top of `cyrus-agent-runtime`'s
 * `createAgentSession` + multi-turn `session.run()`. Replaces the old
 * `ChatSessionHandler` + `IAgentRunner` + `AgentSessionManager` stack.
 *
 * Provider-aware: each handler instance is configured for either the
 * `local` or `daytona` sandbox provider via `deps.provider` (defaulting
 * to `local`). The first message in a thread creates a fresh agent
 * session against that provider; follow-up messages reuse it via
 * Claude's `--continue` flag. After `idleTtlMs` of inactivity the
 * handler destroys the session and frees the slot.
 *
 * **Provider details**
 *
 * - **local** — harness runs directly on the host. The host must have
 *   `claude` reachable via `PATH` (or pass `deps.claudeCliPath`).
 *   `destroyWhileInactive` is a no-op; eviction still calls
 *   `session.destroy()` to clean up the per-session HOME under
 *   `~/.cyrus-agent-sessions/`.
 *
 * - **daytona** — each thread gets a Daytona sandbox seeded with
 *   `@anthropic-ai/claude-code` via `npm install -g`. Requires
 *   `DAYTONA_API_KEY`. Idle sandboxes are paused between turns
 *   (`destroyWhileInactive: true`) so on-disk state survives but
 *   compute is freed; eviction destroys them outright.
 *
 * **Common requirements**
 *
 * - One of `CLAUDE_CODE_OAUTH_TOKEN` (Claude Code subscription OAuth)
 *   or `ANTHROPIC_API_KEY` (direct Anthropic API access). The handler
 *   forwards exactly the env var that was set — these are distinct
 *   auth modes in Claude Code with different billing semantics, so
 *   we never set both. `CLAUDE_CODE_OAUTH_TOKEN` wins if both are
 *   present.
 *
 * **Known limitations**
 *
 * - **No mid-flight stream injection.** A second message while the
 *   thread's session is still answering the first triggers
 *   `notifyBusy()` rather than injecting into stdin. Future work:
 *   route through `AgentSession.addMessage()` with
 *   `interactiveInput: true`.
 * - **No MCP servers.** `cyrus-agent-runtime` doesn't yet thread them
 *   through to the harness CLI; the cyrus-tools in-process SDK
 *   server wouldn't translate across the subprocess boundary anyway.
 *   Chat sessions run with the Claude CLI default toolset only.
 * - **Claude harness only.** No runner-selection layer for chat yet.
 * - **No cross-process recovery.** EdgeWorker restart drops the
 *   warm-thread map; next mention is a cold start. Daytona's own
 *   `autoStopInterval` eventually reclaims any orphaned sandboxes.
 */
export class AgentChatSessionHandler<TEvent> {
	private readonly adapter: ChatPlatformAdapter<TEvent>;
	private readonly deps: AgentChatSessionHandlerDeps;
	private readonly logger: ILogger;
	private readonly threadSessions = new Map<string, ThreadState<TEvent>>();
	private readonly provider: ProviderType;
	private readonly daytonaApiKey: string | undefined;
	private readonly claudeCliPath: string | undefined;
	private readonly idleTtlMs: number;
	private idleSweepTimer?: NodeJS.Timeout;
	private shuttingDown = false;

	constructor(
		adapter: ChatPlatformAdapter<TEvent>,
		deps: AgentChatSessionHandlerDeps,
		logger?: ILogger,
	) {
		this.adapter = adapter;
		this.deps = deps;
		this.logger =
			logger ?? createLogger({ component: "AgentChatSessionHandler" });

		this.provider = deps.provider ?? "local";
		this.claudeCliPath = deps.claudeCliPath?.trim() || undefined;

		if (this.provider === "daytona") {
			const apiKey = process.env.DAYTONA_API_KEY?.trim();
			if (!apiKey) {
				throw new Error(
					"AgentChatSessionHandler with provider='daytona' requires DAYTONA_API_KEY " +
						"in the environment. Set it before starting Cyrus, switch to " +
						"provider='local', or disable the chat integration.",
				);
			}
			this.daytonaApiKey = apiKey;
		} else {
			this.daytonaApiKey = undefined;
		}

		this.idleTtlMs = deps.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;

		// Sweep every minute; sweep work is cheap (just a map iteration + maybe
		// a destroy() per expired entry).
		this.idleSweepTimer = setInterval(() => {
			void this.sweepIdle();
		}, 60_000);
		this.idleSweepTimer.unref?.();
	}

	/** Returns true if any thread on this handler has an in-flight session. */
	isAnyRunnerBusy(): boolean {
		for (const state of this.threadSessions.values()) {
			if (state.inFlight) return true;
		}
		return false;
	}

	/** Test/inspection: enumerate active threads. */
	listThreads(): Array<{ threadKey: string; sessionId: string }> {
		return Array.from(this.threadSessions.entries()).map(
			([threadKey, state]) => ({
				threadKey,
				sessionId: state.session.sessionId,
			}),
		);
	}

	async handleEvent(event: TEvent): Promise<void> {
		this.deps.onWebhookStart();
		try {
			const eventId = this.adapter.getEventId(event);
			const threadKey = this.adapter.getThreadKey(event);
			this.logger.info(
				`Processing ${this.adapter.platformName} webhook: ${eventId} (thread ${threadKey})`,
			);

			// Fire-and-forget acknowledgement (e.g. emoji reaction).
			this.adapter.acknowledgeReceipt(event).catch((err: unknown) => {
				this.logger.warn(
					`Failed to acknowledge ${this.adapter.platformName} event: ${err instanceof Error ? err.message : err}`,
				);
			});

			// Busy thread → notify and bail. No stdin injection today.
			const existing = this.threadSessions.get(threadKey);
			if (existing?.inFlight) {
				this.logger.info(
					`Thread ${threadKey} has an in-flight session; notifying user.`,
				);
				await this.adapter.notifyBusy(event, threadKey);
				return;
			}

			const credential = readClaudeCredential();
			if (!credential) {
				this.logger.error(
					"Cannot run chat session: no CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY in environment",
				);
				await this.adapter.postReply(
					event,
					"I'm not configured with a Claude credential, so I can't respond. " +
						"Ask your admin to set either CLAUDE_CODE_OAUTH_TOKEN (Claude Code subscription) " +
						"or ANTHROPIC_API_KEY (direct API access).",
				);
				return;
			}

			if (this.provider === "daytona") {
				// Lazy provider init — `daytonaApiKey` is set in the
				// constructor when the provider is "daytona", so the
				// non-null assertion is safe here.
				await configureDaytonaCompute(this.daytonaApiKey as string);
			}

			const taskInstructions = this.adapter.extractTaskInstructions(event);
			const isFirstTurn = !existing;

			// Thread context is injected only on the first turn — subsequent
			// turns are continuations of the same Claude session, which already
			// knows the prior conversation.
			const userPrompt = isFirstTurn
				? await this.buildFirstTurnPrompt(event, taskInstructions)
				: taskInstructions;

			let state: ThreadState<TEvent>;
			if (existing) {
				state = existing;
			} else {
				const systemPrompt = this.adapter.buildSystemPrompt(event);
				const sessionId = `${this.adapter.platformName}-${eventId}`;
				this.logger.info(
					`Creating ${this.provider} AgentSession ${sessionId} for thread ${threadKey}`,
				);
				const sessionConfig = this.buildSessionConfig({
					sessionId,
					threadKey,
					systemPrompt,
					credential,
				});
				const session = await createAgentSession(sessionConfig, {
					callbacks: {
						onTranscriptEvent: (te) => {
							this.logger.debug(`[${sessionId}] transcript event: ${te.kind}`);
						},
					},
				});
				state = {
					session,
					lastActivityAt: Date.now(),
					lastEvent: event,
				};
				this.threadSessions.set(threadKey, state);
			}

			// Mark the run as in-flight so concurrent webhooks see "busy".
			const runPromise = state.session.run(userPrompt);
			state.inFlight = runPromise;
			state.lastEvent = event;

			try {
				const result = await runPromise;
				state.lastActivityAt = Date.now();

				if (!result.success) {
					this.logger.error(
						`Session ${state.session.sessionId} turn did not succeed (exitCode=${result.exitCode})`,
						result.error,
					);
					if (result.error) this.deps.onError(result.error);
					try {
						await this.adapter.postReply(
							event,
							result.error
								? `I hit an error: ${result.error.message}`
								: `I couldn't complete the request (exit code ${result.exitCode}).`,
						);
					} catch (postErr) {
						this.logger.error(
							`Failed to post failure notice for session ${state.session.sessionId}`,
							postErr instanceof Error ? postErr : new Error(String(postErr)),
						);
					}
					// A failed run kills the thread — destroy and free the slot
					// so the next mention starts fresh.
					await this.destroyThread(threadKey);
					return;
				}

				const finalText =
					result.result ?? this.extractAssistantFallback(result.events);
				if (!finalText) {
					this.logger.warn(
						`Session ${state.session.sessionId} completed but produced no result text`,
					);
					return;
				}

				try {
					await this.adapter.postReply(event, finalText);
					this.logger.info(
						`Posted reply for session ${state.session.sessionId}`,
					);
				} catch (postErr) {
					this.logger.error(
						`Failed to post reply for session ${state.session.sessionId}`,
						postErr instanceof Error ? postErr : new Error(String(postErr)),
					);
				}
			} finally {
				state.inFlight = undefined;
			}
		} catch (error) {
			this.logger.error(
				`Failed to process ${this.adapter.platformName} webhook`,
				error instanceof Error ? error : new Error(String(error)),
			);
			this.deps.onError(
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			this.deps.onWebhookEnd();
		}
	}

	/**
	 * Stop the idle sweeper and destroy every warm thread session.
	 */
	async shutdown(): Promise<void> {
		this.shuttingDown = true;
		if (this.idleSweepTimer) {
			clearInterval(this.idleSweepTimer);
			this.idleSweepTimer = undefined;
		}
		const states = Array.from(this.threadSessions.values());
		this.threadSessions.clear();
		await Promise.all(
			states.map(async (state) => {
				try {
					await state.session.destroy();
				} catch (err) {
					this.logger.warn(
						`Failed to destroy session ${state.session.sessionId} during shutdown: ${err instanceof Error ? err.message : err}`,
					);
				}
			}),
		);
	}

	private async buildFirstTurnPrompt(
		event: TEvent,
		taskInstructions: string,
	): Promise<string> {
		const threadContext = await this.adapter.fetchThreadContext(event);
		return threadContext
			? `${threadContext}\n\n${taskInstructions}`
			: taskInstructions;
	}

	/**
	 * Assemble the `CreateAgentSessionConfig` for a fresh thread session.
	 * Provider-specific config (harness path, packages, sandbox shape)
	 * lives here so the rest of `handleEvent` stays provider-agnostic.
	 */
	private buildSessionConfig(args: {
		sessionId: string;
		threadKey: string;
		systemPrompt: string;
		credential: ClaudeCredential;
	}): CreateAgentSessionConfig {
		const { sessionId, threadKey, systemPrompt, credential } = args;
		// Forward exactly the env var the operator actually set. Setting
		// both would be a bug: Claude Code treats `CLAUDE_CODE_OAUTH_TOKEN`
		// (Claude Code subscription OAuth flow) and `ANTHROPIC_API_KEY`
		// (direct Anthropic API access) as distinct auth modes with
		// different billing, so they must not be conflated.
		const secrets: Record<string, string> =
			credential.kind === "oauth"
				? { CLAUDE_CODE_OAUTH_TOKEN: credential.token }
				: { ANTHROPIC_API_KEY: credential.token };

		if (this.provider === "daytona") {
			return {
				sessionId,
				harness: {
					kind: "claude",
					command: CLAUDE_CLI_PATH,
				},
				systemPrompt,
				secrets,
				packages: {
					commands: [...DAYTONA_CLAUDE_SETUP_COMMANDS],
				},
				sandbox: {
					provider: "daytona",
					name: `cyrus-${this.adapter.platformName}-${sessionId}`,
					workingDirectory: DAYTONA_WORKING_DIR,
					timeoutMs: 300_000,
					// Pause the sandbox between turns so we stop paying for
					// idle compute. Daytona preserves on-disk state during
					// stop, so the next turn's `--continue` finds the prior
					// `.claude/` intact.
					destroyWhileInactive: true,
					metadata: {
						purpose: `cyrus-${this.adapter.platformName}-chat`,
						threadKey,
					},
				},
			};
		}

		// Local provider: harness runs on the host. `claude` must be on
		// PATH or `claudeCliPath` must be set. The runtime gives each
		// session its own HOME under `~/.cyrus-agent-sessions/<id>/` so
		// per-thread `.claude/` state persists across `--continue` turns
		// without colliding with the operator's real `~/.claude/`.
		const harnessConfig: CreateAgentSessionConfig["harness"] = {
			kind: "claude",
			...(this.claudeCliPath ? { command: this.claudeCliPath } : {}),
		};
		return {
			sessionId,
			harness: harnessConfig,
			systemPrompt,
			secrets,
			sandbox: {
				provider: "local",
			},
			metadata: {
				purpose: `cyrus-${this.adapter.platformName}-chat`,
				threadKey,
			},
		};
	}

	private async destroyThread(threadKey: string): Promise<void> {
		const state = this.threadSessions.get(threadKey);
		if (!state) return;
		this.threadSessions.delete(threadKey);
		try {
			await state.session.destroy();
		} catch (err) {
			this.logger.warn(
				`Failed to destroy thread ${threadKey} session ${state.session.sessionId}: ${err instanceof Error ? err.message : err}`,
			);
		}
	}

	private async sweepIdle(): Promise<void> {
		if (this.shuttingDown) return;
		const now = Date.now();
		const expired: string[] = [];
		for (const [threadKey, state] of this.threadSessions) {
			if (state.inFlight) continue;
			if (now - state.lastActivityAt >= this.idleTtlMs) {
				expired.push(threadKey);
			}
		}
		for (const threadKey of expired) {
			this.logger.info(
				`Evicting idle thread ${threadKey} after ${Math.round(this.idleTtlMs / 1000)}s of inactivity`,
			);
			await this.destroyThread(threadKey);
		}
	}

	/**
	 * Walk the transcript backwards looking for the last assistant text
	 * block. Used when the harness adapter's `extractResult()` returns
	 * undefined.
	 */
	private extractAssistantFallback(
		events: readonly TranscriptEvent[],
	): string | undefined {
		for (let i = events.length - 1; i >= 0; i -= 1) {
			const e = events[i];
			if (!e) continue;
			const raw = e.raw as
				| {
						type?: string;
						message?: {
							content?: Array<{ type?: string; text?: string }>;
						};
				  }
				| undefined;
			if (raw?.type === "assistant" && raw.message?.content) {
				const block = raw.message.content.find(
					(b) => b.type === "text" && typeof b.text === "string",
				);
				if (block?.text) return block.text;
			}
		}
		return undefined;
	}
}
