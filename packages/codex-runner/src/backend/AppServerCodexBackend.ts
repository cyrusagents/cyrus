import { EventEmitter } from "node:events";
import type { SandboxMode } from "@openai/codex-sdk";
import type { CodexConfigOverrides } from "../types.js";
import {
	AppServerClient,
	type AppServerClientFactory,
	type IAppServerClient,
} from "./appServerClient.js";
import {
	type AppServerNotification,
	translateAppServerItem,
} from "./appServerEvents.js";
import { resolveCodexBinary } from "./codexBinary.js";
import type {
	CodexBackend,
	CodexSandboxPolicy,
	CodexUserInput,
	NormalizedUsage,
	ResolvedCodexConfig,
	ResolvedCodexSandbox,
} from "./types.js";

const CLIENT_INFO = { name: "cyrus-codex-runner", version: "1.0.0" };

interface ThreadStartResult {
	thread?: { id?: string };
}

interface TurnStartResult {
	turn?: { id?: string };
}

/**
 * Backend that drives Codex through the persistent `codex app-server` JSON-RPC
 * protocol. The process stays alive across turns and supports injecting input
 * into an active turn via `turn/steer` ({@link supportsSteer} is true).
 */
export class AppServerCodexBackend
	extends EventEmitter
	implements CodexBackend
{
	readonly supportsSteer = true;

	private client: IAppServerClient | null = null;
	private threadId: string | null = null;
	private activeTurnId: string | null = null;
	private turnActive = false;
	private lastUsage: NormalizedUsage = {
		input_tokens: 0,
		output_tokens: 0,
		cached_input_tokens: 0,
	};
	/** Structured-output schema for turns, captured at open() for turn/start. */
	private outputSchema: unknown;
	/** Resolved sandbox decision, captured at open() for thread/turn params. */
	private sandbox: ResolvedCodexSandbox | null = null;

	/** Resolver for the in-flight {@link runTurn} promise. */
	private turnResolve: (() => void) | null = null;
	private turnReject: ((reason: unknown) => void) | null = null;

	/** Watchdog: fails a turn that goes fully silent for too long. */
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly turnIdleTimeoutMs: number;
	private readonly requestTimeoutMs: number | undefined;

	/**
	 * @param clientFactory Overridable transport factory (tests inject a fake to
	 * avoid spawning a process). Defaults to the real {@link AppServerClient}.
	 * @param options.turnIdleTimeoutMs Fail an in-flight turn if the app-server
	 * emits no notifications for this long (default 5min; Codex streams
	 * continuously, so prolonged silence means a wedged turn). 0 disables it.
	 * @param options.requestTimeoutMs Forwarded to the client for control-plane
	 * request timeouts.
	 */
	constructor(
		private readonly clientFactory: AppServerClientFactory = (options) =>
			new AppServerClient(options),
		options?: { turnIdleTimeoutMs?: number; requestTimeoutMs?: number },
	) {
		super();
		this.turnIdleTimeoutMs = options?.turnIdleTimeoutMs ?? 300_000;
		this.requestTimeoutMs = options?.requestTimeoutMs;
	}

	async open(config: ResolvedCodexConfig): Promise<{ threadId: string }> {
		this.outputSchema = config.outputSchema;
		this.sandbox = config.sandbox;
		const binaryPath = resolveCodexBinary(config.codexPath);
		const client = this.clientFactory({
			binaryPath,
			...(config.env ? { env: config.env } : {}),
			...(this.requestTimeoutMs !== undefined
				? { requestTimeoutMs: this.requestTimeoutMs }
				: {}),
		});
		this.client = client;

		client.setNotificationHandler((method, params) =>
			this.onNotification(method as AppServerNotification, params),
		);
		client.setServerRequestHandler((method) => this.onServerRequest(method));
		client.on("exit", () => this.onProcessGone());
		client.on("error", (err) => this.onProcessError(err));
		client.start();

		await client.request("initialize", {
			clientInfo: CLIENT_INFO,
			capabilities: { experimentalApi: true },
		});

		const threadId = config.resumeSessionId
			? await this.resumeThread(config)
			: await this.startThread(config);

		this.threadId = threadId;
		this.emit("event", { kind: "thread-started", threadId });
		return { threadId };
	}

	async runTurn(input: CodexUserInput[]): Promise<void> {
		if (!this.client || !this.threadId) {
			throw new Error("AppServerCodexBackend.runTurn called before open()");
		}
		const turnPromise = new Promise<void>((resolve, reject) => {
			this.turnResolve = resolve;
			this.turnReject = reject;
		});
		this.turnActive = true;
		this.armIdleWatchdog();

		try {
			const sandboxPolicy =
				this.sandbox?.kind === "policy"
					? this.toWireSandboxPolicy(this.sandbox.policy)
					: undefined;
			const result = await this.client.request<TurnStartResult>("turn/start", {
				threadId: this.threadId,
				input: this.toProtocolInput(input),
				...(this.outputSchema !== undefined
					? { outputSchema: this.outputSchema }
					: {}),
				...(sandboxPolicy ? { sandboxPolicy } : {}),
			});
			this.activeTurnId = result?.turn?.id ?? this.activeTurnId;
			// NOTE: the turn is not steerable the instant turn/start returns — the
			// server only accepts turn/steer once it has emitted the `turn/started`
			// notification. The runner is signalled to flush buffered follow-ups
			// from that notification handler, not here.
		} catch (error) {
			this.turnActive = false;
			this.turnResolve = null;
			this.turnReject = null;
			throw error;
		}

		await turnPromise;
	}

	async steer(input: CodexUserInput[]): Promise<void> {
		if (!this.client || !this.threadId) {
			throw new Error("AppServerCodexBackend.steer called before open()");
		}
		if (!this.turnActive || !this.activeTurnId) {
			throw new Error("Cannot steer: no active turn");
		}
		await this.client.request("turn/steer", {
			threadId: this.threadId,
			expectedTurnId: this.activeTurnId,
			input: this.toProtocolInput(input),
		});
	}

	isTurnActive(): boolean {
		// A turn is steerable only once turn/start has returned its id — during
		// the brief turn/start request itself, turnActive is true but there is no
		// id to target yet.
		return this.turnActive && this.activeTurnId !== null;
	}

	async interrupt(): Promise<void> {
		if (!this.client || !this.threadId || !this.activeTurnId) {
			return;
		}
		try {
			await this.client.request("turn/interrupt", {
				threadId: this.threadId,
				turnId: this.activeTurnId,
			});
		} catch {
			// Interrupt is best-effort; the turn may already have ended.
		}
	}

	async close(): Promise<void> {
		const client = this.client;
		this.client = null;
		this.settleTurn(new Error("app-server backend closed"));
		await client?.close();
	}

	// ---- Thread setup -------------------------------------------------------

	private async startThread(config: ResolvedCodexConfig): Promise<string> {
		const result = await this.client?.request<ThreadStartResult>(
			"thread/start",
			this.threadOptionsParams(config),
		);
		const id = result?.thread?.id;
		if (!id) {
			throw new Error("thread/start did not return a thread id");
		}
		return id;
	}

	private async resumeThread(config: ResolvedCodexConfig): Promise<string> {
		const result = await this.client?.request<ThreadStartResult>(
			"thread/resume",
			{
				threadId: config.resumeSessionId,
				...this.threadOptionsParams(config),
			},
		);
		// Resuming returns the same id we asked for; fall back to it defensively.
		return result?.thread?.id ?? config.resumeSessionId ?? "";
	}

	private threadOptionsParams(
		config: ResolvedCodexConfig,
	): Record<string, unknown> {
		return {
			...(config.workingDirectory ? { cwd: config.workingDirectory } : {}),
			approvalPolicy: config.approvalPolicy,
			// thread/start takes only the coarse mode; the granular `policy` arm is
			// applied via `turn/start.sandboxPolicy` (so we send a matching baseline
			// mode here and let the turn policy refine it).
			sandbox: this.threadSandboxMode(config.sandbox),
			...(config.model ? { model: config.model } : {}),
			...(config.developerInstructions
				? { developerInstructions: config.developerInstructions }
				: {}),
			config: this.buildThreadConfig(config),
		};
	}

	/** Coarse `thread/start.sandbox` mode for the resolved sandbox. */
	private threadSandboxMode(sandbox: ResolvedCodexSandbox): SandboxMode {
		if (sandbox.kind === "workspace-mode") {
			return sandbox.mode;
		}
		switch (sandbox.policy.type) {
			case "dangerFullAccess":
				return "danger-full-access";
			case "readOnly":
				return "read-only";
			default:
				return "workspace-write";
		}
	}

	/**
	 * Build the free-form Codex `config` for thread/start. For the coarse
	 * `workspace-mode` sandbox the app-server has no `--add-dir` flag, so writable
	 * roots + network are passed via `sandbox_workspace_write`. The granular
	 * `policy` arm is governed entirely by `turn/start.sandboxPolicy`, so nothing
	 * sandbox-related is added here. MCP servers etc. ride along in configOverrides.
	 */
	private buildThreadConfig(config: ResolvedCodexConfig): CodexConfigOverrides {
		const base: CodexConfigOverrides = config.configOverrides
			? { ...config.configOverrides }
			: {};

		if (config.sandbox.kind === "workspace-mode") {
			base.sandbox_workspace_write = {
				network_access: config.sandbox.networkAccess,
				...(config.sandbox.writableRoots.length > 0
					? { writable_roots: [...config.sandbox.writableRoots] }
					: {}),
			};
		}

		return base;
	}

	/** Serialize a neutral {@link CodexSandboxPolicy} to the wire shape. */
	private toWireSandboxPolicy(
		policy: CodexSandboxPolicy,
	): Record<string, unknown> {
		const restrictedReads = (readableRoots: string[]) => ({
			type: "restricted",
			includePlatformDefaults: true,
			readableRoots,
		});
		switch (policy.type) {
			case "dangerFullAccess":
				return { type: "dangerFullAccess" };
			case "readOnly":
				return {
					type: "readOnly",
					access: restrictedReads(policy.readableRoots),
					networkAccess: policy.networkAccess,
				};
			default:
				return {
					type: "workspaceWrite",
					writableRoots: policy.writableRoots,
					readOnlyAccess: restrictedReads(policy.readableRoots),
					networkAccess: policy.networkAccess,
					excludeSlashTmp: false,
					excludeTmpdirEnvVar: false,
				};
		}
	}

	private toProtocolInput(input: CodexUserInput[]): unknown[] {
		return input.map((item) =>
			item.type === "text"
				? { type: "text", text: item.text }
				: { type: "localImage", path: item.path },
		);
	}

	// ---- Notification / request handling ------------------------------------

	private onNotification(method: AppServerNotification, params: unknown): void {
		// Any notification is a sign of life — reset the idle watchdog.
		if (this.turnActive) {
			this.armIdleWatchdog();
		}
		const p = (params ?? {}) as Record<string, unknown>;
		switch (method) {
			case "turn/started": {
				// The server now accepts turn/steer for this turn. Capture the id
				// (defensively) and signal the runner to flush buffered follow-ups.
				const turn = p.turn as { id?: string } | undefined;
				if (turn?.id) {
					this.activeTurnId = turn.id;
				}
				this.emit("event", { kind: "turn-started" });
				break;
			}
			case "item/started": {
				const item = translateAppServerItem(p.item);
				if (item) this.emit("event", { kind: "item-started", item });
				break;
			}
			case "item/completed": {
				const item = translateAppServerItem(p.item);
				if (item) this.emit("event", { kind: "item-completed", item });
				break;
			}
			case "thread/tokenUsage/updated": {
				this.lastUsage = this.readUsage(p);
				break;
			}
			case "turn/completed": {
				this.onTurnCompleted(p);
				break;
			}
			default:
				// Other notifications (rate limits, mcp startup, warnings, deltas)
				// are not needed for the current activity mapping.
				break;
		}
	}

	private onTurnCompleted(params: Record<string, unknown>): void {
		const turn = (params.turn ?? {}) as {
			status?: string;
			error?: { message?: string } | null;
		};
		this.turnActive = false;
		this.activeTurnId = null;

		if (turn.status === "failed") {
			const message = turn.error?.message || "Codex turn failed";
			this.emit("event", { kind: "turn-failed", message });
		} else {
			this.emit("event", { kind: "turn-completed", usage: this.lastUsage });
		}
		this.settleTurn();
	}

	private onServerRequest(method: string): unknown {
		// With approvalPolicy="never" the server should not ask for approvals;
		// respond defensively so a stray request can never wedge a turn.
		if (/auth/i.test(method)) {
			return { chatgptAuthToken: null };
		}
		if (/approval/i.test(method)) {
			return { decision: "accept" };
		}
		return {};
	}

	private readUsage(params: Record<string, unknown>): NormalizedUsage {
		const total = ((
			params.tokenUsage as { total?: Record<string, number> } | undefined
		)?.total ?? {}) as Record<string, number>;
		return {
			input_tokens: numberOr(total.inputTokens, this.lastUsage.input_tokens),
			output_tokens: numberOr(total.outputTokens, this.lastUsage.output_tokens),
			cached_input_tokens: numberOr(
				total.cachedInputTokens,
				this.lastUsage.cached_input_tokens,
			),
		};
	}

	private onProcessGone(): void {
		if (this.turnActive) {
			this.emit("event", {
				kind: "turn-failed",
				message: "codex app-server exited before the turn completed",
			});
		}
		this.settleTurn();
	}

	private onProcessError(err: unknown): void {
		const message = err instanceof Error ? err.message : String(err);
		this.emit("event", { kind: "error", message });
	}

	/** Resolve or reject the in-flight runTurn promise exactly once. */
	private settleTurn(error?: unknown): void {
		this.clearIdleWatchdog();
		const resolve = this.turnResolve;
		const reject = this.turnReject;
		this.turnResolve = null;
		this.turnReject = null;
		this.turnActive = false;
		if (error && reject) {
			reject(error);
		} else if (resolve) {
			resolve();
		}
	}

	/** (Re)start the idle watchdog for the current turn. */
	private armIdleWatchdog(): void {
		if (this.turnIdleTimeoutMs <= 0) {
			return;
		}
		this.clearIdleWatchdog();
		this.idleTimer = setTimeout(() => {
			if (!this.turnActive) {
				return;
			}
			this.emit("event", {
				kind: "turn-failed",
				message: `codex app-server produced no activity for ${this.turnIdleTimeoutMs}ms`,
			});
			this.settleTurn();
		}, this.turnIdleTimeoutMs);
		this.idleTimer.unref?.();
	}

	private clearIdleWatchdog(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}
}

function numberOr(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
