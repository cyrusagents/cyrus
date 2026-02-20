import { EventEmitter } from "node:events";
import {
	LinearWebhookClient,
	type LinearWebhookPayload,
} from "@linear/sdk/webhooks";
import type { IAgentEventTransport, TranslationContext } from "cyrus-core";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { LinearMessageTranslator } from "./LinearMessageTranslator.js";
import type {
	LinearEventTransportConfig,
	LinearEventTransportEvents,
} from "./types.js";

export declare interface LinearEventTransport {
	on<K extends keyof LinearEventTransportEvents>(
		event: K,
		listener: LinearEventTransportEvents[K],
	): this;
	emit<K extends keyof LinearEventTransportEvents>(
		event: K,
		...args: Parameters<LinearEventTransportEvents[K]>
	): boolean;
}

/**
 * LinearEventTransport - Handles Linear webhook event delivery
 *
 * This class implements IAgentEventTransport to provide a platform-agnostic
 * interface for handling Linear webhooks with Linear-specific verification.
 *
 * It registers a POST /webhook endpoint with a Fastify server
 * and verifies incoming webhooks using either:
 * 1. "direct" mode: Verifies Linear's webhook signature
 * 2. "proxy" mode: Verifies Bearer token authentication
 *
 * The class emits "event" events with AgentEvent (LinearWebhookPayload) data.
 */
export class LinearEventTransport
	extends EventEmitter
	implements IAgentEventTransport
{
	private config: LinearEventTransportConfig;
	private linearWebhookClient: LinearWebhookClient | null = null;
	private logger: ILogger;
	private messageTranslator: LinearMessageTranslator;
	private translationContext: TranslationContext;

	constructor(
		config: LinearEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "LinearEventTransport" });
		this.messageTranslator = new LinearMessageTranslator();
		this.translationContext = translationContext ?? {};

		// Initialize Linear webhook client for direct mode
		if (config.verificationMode === "direct") {
			this.linearWebhookClient = new LinearWebhookClient(config.secret);
		}
	}

	/**
	 * Set the translation context for message translation.
	 * This allows setting Linear API tokens and other context after construction.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Register the /webhook endpoint with the Fastify server
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					// Verify based on mode
					if (this.config.verificationMode === "direct") {
						await this.handleDirectWebhook(request, reply);
					} else {
						await this.handleProxyWebhook(request, reply);
					}
				} catch (error) {
					const err = new Error("Webhook error");
					if (error instanceof Error) {
						err.cause = error;
					}
					this.logger.error("Webhook error", err);
					this.emit("error", err);
					reply.code(500).send({ error: "Internal server error" });
				}
			},
		);

		this.logger.info(
			`Registered POST /webhook endpoint (${this.config.verificationMode} mode)`,
		);
	}

	/**
	 * Handle webhook in direct mode using Linear's signature verification
	 */
	private async handleDirectWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		if (!this.linearWebhookClient) {
			reply.code(500).send({ error: "Linear webhook client not initialized" });
			return;
		}

		// Get Linear signature from headers
		const signature = request.headers["linear-signature"] as string;
		if (!signature) {
			reply.code(401).send({ error: "Missing linear-signature header" });
			return;
		}

		try {
			// Verify the webhook signature using Linear's client
			const bodyBuffer = Buffer.from(JSON.stringify(request.body));
			const isValid = this.linearWebhookClient.verify(bodyBuffer, signature);

			if (!isValid) {
				reply.code(401).send({ error: "Invalid webhook signature" });
				return;
			}

			const payload = request.body as LinearWebhookPayload;

			// Emit "event" for legacy IAgentEventTransport compatibility
			this.emit("event", payload);

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Direct webhook verification failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Direct webhook verification failed", err);
			reply.code(401).send({ error: "Invalid webhook signature" });
		}
	}

	/**
	 * Handle webhook in proxy mode using Bearer token authentication
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		// Get Authorization header
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		// Verify Bearer token
		const expectedAuth = `Bearer ${this.config.secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		try {
			const payload = request.body as LinearWebhookPayload;

			// Emit "event" for legacy IAgentEventTransport compatibility
			this.emit("event", payload);

			// Emit "message" with translated internal message
			this.emitMessage(payload);

			// Send success response
			reply.code(200).send({ success: true });
		} catch (error) {
			const err = new Error("Proxy webhook processing failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Proxy webhook processing failed", err);
			reply.code(500).send({ error: "Failed to process webhook" });
		}
	}

	/**
	 * Translate and emit an internal message from a webhook payload.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(payload: LinearWebhookPayload): void {
		const result = this.messageTranslator.translate(
			payload,
			this.translationContext,
		);

		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}
}
