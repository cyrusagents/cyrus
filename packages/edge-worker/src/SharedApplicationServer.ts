import type { IncomingMessage, ServerResponse } from "node:http";
import { CloudflareTunnelClient } from "cyrus-cloudflare-tunnel-client";
import { createLogger, type ILogger } from "cyrus-core";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";

const ROBOTS_TXT = "User-agent: *\nDisallow: /\n";
const ROBOTS_HEADER = "noindex, nofollow";

/**
 * OAuth callback state for tracking flows
 */
export interface OAuthCallback {
	resolve: (credentials: {
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}) => void;
	reject: (error: Error) => void;
	id: string;
}

/**
 * Approval callback state for tracking approval workflows
 */
export interface ApprovalCallback {
	resolve: (approved: boolean, feedback?: string) => void;
	reject: (error: Error) => void;
	sessionId: string;
	createdAt: number;
}

/**
 * Shared application server that handles both webhooks and OAuth callbacks on a single port
 * Consolidates functionality from SharedWebhookServer and CLI OAuth server
 */
export class SharedApplicationServer {
	private app: FastifyInstance | null = null;
	private webhookHandlers = new Map<
		string,
		{
			secret: string;
			handler: (body: string, signature: string, timestamp?: string) => boolean;
		}
	>();
	// Legacy handlers for direct Linear webhook registration (deprecated)
	private linearWebhookHandlers = new Map<
		string,
		(req: IncomingMessage, res: ServerResponse) => Promise<void>
	>();
	private oauthCallbacks = new Map<string, OAuthCallback>();
	private pendingApprovals = new Map<string, ApprovalCallback>();
	private port: number;
	private host: string;
	private isListening = false;
	private tunnelClient: CloudflareTunnelClient | null = null;
	/** Fails a pending startCloudflareTunnel() promise; set only while it is pending */
	private cancelTunnelStartup: ((error: Error) => void) | null = null;
	private skipTunnel: boolean;
	private logger: ILogger;

	constructor(
		port: number = 3456,
		host: string = "localhost",
		skipTunnel: boolean = false,
		logger?: ILogger,
	) {
		this.port = port;
		this.host = host;
		this.skipTunnel = skipTunnel;
		this.logger =
			logger ?? createLogger({ component: "SharedApplicationServer" });
	}

	/**
	 * Initialize the Fastify app instance (must be called before registering routes)
	 */
	initializeFastify(): void {
		if (this.app) {
			return; // Already initialized
		}

		this.app = Fastify({
			logger: false,
			trustProxy: true,
		});

		this.app.addHook("onRequest", (_request, reply, done) => {
			reply.header("X-Robots-Tag", ROBOTS_HEADER);
			done();
		});

		this.app.get("/robots.txt", async (_request, reply) => {
			return reply
				.type("text/plain; charset=utf-8")
				.header("Cache-Control", "public, max-age=3600")
				.send(ROBOTS_TXT);
		});

		// Preserve raw request body for webhook signature verification (GitHub HMAC-SHA256).
		// Fastify's default JSON parser discards the raw bytes, but signature checks need
		// the exact payload GitHub sent. This replaces the default parser with one that
		// stashes the raw string on `request.rawBody` before parsing.
		this.app.addContentTypeParser(
			"application/json",
			{ parseAs: "string" },
			(
				req: FastifyRequest,
				body: string,
				done: (err: Error | null, result?: unknown) => void,
			) => {
				(req as FastifyRequest & { rawBody: string }).rawBody = body;
				try {
					done(null, JSON.parse(body));
				} catch (err) {
					done(err as Error);
				}
			},
		);
	}

	/**
	 * Start the shared application server
	 */
	async start(): Promise<void> {
		if (this.isListening) {
			return; // Already listening
		}

		// Initialize Fastify if not already done
		this.initializeFastify();

		try {
			await this.app!.listen({
				port: this.port,
				host: this.host,
			});

			this.isListening = true;
			this.logger.info(
				`Shared application server listening on http://${this.host}:${this.port}`,
			);

			// Start Cloudflare tunnel if CLOUDFLARE_TOKEN is set and tunnel is not skipped
			if (!this.skipTunnel && process.env.CLOUDFLARE_TOKEN) {
				await this.startCloudflareTunnel(process.env.CLOUDFLARE_TOKEN);
			}
		} catch (error) {
			this.isListening = false;
			throw error;
		}
	}

	/**
	 * Start Cloudflare tunnel and wait for 4 'connected' events
	 */
	async startCloudflareTunnel(cloudflareToken: string): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			let connectionCount = 0;
			const requiredConnections = 4;
			let settled = false;
			let startupTimeout: NodeJS.Timeout | null = null;

			const tunnelClient = new CloudflareTunnelClient(
				cloudflareToken,
				this.port,
			);
			this.tunnelClient = tunnelClient;

			const succeed = () => {
				if (settled) return;
				settled = true;
				if (startupTimeout) clearTimeout(startupTimeout);
				if (this.cancelTunnelStartup === fail) this.cancelTunnelStartup = null;
				resolve();
			};
			// Startup failed: stop the client so its cloudflared child is killed
			// and it never attempts post-start recovery
			const fail = (error: Error) => {
				if (settled) return;
				settled = true;
				if (startupTimeout) clearTimeout(startupTimeout);
				if (this.cancelTunnelStartup === fail) this.cancelTunnelStartup = null;
				tunnelClient.disconnect();
				if (this.tunnelClient === tunnelClient) {
					this.tunnelClient = null;
				}
				reject(error);
			};

			// Listen for connection events (Cloudflare establishes 4 connections per tunnel)
			tunnelClient.on("connected", () => {
				// After startup, reconnections are logged by the tunnel client
				if (settled) return;
				connectionCount++;
				this.logger.info(
					`Cloudflare tunnel connection ${connectionCount}/${requiredConnections} established`,
				);

				if (connectionCount === requiredConnections) {
					this.logger.info("Cloudflare tunnel fully connected and ready");
					succeed();
				}
			});

			// Listen for ready event to get tunnel URL
			tunnelClient.on("ready", (tunnelUrl: string) => {
				this.logger.info(`Cloudflare tunnel URL: ${tunnelUrl}`);
			});

			// Listen for error events
			tunnelClient.on("error", (error: Error) => {
				this.logger.error("Cloudflare tunnel error:", error);
				fail(error);
			});

			// Listen for disconnect events. Unexpected post-start exits are
			// restarted by the tunnel client itself with bounded backoff.
			tunnelClient.on("disconnect", (reason: string) => {
				this.logger.info(`Cloudflare tunnel disconnected: ${reason}`);
				// A restarted child must establish its own connections
				if (!settled) connectionCount = 0;
			});

			// Reconnection after an unexpected post-start exit
			tunnelClient.on("connect", () => {
				if (settled) {
					this.logger.info("Cloudflare tunnel reconnected");
				}
			});

			// stop() can cancel startup at any point, including after the client's
			// first connection but before all 4 have registered
			this.cancelTunnelStartup = fail;

			// Start the tunnel
			tunnelClient.startTunnel().catch(fail);

			// Timeout after 120 seconds (slow DNS resolvers can delay cloudflared
			// connection registration past 30s, e.g. on cloud Macs with dead
			// IPv6 nameservers ahead of the working resolver)
			startupTimeout = setTimeout(() => {
				fail(
					new Error(
						`Timeout waiting for Cloudflare tunnel (${connectionCount}/${requiredConnections} connections). This is usually caused by firewall/VPN/proxy blocking cloudflared. See troubleshooting: https://github.com/ceedaragents/cyrus/blob/main/docs/CLOUDFLARE_TUNNEL.md#troubleshooting`,
					),
				);
			}, 120000);
		});
	}

	/**
	 * Stop the shared application server
	 */
	async stop(): Promise<void> {
		// Reject all pending approvals before shutdown
		for (const [sessionId, approval] of this.pendingApprovals) {
			approval.reject(new Error("Server shutting down"));
			this.logger.debug(
				`Rejected pending approval for session ${sessionId} due to shutdown`,
			);
		}
		this.pendingApprovals.clear();

		// Fail a still-pending tunnel startup promptly (this also stops its client)
		if (this.cancelTunnelStartup) {
			this.cancelTunnelStartup(
				new Error(
					"Shared application server stopped during Cloudflare tunnel startup",
				),
			);
			this.logger.info("Cloudflare tunnel startup cancelled");
		}

		// Stop Cloudflare tunnel if running
		if (this.tunnelClient) {
			this.tunnelClient.disconnect();
			this.tunnelClient = null;
			this.logger.info("Cloudflare tunnel stopped");
		}

		if (this.app && this.isListening) {
			await this.app.close();
			this.isListening = false;
			this.logger.info("Shared application server stopped");
		}
	}

	/**
	 * Get the port number the server is listening on
	 */
	getPort(): number {
		return this.port;
	}

	/**
	 * Get the Fastify instance for registering routes
	 * Initializes Fastify if not already done
	 */
	getFastifyInstance(): FastifyInstance {
		this.initializeFastify();
		return this.app!;
	}

	/**
	 * Register a webhook handler for a specific token (LEGACY - deprecated)
	 * Supports two signatures:
	 * 1. For ndjson-client: (token, secret, handler)
	 * 2. For legacy direct registration: (token, handler) where handler takes (req, res)
	 *
	 * NOTE: New code should use LinearEventTransport which registers routes directly with Fastify
	 */
	registerWebhookHandler(
		token: string,
		secretOrHandler:
			| string
			| ((req: IncomingMessage, res: ServerResponse) => Promise<void>),
		handler?: (body: string, signature: string, timestamp?: string) => boolean,
	): void {
		if (typeof secretOrHandler === "string" && handler) {
			// ndjson-client style registration
			this.webhookHandlers.set(token, { secret: secretOrHandler, handler });
			this.logger.debug(
				`Registered webhook handler (proxy-style) for token ending in ...${token.slice(-4)}`,
			);
		} else if (typeof secretOrHandler === "function") {
			// Legacy direct registration
			this.linearWebhookHandlers.set(token, secretOrHandler);
			this.logger.debug(
				`Registered webhook handler (legacy direct-style) for token ending in ...${token.slice(-4)}`,
			);
		} else {
			throw new Error("Invalid webhook handler registration parameters");
		}
	}

	/**
	 * Unregister a webhook handler
	 */
	unregisterWebhookHandler(token: string): void {
		const hadProxyHandler = this.webhookHandlers.delete(token);
		const hadDirectHandler = this.linearWebhookHandlers.delete(token);
		if (hadProxyHandler || hadDirectHandler) {
			this.logger.debug(
				`Unregistered webhook handler for token ending in ...${token.slice(-4)}`,
			);
		}
	}

	/**
	 * Start OAuth flow and return promise that resolves when callback is received
	 */
	async startOAuthFlow(proxyUrl: string): Promise<{
		linearToken: string;
		linearWorkspaceId: string;
		linearWorkspaceName: string;
	}> {
		return new Promise<{
			linearToken: string;
			linearWorkspaceId: string;
			linearWorkspaceName: string;
		}>((resolve, reject) => {
			// Generate unique ID for this flow
			const flowId = Date.now().toString();

			// Store callback for this flow
			this.oauthCallbacks.set(flowId, { resolve, reject, id: flowId });

			// Check if we should use direct Linear OAuth (when self-hosting)
			const isExternalHost =
				process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
			const useDirectOAuth = isExternalHost && process.env.LINEAR_CLIENT_ID;

			const callbackBaseUrl = `http://${this.host}:${this.port}`;
			let authUrl: string;

			if (useDirectOAuth) {
				// Use local OAuth authorize endpoint
				authUrl = `${callbackBaseUrl}/oauth/authorize?callback=${encodeURIComponent(`${callbackBaseUrl}/callback`)}`;
				this.logger.info(`Using direct OAuth mode (CYRUS_HOST_EXTERNAL=true)`);
			} else {
				// Use proxy OAuth endpoint
				authUrl = `${proxyUrl}/oauth/authorize?callback=${encodeURIComponent(`${callbackBaseUrl}/callback`)}`;
			}

			this.logger.info(`Opening your browser to authorize with Linear...`);
			this.logger.info(`If the browser doesn't open, visit: ${authUrl}`);

			// Timeout after 5 minutes
			setTimeout(
				() => {
					if (this.oauthCallbacks.has(flowId)) {
						this.oauthCallbacks.delete(flowId);
						reject(new Error("OAuth timeout"));
					}
				},
				5 * 60 * 1000,
			);
		});
	}

	/**
	 * Get the webhook URL
	 */
	getWebhookUrl(): string {
		return `http://${this.host}:${this.port}/linear-webhook`;
	}

	/**
	 * Get the OAuth callback URL for registration with proxy
	 */
	getOAuthCallbackUrl(): string {
		return `http://${this.host}:${this.port}/callback`;
	}

	/**
	 * Register an approval request and get approval URL
	 */
	registerApprovalRequest(sessionId: string): {
		promise: Promise<{ approved: boolean; feedback?: string }>;
		url: string;
	} {
		// Clean up expired approvals (older than 30 minutes)
		const now = Date.now();
		for (const [key, approval] of this.pendingApprovals) {
			if (now - approval.createdAt > 30 * 60 * 1000) {
				approval.reject(new Error("Approval request expired"));
				this.pendingApprovals.delete(key);
			}
		}

		// Create promise for this approval request
		const promise = new Promise<{ approved: boolean; feedback?: string }>(
			(resolve, reject) => {
				this.pendingApprovals.set(sessionId, {
					resolve: (approved, feedback) => resolve({ approved, feedback }),
					reject,
					sessionId,
					createdAt: now,
				});
			},
		);

		// Generate approval URL
		const url = `http://${this.host}:${this.port}/approval?session=${encodeURIComponent(sessionId)}`;

		this.logger.debug(
			`Registered approval request for session ${sessionId}: ${url}`,
		);

		return { promise, url };
	}
}
