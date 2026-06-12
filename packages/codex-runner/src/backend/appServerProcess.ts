import {
	AppServerClient,
	type AppServerClientFactory,
	type IAppServerClient,
} from "./appServerClient.js";
import { resolveCodexAppServerLaunch } from "./codexBinary.js";
import type { ResolvedCodexConfig } from "./types.js";

const CLIENT_INFO = { name: "cyrus-codex-runner", version: "1.0.0" };
const DEFAULT_IDLE_CLOSE_MS = 30_000;

export interface AppServerThreadHandler {
	onNotification(method: string, params: unknown): void;
	onProcessGone(): void;
	onProcessError(error: unknown): void;
}

export interface AppServerProcessLease {
	request<T = unknown>(method: string, params: unknown): Promise<T>;
	registerThread(threadId: string, handler: AppServerThreadHandler): void;
	unregisterThread(threadId: string, handler: AppServerThreadHandler): void;
	release(): void;
}

interface AppServerProcessManagerOptions {
	requestTimeoutMs?: number;
	idleCloseMs?: number;
}

interface LaunchOptions {
	command: string;
	args: string[];
	env?: Record<string, string>;
	requestTimeoutMs?: number;
}

/**
 * A single shared Codex app-server process serving every thread that shares an
 * identical launch configuration (command + args + env). Individual
 * CodexRunner threads acquire lightweight leases over the one JSON-RPC
 * connection; notifications are fanned out to the owning thread by `threadId`.
 * The process is torn down once the last lease is released (after an idle grace
 * period) or when the process exits.
 */
class PooledAppServerProcess {
	private client: IAppServerClient | null = null;
	private startPromise: Promise<void> | null = null;
	private leaseCount = 0;
	private disposed = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private readonly threadHandlers = new Map<string, AppServerThreadHandler>();

	constructor(
		private readonly launchOptions: LaunchOptions,
		private readonly clientFactory: AppServerClientFactory,
		private readonly idleCloseMs: number,
		/** Called when this process is fully torn down so the pool can drop it. */
		private readonly onDisposed: () => void,
	) {}

	/** Whether this process has been torn down and must not be reused. */
	isDisposed(): boolean {
		return this.disposed;
	}

	async acquireLease(): Promise<AppServerProcessLease> {
		if (this.disposed) {
			throw new Error(
				"Cannot acquire a lease on a disposed app-server process",
			);
		}
		this.leaseCount += 1;
		this.clearIdleTimer();

		let released = false;
		try {
			await this.ensureStarted();
		} catch (error) {
			released = true;
			this.releaseRef();
			throw error;
		}

		return {
			request: <T = unknown>(method: string, params: unknown): Promise<T> => {
				const client = this.client;
				if (!client) {
					return Promise.reject(
						new Error(`Cannot send ${method}: app-server is not running`),
					);
				}
				return client.request<T>(method, params);
			},
			registerThread: (threadId, handler) => {
				const existing = this.threadHandlers.get(threadId);
				if (existing && existing !== handler) {
					throw new Error(
						`Cannot register Codex thread ${threadId}: already registered`,
					);
				}
				this.threadHandlers.set(threadId, handler);
			},
			unregisterThread: (threadId, handler) => {
				if (this.threadHandlers.get(threadId) === handler) {
					this.threadHandlers.delete(threadId);
				}
			},
			release: () => {
				if (released) {
					return;
				}
				released = true;
				this.releaseRef();
			},
		};
	}

	async close(): Promise<void> {
		this.markDisposed();
		const client = this.client;
		this.client = null;
		await client?.close();
	}

	private async ensureStarted(): Promise<void> {
		if (this.client) {
			return;
		}
		if (this.startPromise) {
			await this.startPromise;
			return;
		}

		const client = this.clientFactory({
			binaryPath: this.launchOptions.command,
			args: this.launchOptions.args,
			...(this.launchOptions.env ? { env: this.launchOptions.env } : {}),
			...(this.launchOptions.requestTimeoutMs !== undefined
				? { requestTimeoutMs: this.launchOptions.requestTimeoutMs }
				: {}),
		});
		this.client = client;

		client.setNotificationHandler((method, params) =>
			this.routeNotification(method, params),
		);
		client.setServerRequestHandler((method, params) =>
			this.onServerRequest(method, params),
		);
		client.on("exit", () => this.onProcessGone());
		client.on("error", (error) => this.onProcessError(error));
		client.start();

		const startPromise = client
			.request("initialize", {
				clientInfo: CLIENT_INFO,
				capabilities: { experimentalApi: true },
			})
			.then(() => undefined)
			.catch((error) => {
				// Failed to initialize — tear down so the pool re-creates cleanly.
				if (this.client === client) {
					this.client = null;
					this.markDisposed();
				}
				throw error;
			})
			.finally(() => {
				if (this.startPromise === startPromise) {
					this.startPromise = null;
				}
			});
		this.startPromise = startPromise;
		await startPromise;
	}

	private routeNotification(method: string, params: unknown): void {
		const threadId = extractThreadId(params);
		if (threadId) {
			this.threadHandlers.get(threadId)?.onNotification(method, params);
			return;
		}
		// No threadId on the notification. When exactly one thread is registered
		// the target is unambiguous, so deliver it (robust against any
		// notification type that omits the id). With multiple threads we cannot
		// safely attribute it, so drop it rather than risk cross-thread delivery.
		if (this.threadHandlers.size === 1) {
			for (const handler of this.threadHandlers.values()) {
				handler.onNotification(method, params);
			}
		}
	}

	private onServerRequest(method: string, params: unknown): unknown {
		// Cyrus runs headless: there is no user to put these questions to, so
		// every server→client request must be auto-answered with the response
		// shape that request expects. A wrong or empty shape is not a no-op —
		// the app-server fails to deserialize it and substitutes a decline
		// (surfacing to the agent as e.g. "user rejected MCP tool call").
		//
		// approvalPolicy="never" does NOT make these requests go away: MCP
		// tool-call confirmations are only auto-approved upstream when the
		// permission profile has full disk write access, which Cyrus's
		// workspace-write / restricted profiles never do.

		// "mcpServer/elicitation/request" — MCP elicitations, including the
		// confirmation form Codex emits before every mutating MCP tool call.
		// Accept with empty content (accept + no answers resolves as a plain
		// approval upstream).
		if (/elicitation/i.test(method)) {
			return { action: "accept", content: {} };
		}
		// "item/tool/requestUserInput" — the non-elicitation variant of the
		// same MCP tool-call confirmation (and other tool questions). Answer
		// each question with its "Allow" option when present.
		if (/requestuserinput/i.test(method)) {
			return buildRequestUserInputResponse(params);
		}
		// "item/permissions/requestApproval" — a request to ESCALATE sandbox
		// permissions; its response carries a granted-permission profile, not
		// a decision. Grant nothing: auto-granting whatever was asked for
		// would defeat the per-thread filesystem sandbox.
		if (/permission/i.test(method)) {
			return { permissions: {} };
		}
		if (/auth/i.test(method)) {
			return { chatgptAuthToken: null };
		}
		// "item/commandExecution/requestApproval",
		// "item/fileChange/requestApproval" and the legacy
		// applyPatchApproval / execCommandApproval all take a decision.
		if (/approval/i.test(method)) {
			return { decision: "accept" };
		}
		return {};
	}

	private onProcessGone(): void {
		const handlers = [...new Set(this.threadHandlers.values())];
		this.markDisposed();
		this.client = null;
		for (const handler of handlers) {
			handler.onProcessGone();
		}
	}

	private onProcessError(error: unknown): void {
		for (const handler of new Set(this.threadHandlers.values())) {
			handler.onProcessError(error);
		}
	}

	private releaseRef(): void {
		this.leaseCount = Math.max(0, this.leaseCount - 1);
		if (this.leaseCount === 0) {
			this.scheduleIdleClose();
		}
	}

	private scheduleIdleClose(): void {
		this.clearIdleTimer();
		if (!this.client || this.disposed) {
			return;
		}
		if (this.idleCloseMs <= 0) {
			void this.close();
			return;
		}
		this.idleTimer = setTimeout(() => {
			// A lease may have been re-acquired during the grace period.
			if (this.leaseCount === 0) {
				void this.close();
			}
		}, this.idleCloseMs);
		this.idleTimer.unref?.();
	}

	private clearIdleTimer(): void {
		if (this.idleTimer) {
			clearTimeout(this.idleTimer);
			this.idleTimer = null;
		}
	}

	/** Tear down per-process state exactly once and notify the pool. */
	private markDisposed(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.clearIdleTimer();
		this.threadHandlers.clear();
		this.startPromise = null;
		this.onDisposed();
	}
}

/**
 * Owns Codex app-server processes for this Node process, pooled by launch
 * configuration. Threads that share an identical launch config (command + args
 * + env) reuse one process; threads with a different config get their own,
 * rather than failing. This keeps the startup-cost savings of sharing while
 * supporting heterogeneous concurrent sessions and confining a process crash to
 * the threads that share that exact configuration.
 */
export class AppServerProcessManager {
	private readonly processes = new Map<string, PooledAppServerProcess>();
	private readonly requestTimeoutMs: number | undefined;
	private readonly idleCloseMs: number;

	constructor(
		private readonly clientFactory: AppServerClientFactory = (options) =>
			new AppServerClient(options),
		options?: AppServerProcessManagerOptions,
	) {
		this.requestTimeoutMs = options?.requestTimeoutMs;
		this.idleCloseMs = options?.idleCloseMs ?? DEFAULT_IDLE_CLOSE_MS;
	}

	async acquire(config: ResolvedCodexConfig): Promise<AppServerProcessLease> {
		const { command, args } = resolveCodexAppServerLaunch(config.codexPath);
		const launchOptions: LaunchOptions = {
			command,
			args,
			...(config.env ? { env: config.env } : {}),
			...(this.requestTimeoutMs !== undefined
				? { requestTimeoutMs: this.requestTimeoutMs }
				: {}),
		};
		const launchKey = buildLaunchKey(launchOptions);

		let proc = this.processes.get(launchKey);
		if (!proc || proc.isDisposed()) {
			const created = new PooledAppServerProcess(
				launchOptions,
				this.clientFactory,
				this.idleCloseMs,
				() => {
					// Only drop the entry if it still points at this instance — a
					// replacement may already have taken its place.
					if (this.processes.get(launchKey) === created) {
						this.processes.delete(launchKey);
					}
				},
			);
			this.processes.set(launchKey, created);
			proc = created;
		}

		return proc.acquireLease();
	}

	/** Tear down every pooled process (e.g. on shutdown or in tests). */
	async closeAll(): Promise<void> {
		const processes = [...this.processes.values()];
		this.processes.clear();
		await Promise.all(processes.map((proc) => proc.close()));
	}
}

export const defaultAppServerProcessManager = new AppServerProcessManager();

function extractThreadId(params: unknown): string | undefined {
	if (!params || typeof params !== "object") {
		return undefined;
	}
	const p = params as {
		threadId?: unknown;
		thread?: { id?: unknown };
	};
	if (typeof p.threadId === "string") {
		return p.threadId;
	}
	return typeof p.thread?.id === "string" ? p.thread.id : undefined;
}

/** The label Codex's MCP tool-call confirmation uses for plain approval. */
const REQUEST_USER_INPUT_ACCEPT_LABEL = "Allow";

/**
 * Answer an `item/tool/requestUserInput` request. Each question is answered
 * with its "Allow" option when one exists, falling back to the first option.
 * Questions without options get an empty answer rather than being omitted, so
 * the server sees every question as addressed.
 */
function buildRequestUserInputResponse(params: unknown): unknown {
	const questions = (
		params as {
			questions?: Array<{
				id?: unknown;
				options?: Array<{ label?: unknown } | null>;
			} | null>;
		} | null
	)?.questions;
	if (!Array.isArray(questions)) {
		return { answers: {} };
	}
	const answers: Record<string, { answers: string[] }> = {};
	for (const question of questions) {
		if (!question || typeof question.id !== "string") {
			continue;
		}
		const labels = Array.isArray(question.options)
			? question.options
					.map((option) => option?.label)
					.filter((label): label is string => typeof label === "string")
			: [];
		const choice =
			labels.find((label) => label === REQUEST_USER_INPUT_ACCEPT_LABEL) ??
			labels[0];
		answers[question.id] = { answers: choice === undefined ? [] : [choice] };
	}
	return { answers };
}

function buildLaunchKey(options: LaunchOptions): string {
	return JSON.stringify({
		command: options.command,
		args: options.args,
		env: options.env ? sortRecord(options.env) : null,
		requestTimeoutMs: options.requestTimeoutMs ?? null,
	});
}

function sortRecord(record: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(record).sort(([a], [b]) => a.localeCompare(b)),
	);
}
