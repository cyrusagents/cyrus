import { EventEmitter } from "node:events";
import type { TranslationContext } from "cyrus-core";
import { createLogger, type ILogger, ipMatchesAllowlist } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { GitLabMessageTranslator } from "./GitLabMessageTranslator.js";
import type {
	GitLabEventTransportConfig,
	GitLabEventTransportEvents,
	GitLabEventType,
	GitLabMergeRequestPayload,
	GitLabNotePayload,
	GitLabVerificationMode,
	GitLabWebhookEvent,
} from "./types.js";

export declare interface GitLabEventTransport {
	on<K extends keyof GitLabEventTransportEvents>(
		event: K,
		listener: GitLabEventTransportEvents[K],
	): this;
	emit<K extends keyof GitLabEventTransportEvents>(
		event: K,
		...args: Parameters<GitLabEventTransportEvents[K]>
	): boolean;
}

/**
 * GitLabEventTransport - Handles forwarded GitLab webhook event delivery
 *
 * This class provides a typed EventEmitter-based transport
 * for handling GitLab webhooks forwarded from CYHOST.
 *
 * It registers a POST /gitlab-webhook endpoint with a Fastify server
 * and verifies incoming webhooks using either:
 * 1. "proxy" mode: Verifies Bearer token authentication (self-hosted)
 * 2. "signature" mode: Verifies X-Gitlab-Token header (direct webhooks)
 *
 * Supported GitLab event types:
 * - note: Comments/notes on merge requests
 * - merge_request: MR state changes (approved, changes_requested, etc.)
 */
export class GitLabEventTransport extends EventEmitter {
	private config: GitLabEventTransportConfig;
	private logger: ILogger;
	private messageTranslator: GitLabMessageTranslator;
	private translationContext: TranslationContext;

	constructor(
		config: GitLabEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "GitLabEventTransport" });
		this.messageTranslator = new GitLabMessageTranslator();
		this.translationContext = translationContext ?? {};
	}

	/**
	 * Set the translation context for message translation.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Resolve the effective verification mode and secret at request time.
	 * When started in proxy mode, checks if GITLAB_WEBHOOK_SECRET and
	 * CYRUS_HOST_EXTERNAL have been added to the environment since startup,
	 * enabling a runtime switch to signature verification.
	 */
	private resolveVerification(): {
		mode: GitLabVerificationMode;
		secret: string;
	} {
		if (this.config.verificationMode === "signature") {
			return { mode: "signature", secret: this.config.secret };
		}

		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const gitlabSecret = process.env.GITLAB_WEBHOOK_SECRET;
		const hasGitlabSecret = gitlabSecret != null && gitlabSecret !== "";

		if (isExternalHost && hasGitlabSecret) {
			this.logger.info(
				"Runtime switch: GITLAB_WEBHOOK_SECRET detected, using GitLab token verification",
			);
			return { mode: "signature", secret: gitlabSecret };
		}

		return { mode: "proxy", secret: this.config.secret };
	}

	/**
	 * Register the /gitlab-webhook endpoint with the Fastify server
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/gitlab-webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					const { mode, secret } = this.resolveVerification();

					if (mode === "signature") {
						await this.handleSignatureWebhook(request, reply, secret);
					} else {
						await this.handleProxyWebhook(request, reply, secret);
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
			`Registered POST /gitlab-webhook endpoint (${this.config.verificationMode} mode)`,
		);
	}

	/**
	 * Handle webhook using GitLab's X-Gitlab-Token secret verification.
	 * GitLab uses a simple token comparison (not HMAC).
	 */
	private async handleSignatureWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	): Promise<void> {
		// Validate source IP against GitLab's known webhook IPs
		if (
			this.config.ipAllowlist &&
			this.config.ipAllowlist.length > 0 &&
			!ipMatchesAllowlist(request.ip, this.config.ipAllowlist)
		) {
			this.logger.warn(
				`Rejected GitLab webhook from unauthorized IP: ${request.ip}`,
			);
			reply.code(403).send({ error: "Forbidden: unauthorized source IP" });
			return;
		}

		const token = request.headers["x-gitlab-token"] as string;
		if (!token) {
			reply.code(401).send({ error: "Missing X-Gitlab-Token header" });
			return;
		}

		if (token !== secret) {
			reply.code(401).send({ error: "Invalid webhook token" });
			return;
		}

		this.processAndEmitEvent(request, reply);
	}

	/**
	 * Handle webhook using Bearer token authentication (forwarded from CYHOST)
	 */
	private async handleProxyWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	): Promise<void> {
		const authHeader = request.headers.authorization;
		if (!authHeader) {
			reply.code(401).send({ error: "Missing Authorization header" });
			return;
		}

		const expectedAuth = `Bearer ${secret}`;
		if (authHeader !== expectedAuth) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return;
		}

		this.processAndEmitEvent(request, reply);
	}

	/**
	 * Process the webhook request and emit the appropriate event
	 */
	private processAndEmitEvent(
		request: FastifyRequest,
		reply: FastifyReply,
	): void {
		const body = request.body as Record<string, unknown>;
		const objectKind = body.object_kind as string | undefined;
		const accessToken = request.headers["x-gitlab-access-token"] as
			| string
			| undefined;

		if (!objectKind) {
			reply.code(400).send({ error: "Missing object_kind in payload" });
			return;
		}

		if (objectKind !== "note" && objectKind !== "merge_request") {
			this.logger.debug(`Ignoring unsupported event type: ${objectKind}`);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		const payload = body as unknown as
			| GitLabNotePayload
			| GitLabMergeRequestPayload;

		// For note events, only handle notes on merge requests
		if (objectKind === "note") {
			const notePayload = payload as GitLabNotePayload;
			if (notePayload.object_attributes.noteable_type !== "MergeRequest") {
				this.logger.debug(
					`Ignoring note on ${notePayload.object_attributes.noteable_type}`,
				);
				reply.code(200).send({ success: true, ignored: true });
				return;
			}
		}

		// For merge_request events, only handle specific actions
		if (objectKind === "merge_request") {
			const mrPayload = payload as GitLabMergeRequestPayload;
			const action = mrPayload.object_attributes.action;
			if (action !== "approved" && action !== "unapproved") {
				this.logger.debug(`Ignoring merge_request with action: ${action}`);
				reply.code(200).send({ success: true, ignored: true });
				return;
			}
		}

		const webhookEvent: GitLabWebhookEvent = {
			eventType: objectKind as GitLabEventType,
			payload,
			accessToken,
		};

		this.logger.info(
			`Received ${objectKind} webhook from ${payload.project.path_with_namespace}`,
		);

		// Emit "event" for legacy compatibility
		this.emit("event", webhookEvent);

		// Emit "message" with translated internal message
		this.emitMessage(webhookEvent);

		reply.code(200).send({ success: true });
	}

	/**
	 * Translate and emit an internal message from a webhook event.
	 */
	private emitMessage(event: GitLabWebhookEvent): void {
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
}
