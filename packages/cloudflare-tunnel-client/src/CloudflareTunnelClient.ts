import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { bin, install, Tunnel } from "cloudflared";
import type {
	CloudflareTunnelClientEvents,
	CloudflareTunnelRecoveryOptions,
} from "./types.js";

export declare interface CloudflareTunnelClient {
	on<K extends keyof CloudflareTunnelClientEvents>(
		event: K,
		listener: CloudflareTunnelClientEvents[K],
	): this;
	emit<K extends keyof CloudflareTunnelClientEvents>(
		event: K,
		...args: Parameters<CloudflareTunnelClientEvents[K]>
	): boolean;
}

/**
 * Default recovery policy for a cloudflared child that exits after it had
 * connected. Delays double from 1s up to a 60s cap; after 10 consecutive
 * failed restarts the client stops retrying and stays disconnected.
 */
export const DEFAULT_TUNNEL_RECOVERY_OPTIONS: Required<CloudflareTunnelRecoveryOptions> =
	{
		// 120s: slow DNS resolvers (e.g. dead IPv6 nameservers ahead of the
		// working one) can delay the first connection past 30s
		connectTimeoutMs: 120000,
		initialRestartDelayMs: 1000,
		maxRestartDelayMs: 60000,
		maxRestartAttempts: 10,
		// A child that stayed connected this long counts as healthy, so its exit
		// starts a fresh retry budget instead of continuing the previous one
		stableConnectionMs: 60000,
		// Grace period after SIGINT before SIGKILL on deliberate shutdown
		killGraceMs: 5000,
		// Max wait for a killed child to exit before a restart; if its exit is
		// never confirmed, recovery stops rather than run a second child
		killWaitMs: 10000,
	};

export interface CloudflareTunnelClientOptions
	extends CloudflareTunnelRecoveryOptions {
	/** Creates the cloudflared Tunnel (defaults to Tunnel.withToken); test seam */
	createTunnel?: (token: string) => Tunnel;
}

type ClientState =
	| "idle"
	| "starting"
	| "running"
	| "recovering"
	| "stopped"
	| "failed";

const isAlive = (tunnel: Tunnel): boolean =>
	tunnel.process.pid !== undefined &&
	tunnel.process.exitCode === null &&
	tunnel.process.signalCode === null;

/**
 * Cloudflare tunnel client for establishing tunnels to local services
 * Handles ONLY tunnel establishment - HTTP handling is done by SharedApplicationServer
 *
 * The client is the single owner of the cloudflared child process. If a child
 * that had connected exits unexpectedly while the client is still running, the
 * client respawns it with bounded exponential backoff, never before the
 * previous child's exit is confirmed. Startup failures and deliberate
 * disconnects never trigger a respawn.
 *
 * Reentrancy: every state transition completes before any event is emitted,
 * and nothing that could start work runs after an emit unless the client is
 * still current, so listeners may call disconnect() from any event.
 */
export class CloudflareTunnelClient extends EventEmitter {
	/** The owned child; held until its exit is confirmed (or it never spawned) */
	private tunnel: Tunnel | null = null;
	/** Incremented per spawned child and on loss/disconnect; fences stale callbacks */
	private generation = 0;
	/** The single pending timer: connect timeout, kill wait, or restart backoff */
	private timer: NodeJS.Timeout | null = null;
	/** A lost child was killed; the restart waits for its exit */
	private awaitingExit = false;
	private pendingRestartDelay = 0;
	private state: ClientState = "idle";
	private startup: {
		resolve: () => void;
		reject: (error: Error) => void;
	} | null = null;
	private restartAttempts = 0;
	private connectedAt = 0;
	private tunnelUrl: string | null = null;
	private connected = false;
	private connectionCount = 0;
	private cloudflareToken: string;
	private localPort: number;
	private options: Required<CloudflareTunnelRecoveryOptions>;
	private createTunnel: (token: string) => Tunnel;

	constructor(
		cloudflareToken: string,
		localPort: number,
		onReady?: (tunnelUrl: string) => void,
		options: CloudflareTunnelClientOptions = {},
	) {
		super();
		this.cloudflareToken = cloudflareToken;
		this.localPort = localPort;
		const { createTunnel, ...recovery } = options;
		this.options = { ...DEFAULT_TUNNEL_RECOVERY_OPTIONS, ...recovery };
		// Create tunnel with token-based authentication (no URL needed for remotely-managed tunnels)
		this.createTunnel = createTunnel ?? ((token) => Tunnel.withToken(token));

		// Set up onReady callback if provided
		if (onReady) {
			this.on("ready", onReady);
		}
	}

	/**
	 * Start the Cloudflare tunnel. Resolves once the first connection is
	 * established; rejects if the child exits, fails to spawn, the connect
	 * timeout elapses, or disconnect() is called first. Can only be called once.
	 */
	async startTunnel(): Promise<void> {
		if (this.state !== "idle") {
			throw new Error(
				`Cloudflare tunnel already started (state: ${this.state})`,
			);
		}
		this.state = "starting";

		try {
			// Ensure cloudflared binary is installed
			if (!existsSync(bin)) {
				await install(bin);
			}
			if (this.state !== "starting") {
				throw new Error("Cloudflare tunnel disconnected during startup");
			}

			console.log(`Starting tunnel to localhost:${this.localPort}`);

			await new Promise<void>((resolve, reject) => {
				this.startup = { resolve, reject };
				this.spawnChild();
			});
		} catch (error) {
			this.startup = null;
			// Re-read state: disconnect() or a child loss may have changed it
			const state = this.state as ClientState;
			if (state === "starting") {
				this.state = "failed";
				this.generation++;
				this.clearTimer();
				this.stopChild(true);
			}
			// A deliberate disconnect during startup is not an error condition
			if (state !== "stopped") {
				this.emit("error", error as Error);
			}
			throw error;
		}
	}

	/**
	 * Spawn a cloudflared child owned by this client and arm its connect
	 * timeout. Throws (owning nothing) if the tunnel cannot be created.
	 */
	private spawnChild(): void {
		const generation = ++this.generation;
		const isCurrent = () =>
			generation === this.generation &&
			(this.state === "starting" ||
				this.state === "recovering" ||
				this.state === "running");

		this.connectionCount = 0;
		const tunnel = this.createTunnel(this.cloudflareToken);
		this.tunnel = tunnel;

		// Ownership release is not generation-gated: a killed child stays owned
		// until it has actually exited
		tunnel.on("exit", () => this.releaseChild(tunnel));

		// Listen for exit event
		tunnel.on("exit", (code: number | null, signal: NodeJS.Signals | null) => {
			if (!isCurrent()) return;
			this.handleChildLoss(
				`Tunnel process exited with code ${code}${signal ? ` (signal ${signal})` : ""}`,
			);
		});

		// Listen for error event. Errors are informational unless the child
		// never spawned (no pid), in which case no 'exit' will follow.
		tunnel.on("error", (error: Error) => {
			const neverSpawned = tunnel.process.pid === undefined;
			if (neverSpawned) this.releaseChild(tunnel);
			if (generation !== this.generation) return;
			if (neverSpawned && isCurrent()) {
				this.handleChildLoss(
					`Tunnel process failed to start: ${error.message}`,
				);
			}
			this.emit("error", error);
		});

		// Listen for URL event (from ConfigHandler for token-based tunnels)
		tunnel.on("url", (url: string) => {
			if (!isCurrent()) return;
			// Ensure URL has protocol for token-based tunnels
			if (!url.startsWith("http")) {
				url = `https://${url}`;
			}
			if (!this.tunnelUrl) {
				this.tunnelUrl = url;
				this.emit("ready", this.tunnelUrl);
			}
		});

		// Listen for connection event (Cloudflare establishes 4 connections per tunnel)
		tunnel.on("connected", (connection: any) => {
			if (!isCurrent()) return;
			this.connectionCount++;
			console.log(
				`Cloudflare tunnel connection ${this.connectionCount}/4 established:`,
				connection,
			);

			// Mark as connected on first connection, but log all 4
			const first = !this.connected;
			if (first) {
				this.markConnected();
			}

			// Emit 'connected' event for each connection (for external listeners)
			this.emit("connected", connection);
			if (first && isCurrent()) {
				this.emit("connect");
			}
		});

		this.setTimer(() => {
			this.handleChildLoss(
				`Timeout waiting for tunnel to connect after ${this.options.connectTimeoutMs}ms`,
			);
		}, this.options.connectTimeoutMs);
	}

	/** First connection of the current child: update state and settle startup */
	private markConnected(): void {
		this.clearTimer();
		this.connected = true;
		this.connectedAt = Date.now();
		const recovered = this.state === "recovering";
		this.state = "running";

		if (recovered) {
			console.log(
				`Cloudflare tunnel recovered after ${this.restartAttempts} restart attempt(s)`,
			);
		}

		const startup = this.startup;
		this.startup = null;
		startup?.resolve();
	}

	/**
	 * The current child is gone (exited, failed to spawn, or timed out before
	 * connecting). During startup this fails startTunnel(); afterwards it
	 * schedules a bounded restart once the child's exit is confirmed.
	 */
	private handleChildLoss(reason: string): void {
		this.clearTimer();
		// Fence any remaining callbacks from the lost child
		this.generation++;
		const wasConnected = this.connected;
		this.connected = false;
		this.connectionCount = 0; // Reset count on disconnect for fresh reconnection logs

		if (this.state === "starting") {
			this.state = "failed";
			this.stopChild(true);
			const startup = this.startup;
			this.startup = null;
			// startTunnel() reports this rejection as an 'error' event
			startup?.reject(
				new Error(`Cloudflare tunnel failed to start: ${reason}`),
			);
			return;
		}

		if (
			wasConnected &&
			Date.now() - this.connectedAt >= this.options.stableConnectionMs
		) {
			this.restartAttempts = 0;
		}

		if (this.restartAttempts >= this.options.maxRestartAttempts) {
			this.state = "failed";
			this.stopChild(true);
			const message = `Cloudflare tunnel recovery gave up after ${this.restartAttempts} consecutive failed restart attempts (${reason}); restart Cyrus to restore the tunnel`;
			console.error(message);
			if (wasConnected) this.emit("disconnect", reason);
			if (this.state === "failed") this.emit("error", new Error(message));
			return;
		}

		this.state = "recovering";
		this.restartAttempts++;
		this.pendingRestartDelay = Math.min(
			this.options.initialRestartDelayMs * 2 ** (this.restartAttempts - 1),
			this.options.maxRestartDelayMs,
		);

		const owned = this.tunnel;
		if (owned && isAlive(owned)) {
			// Never run two children: restart only after this one has exited
			this.awaitingExit = true;
			owned.process.kill("SIGKILL");
			this.setTimer(
				() => this.handleKillWaitTimeout(owned),
				this.options.killWaitMs,
			);
		} else {
			this.tunnel = null;
			this.scheduleRestart();
		}

		console.warn(
			`${reason}; restarting Cloudflare tunnel in ${this.pendingRestartDelay}ms (attempt ${this.restartAttempts}/${this.options.maxRestartAttempts})`,
		);
		if (wasConnected) this.emit("disconnect", reason);
	}

	/** An owned child has actually exited (or never spawned) */
	private releaseChild(tunnel: Tunnel): void {
		if (this.tunnel !== tunnel) return;
		this.tunnel = null;
		if (this.awaitingExit && this.state === "recovering") {
			this.awaitingExit = false;
			this.scheduleRestart();
		}
	}

	private scheduleRestart(): void {
		this.setTimer(() => {
			if (this.state !== "recovering" || this.tunnel) return;
			try {
				this.spawnChild();
			} catch (error) {
				this.handleChildLoss(
					`Tunnel process failed to spawn: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}, this.pendingRestartDelay);
	}

	private handleKillWaitTimeout(tunnel: Tunnel): void {
		this.awaitingExit = false;
		this.state = "failed";
		const message = `Cloudflare tunnel recovery stopped: previous cloudflared process (pid ${tunnel.process.pid}) did not exit within ${this.options.killWaitMs}ms of SIGKILL; not starting another to avoid running two; restart Cyrus to restore the tunnel`;
		console.error(message);
		this.emit("error", new Error(message));
	}

	private setTimer(callback: () => void, delay: number): void {
		this.clearTimer();
		this.timer = setTimeout(() => {
			this.timer = null;
			callback();
		}, delay);
	}

	private clearTimer(): void {
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
	}

	/**
	 * Kill the owned child (if still alive) and release it. Only used when no
	 * further child will be spawned. Failed children are killed immediately;
	 * deliberate shutdowns get a graceful SIGINT first.
	 */
	private stopChild(force: boolean): void {
		const tunnel = this.tunnel;
		this.tunnel = null;
		if (!tunnel || !isAlive(tunnel)) return;

		const child = tunnel.process;
		if (force) {
			child.kill("SIGKILL");
			return;
		}
		tunnel.stop();
		const escalation = setTimeout(() => {
			if (isAlive(tunnel)) {
				child.kill("SIGKILL");
			}
		}, this.options.killGraceMs);
		escalation.unref();
		child.once("exit", () => clearTimeout(escalation));
	}

	/**
	 * Get the tunnel URL
	 */
	getTunnelUrl(): string | null {
		return this.tunnelUrl;
	}

	/**
	 * Check if client is connected
	 */
	isConnected(): boolean {
		return this.connected;
	}

	/**
	 * Disconnect and cleanup. Cancels any pending restart or startup and kills
	 * the owned child; the client will not respawn afterwards. Safe to call
	 * from any event listener.
	 */
	disconnect(): void {
		const previousState = this.state;
		this.state = "stopped";
		this.generation++;
		this.awaitingExit = false;
		this.clearTimer();
		this.stopChild(false);
		this.connected = false;
		this.connectionCount = 0; // Reset count on disconnect for fresh reconnection logs

		const startup = this.startup;
		this.startup = null;
		startup?.reject(new Error("Cloudflare tunnel disconnected during startup"));

		if (previousState !== "stopped") {
			this.emit("disconnect", "Client disconnected");
		}
	}
}
