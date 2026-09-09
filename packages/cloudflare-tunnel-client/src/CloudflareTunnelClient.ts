import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { bin, install, Tunnel } from "cloudflared";
import type { CloudflareTunnelClientEvents } from "./types.js";

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
 * Cloudflare tunnel client for establishing tunnels to local services
 * Handles ONLY tunnel establishment - HTTP handling is done by SharedApplicationServer
 */
export class CloudflareTunnelClient extends EventEmitter {
	private tunnelProcess: ChildProcess | null = null;
	private tunnelUrl: string | null = null;
	private connected = false;
	private connectionCount = 0;
	private cloudflareToken: string;
	private localPort: number;

	constructor(
		cloudflareToken: string,
		localPort: number,
		onReady?: (tunnelUrl: string) => void,
	) {
		super();
		this.cloudflareToken = cloudflareToken;
		this.localPort = localPort;

		// Set up onReady callback if provided
		if (onReady) {
			this.on("ready", onReady);
		}
	}

	/**
	 * Start the Cloudflare tunnel
	 */
	async startTunnel(): Promise<void> {
		try {
			// Ensure cloudflared binary is installed
			if (!existsSync(bin)) {
				await install(bin);
			}

			console.log(`Starting tunnel to localhost:${this.localPort}`);

			// Create tunnel with token-based authentication (no URL needed for remotely-managed tunnels)
			const tunnel = Tunnel.withToken(this.cloudflareToken);

			// Listen for URL event (from ConfigHandler for token-based tunnels)
			tunnel.on("url", (url: string) => {
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
				this.connectionCount++;
				console.log(
					`Cloudflare tunnel connection ${this.connectionCount}/4 established:`,
					connection,
				);

				// Emit 'connected' event for each connection (for external listeners)
				this.emit("connected", connection);

				// Mark as connected on first connection, but log all 4
				if (!this.connected) {
					this.connected = true;
					this.emit("connect");
				}
			});

			// Listen for error event
			tunnel.on("error", (error: Error) => {
				this.emit("error", error);
			});

			// Listen for exit event
			tunnel.on("exit", (code: number | null) => {
				this.connected = false;
				this.connectionCount = 0; // Reset count on disconnect for fresh reconnection logs
				this.emit("disconnect", `Tunnel process exited with code ${code}`);
			});

			// Wait for tunnel URL to be available (with timeout)
			// 120s: slow DNS resolvers (e.g. dead IPv6 nameservers ahead of the
			// working one) can delay the first connection past 30s
			await this.waitForTunnelToConnect(120000);
		} catch (error) {
			this.emit("error", error as Error);
			throw error;
		}
	}

	/**
	 * Wait for tunnel URL to be available
	 */
	private async waitForTunnelToConnect(timeout: number): Promise<void> {
		const startTime = Date.now();

		while (!this.connected) {
			if (Date.now() - startTime > timeout) {
				throw new Error("Timeout waiting for tunnel URL");
			}

			await new Promise((resolve) => setTimeout(resolve, 100));
		}
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
	 * Disconnect and cleanup
	 */
	disconnect(): void {
		if (this.tunnelProcess) {
			this.tunnelProcess.kill();
			this.tunnelProcess = null;
		}

		this.connected = false;
		this.connectionCount = 0; // Reset count on disconnect for fresh reconnection logs
		this.emit("disconnect", "Client disconnected");
	}
}
