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
	/** Optional logger; defaults to console. */
	logger?: Pick<typeof console, "warn" | "error">;
	/**
	 * Per-request timeout in milliseconds for control-plane calls
	 * (`initialize`, `thread/*`, `turn/start`, `turn/steer`, `turn/interrupt`).
	 * A wedged app-server then rejects the pending request instead of hanging
	 * the session forever. Defaults to 60s. Set to 0 to disable.
	 */
	requestTimeoutMs?: number;
	/** Bound untrusted contained-process output, including unterminated frames. */
	maxOutputBytes?: number;
	/** Dedicated fenced owners require confirmed process-group termination. */
	awaitProcessExit?: boolean;
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
	private closing?: Promise<void>;
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

		if (this.options.maxOutputBytes !== undefined) {
			let bytes = 0;
			const account = (chunk: Buffer) => {
				bytes += chunk.length;
				if (bytes > this.options.maxOutputBytes!) {
					this.failAllPending(new Error("App-server output limit exceeded"));
					this.rl?.close();
					void this.close();
					this.emit("error", new Error("App-server output limit exceeded"));
				}
			};
			child.stdout.on("data", account);
			child.stderr.on("data", account);
		}
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

	async close(): Promise<void> {
		if (this.closing) return this.closing;
		this.closed = true;
		this.rl?.close();
		this.rl = null;
		const child = this.child;
		this.child = null;
		this.failAllPending(new Error("app-server client closed"));
		this.closing = (async () => {
			if (!child) return;
			if (this.options.awaitProcessExit) await this.terminateAndWait(child);
			else if (!child.killed) this.terminateChild(child);
		})();
		return this.closing;
	}

	private async terminateAndWait(
		child: ChildProcessWithoutNullStreams,
	): Promise<void> {
		const pid = child.pid;
		if (!pid) return; // Spawn failed; no native process was created.
		const exited = child.exitCode !== null || child.signalCode !== null;
		const exit = exited
			? Promise.resolve()
			: new Promise<void>((resolve, reject) => {
					const timer = setTimeout(() => {
						cleanup();
						reject(new Error("Dedicated app-server exit not confirmed"));
					}, 5000);
					const done = () => {
						cleanup();
						resolve();
					};
					const cleanup = () => {
						clearTimeout(timer);
						child.off("exit", done);
					};
					child.once("exit", done);
				});
		try {
			process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
				await exit.catch(() => undefined);
				throw new Error("Dedicated app-server termination failed");
			}
		}
		await exit;
		if (process.platform !== "win32") {
			const deadline = Date.now() + 5000;
			for (;;) {
				try {
					process.kill(-pid, 0);
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
					throw new Error("Dedicated app-server group exit not confirmed");
				}
				if (Date.now() >= deadline)
					throw new Error("Dedicated app-server group still running");
				await new Promise((resolve) => setTimeout(resolve, 25));
			}
		}
	}

	/**
	 * Terminate the child and any grandchildren. On POSIX the child was spawned
	 * `detached`, so it leads its own process group; signalling the negative pid
	 * reaps the whole group (the Node bin shim + the native codex binary) at
	 * once. Falls back to a direct kill if the group is already gone or on
	 * Windows (no process groups).
	 */
	private terminateChild(child: ChildProcessWithoutNullStreams): void {
		try {
			if (process.platform !== "win32" && typeof child.pid === "number") {
				process.kill(-child.pid, "SIGTERM");
				return;
			}
		} catch {
			// Group already dead or unavailable — fall through to a direct kill.
		}
		try {
			child.kill();
		} catch {
			// best-effort
		}
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
