import {
	AppServerClient,
	type AppServerClientFactory,
	type IAppServerClient,
} from "./appServerClient.js";
import { resolveCodexAppServerLaunch } from "./codexBinary.js";
import type { ResolvedCodexConfig } from "./types.js";

const CLIENT_INFO = { name: "cyrus-codex-runner", version: "1.0.0" };
const DEFAULT_IDLE_CLOSE_MS = 30_000;
const AUTO_ACCEPT_MCP_ELICITATION_SERVERS = new Set(
	(process.env.CODEX_MCP_AUTO_ACCEPT_SERVERS ?? "linear")
		.split(",")
		.map((serverName) => serverName.trim())
		.filter(Boolean),
);

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
		// With approvalPolicy="never" the server should not ask for approvals;
		// respond defensively so a stray request can never wedge a turn.
		if (/auth/i.test(method)) {
			return { chatgptAuthToken: null };
		}
		if (method === "mcpServer/elicitation/request") {
			return this.onMcpElicitationRequest(params);
		}
		if (/approval/i.test(method)) {
			return { decision: "accept" };
		}
		return {};
	}

	private onMcpElicitationRequest(params: unknown): unknown {
		const request =
			params && typeof params === "object"
				? (params as {
						serverName?: unknown;
						_meta?: unknown;
					})
				: {};
		const meta =
			request._meta && typeof request._meta === "object"
				? (request._meta as Record<string, unknown>)
				: {};
		const serverName =
			typeof request.serverName === "string" ? request.serverName : "";

		if (
			meta.codex_approval_kind === "mcp_tool_call" &&
			AUTO_ACCEPT_MCP_ELICITATION_SERVERS.has(serverName)
		) {
			return { action: "accept", content: {} };
		}

		return { action: "cancel" };
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
