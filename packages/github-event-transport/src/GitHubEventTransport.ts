import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TranslationContext } from "cyrus-core";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GitHubMessageTranslator } from "./GitHubMessageTranslator.js";
import type {
	GitHubEventTransportConfig,
	GitHubEventTransportEvents,
	GitHubEventType,
	GitHubIssueCommentPayload,
	GitHubPullRequestReviewCommentPayload,
	GitHubWebhookEvent,
} from "./types.js";

export declare interface GitHubEventTransport {
	on<K extends keyof GitHubEventTransportEvents>(
		event: K,
		listener: GitHubEventTransportEvents[K],
	): this;
	emit<K extends keyof GitHubEventTransportEvents>(
		event: K,
		...args: Parameters<GitHubEventTransportEvents[K]>
	): boolean;
}

/**
 * GitHubEventTransport - Handles forwarded GitHub webhook event delivery
 *
 * This class provides a typed EventEmitter-based transport
 * for handling GitHub webhooks forwarded from CYHOST.
 *
 * It registers a POST /github-webhook endpoint with a Fastify server
 * and verifies incoming webhooks using either:
 * 1. "proxy" mode: Verifies Bearer token authentication (self-hosted)
 * 2. "signature" mode: Verifies GitHub's HMAC-SHA256 signature (cloud)
 *
 * Supported GitHub event types:
 * - issue_comment: Comments on PR issues (top-level PR comments)
 * - pull_request_review_comment: Inline review comments on PR diffs
 */
export class GitHubEventTransport extends EventEmitter {
	private config: GitHubEventTransportConfig;
	private logger: ILogger;
	private messageTranslator: GitHubMessageTranslator;
	private translationContext: TranslationContext;

	constructor(
		config: GitHubEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "GitHubEventTransport" });
		this.messageTranslator = new GitHubMessageTranslator();
		this.translationContext = translationContext ?? {};
	}

	/**
	 * Set the translation context for message translation.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Register the /github-webhook endpoint with the Fastify server
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/github-webhook",
			{
				config: {
					rawBody: true,
				},
			},
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					if (this.config.verificationMode === "signature") {
						await this.handleSignatureWebhook(request, reply);
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
			`Registered POST /github-webhook endpoint (${this.config.verificationMode} mode)`,
		);
	}

	/**
	 * Handle webhook using GitHub's HMAC-SHA256 signature verification
	 */
	private async handleSignatureWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		const signature = request.headers["x-hub-signature-256"] as string;
		if (!signature) {
			reply.code(401).send({ error: "Missing x-hub-signature-256 header" });
			return;
		}

		try {
			const body = (request as FastifyRequest & { rawBody: string }).rawBody;
			const isValid = this.verifyGitHubSignature(
				body,
				signature,
				this.config.secret,
			);

			if (!isValid) {
				reply.code(401).send({ error: "Invalid webhook signature" });
				return;
			}

			this.processAndEmitEvent(request, reply);
		} catch (error) {
			const err = new Error("Signature verification failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Signature verification failed", err);
			reply.code(401).send({ error: "Invalid webhook signature" });
		}
	}

	/**
	 * Handle webhook using Bearer token authentication (forwarded from CYHOST)
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
	): Promise<void> {
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		const expectedAuth = `Bearer ${this.config.secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		try {
			this.processAndEmitEvent(request, reply);
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
	 * Process the webhook request and emit the appropriate event
	 */
	private processAndEmitEvent(
		request: FastifyRequest,
		reply: FastifyReply,
	): void {
		const eventType = request.headers["x-github-event"] as string;
		const deliveryId =
			(request.headers["x-github-delivery"] as string) || "unknown";
		const installationToken = request.headers["x-github-installation-token"] as
			| string
			| undefined;

		if (!eventType) {
			reply.code(400).send({ error: "Missing x-github-event header" });
			return;
		}

		if (
			eventType !== "issue_comment" &&
			eventType !== "pull_request_review_comment"
		) {
			this.logger.debug(`Ignoring unsupported event type: ${eventType}`);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		const payload = request.body as
			| GitHubIssueCommentPayload
			| GitHubPullRequestReviewCommentPayload;

		// Only handle 'created' actions (new comments, not edits/deletes)
		if (payload.action !== "created") {
			this.logger.debug(`Ignoring ${eventType} with action: ${payload.action}`);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		const webhookEvent: GitHubWebhookEvent = {
			eventType: eventType as GitHubEventType,
			deliveryId,
			payload,
			installationToken,
		};

		this.logger.info(`Received ${eventType} webhook (delivery: ${deliveryId})`);

		// Emit "event" for legacy compatibility
		this.emit("event", webhookEvent);

		// Emit "message" with translated internal message
		this.emitMessage(webhookEvent);

		reply.code(200).send({ success: true });
	}

	/**
	 * Translate and emit an internal message from a webhook event.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(event: GitHubWebhookEvent): void {
		const result = this.messageTranslator.translate(
			event,
			this.translationContext,
		);

		if (result.success) {
			this.emit("message", result.message);
		} else {
			this.logger.debug(`Message translation skipped: ${result.reason}`);
		}
	}

	/**
	 * Verify GitHub webhook signature using HMAC-SHA256
	 */
	private verifyGitHubSignature(
		body: string,
		signature: string,
		secret: string,
	): boolean {
		const expectedSignature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

		if (signature.length !== expectedSignature.length) {
			return false;
		}

		return timingSafeEqual(
			Buffer.from(signature),
			Buffer.from(expectedSignature),
		);
	}
}
