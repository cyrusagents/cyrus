import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import { createLogger, type ILogger } from "cyrus-core";

/**
 * Shared webhook server that can handle multiple Linear tokens
 * Each token has its own webhook secret for signature verification
 */
export class SharedWebhookServer {
	private server: ReturnType<typeof createServer> | null = null;
	private webhookHandlers = new Map<
		string,
		{
			secret: string;
			handler: (body: string, signature: string, timestamp?: string) => boolean;
		}
	>();
	private port: number;
	private host: string;
	private isListening = false;
	private logger: ILogger;

	constructor(
		port: number = 3456,
		host: string = "localhost",
		logger?: ILogger,
	) {
		this.port = port;
		this.host = host;
		this.logger = logger ?? createLogger({ component: "SharedWebhookServer" });
	}

	/**
	 * Start the shared webhook server
	 */
	async start(): Promise<void> {
		if (this.isListening) {
			return; // Already listening
		}

		return new Promise((resolve, reject) => {
			this.server = createServer((req, res) => {
				this.handleWebhookRequest(req, res);
			});

			this.server.listen(this.port, this.host, () => {
				this.isListening = true;
				this.logger.info(
					`Shared webhook server listening on http://${this.host}:${this.port}`,
				);
				resolve();
			});

			this.server.on("error", (error) => {
				this.isListening = false;
				reject(error);
			});
		});
	}

	/**
	 * Stop the shared webhook server
	 */
	async stop(): Promise<void> {
		if (this.server && this.isListening) {
			return new Promise((resolve) => {
				this.server!.close(() => {
					this.isListening = false;
					this.logger.info("Shared webhook server stopped");
					resolve();
				});
			});
		}
	}

	/**
	 * Register a webhook handler for a specific token
	 */
	registerWebhookHandler(
		token: string,
		secret: string,
		handler: (body: string, signature: string, timestamp?: string) => boolean,
	): void {
		this.webhookHandlers.set(token, { secret, handler });
		this.logger.info(
			`Registered webhook handler for token ending in ...${token.slice(-4)}`,
		);
	}

	/**
	 * Unregister a webhook handler
	 */
	unregisterWebhookHandler(token: string): void {
		this.webhookHandlers.delete(token);
		this.logger.info(
			`Unregistered webhook handler for token ending in ...${token.slice(-4)}`,
		);
	}

	/**
	 * Get the webhook URL for registration with proxy
	 */
	getWebhookUrl(): string {
		return `http://${this.host}:${this.port}/webhook`;
	}

	/**
	 * Handle incoming webhook requests
	 */
	private async handleWebhookRequest(
		req: IncomingMessage,
		res: ServerResponse,
	): Promise<void> {
		try {
			this.logger.debug(`Incoming webhook request: ${req.method} ${req.url}`);

			if (req.method !== "POST") {
				this.logger.debug(`Rejected non-POST request: ${req.method}`);
				res.writeHead(405, { "Content-Type": "text/plain" });
				res.end("Method Not Allowed");
				return;
			}

			if (req.url !== "/webhook") {
				this.logger.debug(`Rejected request to wrong URL: ${req.url}`);
				res.writeHead(404, { "Content-Type": "text/plain" });
				res.end("Not Found");
				return;
			}

			// Read request body
			let body = "";
			req.on("data", (chunk) => {
				body += chunk.toString();
			});

			req.on("end", () => {
				try {
					const signature = req.headers["x-webhook-signature"] as string;
					const timestamp = req.headers["x-webhook-timestamp"] as string;

					this.logger.debug(
						`Webhook received with ${body.length} bytes, ${this.webhookHandlers.size} registered handlers`,
					);

					if (!signature) {
						this.logger.debug("Webhook rejected: Missing signature header");
						res.writeHead(400, { "Content-Type": "text/plain" });
						res.end("Missing signature");
						return;
					}

					// Try each registered handler until one verifies the signature
					let handlerAttempts = 0;
					for (const [token, { handler }] of this.webhookHandlers) {
						handlerAttempts++;
						try {
							if (handler(body, signature, timestamp)) {
								// Handler verified signature and processed webhook
								res.writeHead(200, { "Content-Type": "text/plain" });
								res.end("OK");
								this.logger.debug(
									`Webhook delivered to token ending in ...${token.slice(-4)} (attempt ${handlerAttempts}/${this.webhookHandlers.size})`,
								);
								return;
							}
						} catch (error) {
							this.logger.error(
								`Error in webhook handler for token ...${token.slice(-4)}:`,
								error,
							);
						}
					}

					// No handler could verify the signature
					this.logger.error(
						`Webhook signature verification failed for all ${this.webhookHandlers.size} registered handlers`,
					);
					res.writeHead(401, { "Content-Type": "text/plain" });
					res.end("Unauthorized");
				} catch (error) {
					this.logger.error("Error processing webhook:", error);
					res.writeHead(400, { "Content-Type": "text/plain" });
					res.end("Bad Request");
				}
			});

			req.on("error", (error) => {
				this.logger.error("Request error:", error);
				res.writeHead(500, { "Content-Type": "text/plain" });
				res.end("Internal Server Error");
			});
		} catch (error) {
			this.logger.error("Webhook request error:", error);
			res.writeHead(500, { "Content-Type": "text/plain" });
			res.end("Internal Server Error");
		}
	}
}
