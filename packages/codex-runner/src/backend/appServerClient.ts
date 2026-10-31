import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import readline from "node:readline";

/** Handles a server→client notification (no response expected). */
export type NotificationHandler = (method: string, params: unknown) => void;

/** Handles a server→client request; the returned value becomes the response. */
export type ServerRequestHandler = (
	method: string,
	params: unknown,
) => unknown | Promise<unknown>;

interface PendingRequest {
	resolve: (value: unknown) => void;
	reject: (reason: unknown) => void;
	method: string;
	timer?: ReturnType<typeof setTimeout>;
}

/** Default control-plane request timeout. Turn execution is awaited separately
 * (via notifications), so this only bounds quick request/response calls. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

interface JsonRpcMessage {
	jsonrpc?: string;
	id?: number | string;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code?: number; message?: string; data?: unknown };
}

export interface AppServerClientOptions {
	binaryPath: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	/** Optional logger; defaults to console. */
	logger?: Pick<typeof console, "warn" | "error">;
	/**
	 * Per-request timeout in milliseconds for control-plane calls
	 * (`initialize`, `thread/*`, `turn/start`, `turn/steer`, `turn/interrupt`).
	 * A wedged app-server then rejects the pending request instead of hanging
	 * the session forever. Defaults to 60s. Set to 0 to disable.
	 */
	requestTimeoutMs?: number;
}

/**
 * The slice of {@link AppServerClient} the backend depends on. Declaring it lets
 * tests inject a fake transport without spawning a process (Dependency
 * Inversion).
 */
export interface IAppServerClient {
	setNotificationHandler(handler: NotificationHandler): void;
	setServerRequestHandler(handler: ServerRequestHandler): void;
	on(event: "exit", listener: (...args: unknown[]) => void): unknown;
	on(event: "error", listener: (...args: unknown[]) => void): unknown;
	on(event: string, listener: (...args: unknown[]) => void): unknown;
	start(): void;
	request<T = unknown>(method: string, params: unknown): Promise<T>;
	close(): Promise<void>;
}

/** Factory used by the backend to create a client; overridable in tests. */
export type AppServerClientFactory = (
	options: AppServerClientOptions,
) => IAppServerClient;

/**
 * Minimal JSON-RPC 2.0 client over a `codex app-server` child process speaking
 * newline-delimited JSON on stdio. Single responsibility: framing + request
 * correlation + dispatch of notifications/server-requests. Knows nothing about
 * Codex semantics.
 */
export class AppServerClient extends EventEmitter {
	private child: ChildProcessWithoutNullStreams | null = null;
	private rl: readline.Interface | null = null;
	private nextId = 1;
	private readonly pending = new Map<number | string, PendingRequest>();
	private notificationHandler: NotificationHandler | null = null;
	private serverRequestHandler: ServerRequestHandler | null = null;
	private closed = false;
	private closePromise: Promise<void> | null = null;
	private readonly logger: Pick<typeof console, "warn" | "error">;

	constructor(private readonly options: AppServerClientOptions) {
		super();
		this.logger = options.logger ?? console;
	}

	setNotificationHandler(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}

	setServerRequestHandler(handler: ServerRequestHandler): void {
		this.serverRequestHandler = handler;
	}

	start(): void {
		if (this.child) {
			throw new Error("AppServerClient already started");
		}
		const args = this.options.args ?? ["app-server", "--listen", "stdio://"];
		const child = spawn(this.options.binaryPath, args, {
			stdio: ["pipe", "pipe", "pipe"],
			cwd: this.options.cwd,
			// Run in its own process group (POSIX) so teardown can signal the whole
			// tree at once. We launch codex via the `@openai/codex` Node bin shim,
			// which spawns the native binary as a grandchild; killing only the shim
			// would leave the native process to linger until its stdin pipe closes.
			// Group-killing reaps both immediately. Not supported on Windows.
			...(process.platform !== "win32" ? { detached: true } : {}),
			...(this.options.env ? { env: this.options.env } : {}),
		}) as ChildProcessWithoutNullStreams;
		this.child = child;

		child.once("error", (err) => {
			this.failAllPending(err);
			this.emit("error", err);
		});
		child.once("exit", (code, signal) => {
			this.closed = true;
			const reason = new Error(
				`codex app-server exited (code=${code ?? "null"}, signal=${signal ?? "null"})`,
			);
			this.failAllPending(reason);
			this.emit("exit", code, signal);
		});

		child.stderr.on("data", (data: Buffer) => {
			const text = data.toString().trim();
			if (text) {
				this.emit("stderr", text);
			}
		});

		this.rl = readline.createInterface({
			input: child.stdout,
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		this.rl.on("line", (line) => this.onLine(line));
	}

	request<T = unknown>(method: string, params: unknown): Promise<T> {
		if (this.closed || !this.child) {
			return Promise.reject(
				new Error(`Cannot send ${method}: app-server is not running`),
			);
		}
		const id = this.nextId++;
		const message = { jsonrpc: "2.0", id, method, params };
		const timeoutMs =
			this.options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		return new Promise<T>((resolve, reject) => {
			const entry: PendingRequest = {
				resolve: resolve as (value: unknown) => void,
				reject,
				method,
			};
			if (timeoutMs > 0) {
				entry.timer = setTimeout(() => {
					if (this.pending.delete(id)) {
						reject(new Error(`${method} timed out after ${timeoutMs}ms`));
					}
				}, timeoutMs);
				// Don't keep the event loop alive solely for this timer.
				entry.timer.unref?.();
			}
			this.pending.set(id, entry);
			this.write(message);
		});
	}

	/** Clear a pending request's timeout (called when settled). */
	private settlePending(id: number | string): PendingRequest | undefined {
		const entry = this.pending.get(id);
		if (entry) {
			this.pending.delete(id);
			if (entry.timer) {
				clearTimeout(entry.timer);
			}
		}
		return entry;
	}

	notify(method: string, params: unknown): void {
		if (this.closed || !this.child) {
			return;
		}
		this.write({ jsonrpc: "2.0", method, params });
	}

	close(): Promise<void> {
		this.closePromise ??= this.closeOwnedProcess().catch(() => {
			// Unknown process state is not a completed close. Keep all callers
			// waiting (and Jira fenced) until an operator reconciles/restarts.
			this.logger.error(
				"[AppServerClient] owned process termination could not be confirmed",
			);
			return new Promise<never>(() => {});
		});
		return this.closePromise;
	}

	private async closeOwnedProcess(): Promise<void> {
		this.closed = true;
		this.rl?.close();
		this.rl = null;
		const child = this.child;
		this.failAllPending(new Error("app-server client closed"));
		if (!child?.pid) return;
		const pid = child.pid;
		const target = process.platform === "win32" ? pid : -pid;
		const alive = () => {
			try {
				process.kill(target, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
				// Darwin can return EPERM while a group contains only exiting
				// zombies. Keep waiting; only ESRCH confirms absence.
				if ((error as NodeJS.ErrnoException).code === "EPERM") return true;
				throw error;
			}
		};
		const signal = (value: NodeJS.Signals) => {
			try {
				process.kill(target, value);
			} catch (error) {
				if (
					!["ESRCH", "EPERM"].includes(
						(error as NodeJS.ErrnoException).code ?? "",
					)
				)
					throw error;
			}
		};
		// Cancellation is not settled until the owned process group is gone.
		// Retain the promise while a child ignores TERM; never release a Jira
		// execution slot merely because a signal or interrupt was sent.
		if (alive()) signal("SIGTERM");
		const deadline = Date.now() + 1_000;
		while (alive()) {
			if (Date.now() >= deadline) signal("SIGKILL");
			await new Promise((resolve) => setTimeout(resolve, 20));
		}
		this.child = null;
	}

	private write(message: unknown): void {
		try {
			this.child?.stdin.write(`${JSON.stringify(message)}\n`);
		} catch (err) {
			this.logger.error("[AppServerClient] write failed", err);
		}
	}

	private onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let message: JsonRpcMessage;
		try {
			message = JSON.parse(trimmed) as JsonRpcMessage;
		} catch {
			this.logger.warn(
				`[AppServerClient] non-JSON line: ${trimmed.slice(0, 200)}`,
			);
			return;
		}

		// Response to a client request.
		if (
			message.id !== undefined &&
			(message.result !== undefined || message.error !== undefined)
		) {
			const entry = this.settlePending(message.id);
			if (!entry) {
				return;
			}
			if (message.error) {
				entry.reject(
					new Error(
						`${entry.method} failed: ${message.error.message ?? "unknown error"}`,
					),
				);
			} else {
				entry.resolve(message.result);
			}
			return;
		}

		// Server→client request (expects a response).
		if (message.id !== undefined && message.method) {
			void this.handleServerRequest(message.id, message.method, message.params);
			return;
		}

		// Notification.
		if (message.method) {
			try {
				this.notificationHandler?.(message.method, message.params);
			} catch (err) {
				this.logger.error(
					`[AppServerClient] notification handler threw for ${message.method}`,
					err,
				);
			}
		}
	}

	private async handleServerRequest(
		id: number | string,
		method: string,
		params: unknown,
	): Promise<void> {
		let result: unknown = {};
		try {
			if (this.serverRequestHandler) {
				result = (await this.serverRequestHandler(method, params)) ?? {};
			}
		} catch (err) {
			this.logger.error(
				`[AppServerClient] server-request handler threw for ${method}`,
				err,
			);
		}
		this.write({ jsonrpc: "2.0", id, result });
	}

	private failAllPending(reason: unknown): void {
		for (const [, entry] of this.pending) {
			if (entry.timer) {
				clearTimeout(entry.timer);
			}
			entry.reject(reason);
		}
		this.pending.clear();
	}
}
