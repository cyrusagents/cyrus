import { createHmac, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import type { TranslationContext } from "cyrus-core";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import { SlackMessageTranslator } from "./SlackMessageTranslator.js";
import type {
	SlackEventEnvelope,
	SlackEventTransportConfig,
	SlackEventTransportEvents,
	SlackMessageEvent,
	SlackVerificationMode,
	SlackWebhookEvent,
} from "./types.js";

export declare interface SlackEventTransport {
	on<K extends keyof SlackEventTransportEvents>(
		event: K,
		listener: SlackEventTransportEvents[K],
	): this;
	emit<K extends keyof SlackEventTransportEvents>(
		event: K,
		...args: Parameters<SlackEventTransportEvents[K]>
	): boolean;
}

/**
 * SlackEventTransport - Handles forwarded Slack webhook event delivery
 *
 * This class provides a typed EventEmitter-based transport
 * for handling Slack webhooks forwarded from CYHOST.
 *
 * It registers a POST /slack-webhook endpoint with a Fastify server
 * and verifies incoming webhooks using Bearer token authentication.
 *
 * Supported Slack event types:
 * - app_mention: When the bot is mentioned with @ in a channel or thread.
 *   Always emitted — starts or resumes a session for the thread.
 * - message: A plain message in a channel/thread the bot can see. Emitted only
 *   for threaded replies that aren't the bot's own message and aren't a
 *   subtype event (edits, joins, etc.). Whether it actually does anything is
 *   decided downstream (the runtime lifecycle only continues already-bound
 *   threads). Slack delivers both an `app_mention` AND a `message` event for a
 *   message that mentions the bot, so identical `(channel, ts)` pairs are
 *   de-duplicated here to avoid double-prompting.
 */
export class SlackEventTransport extends EventEmitter {
	private config: SlackEventTransportConfig;
	private logger: ILogger;
	private messageTranslator: SlackMessageTranslator;
	private translationContext: TranslationContext;
	/**
	 * Recently emitted `channel:ts` keys, used to collapse Slack's
	 * double-delivery of app_mention + message for the same underlying message.
	 * Maps key → epoch ms first seen; pruned by TTL.
	 */
	private recentMessageKeys: Map<string, number> = new Map();
	private static readonly DEDUP_TTL_MS = 10 * 60 * 1000;

	constructor(
		config: SlackEventTransportConfig,
		logger?: ILogger,
		translationContext?: TranslationContext,
	) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "SlackEventTransport" });
		this.messageTranslator = new SlackMessageTranslator();
		this.translationContext = translationContext ?? {};
	}

	/**
	 * Set the translation context for message translation.
	 */
	setTranslationContext(context: TranslationContext): void {
		this.translationContext = { ...this.translationContext, ...context };
	}

	/**
	 * Get Slack bot token from the SLACK_BOT_TOKEN environment variable.
	 */
	private getSlackBotToken(): string | undefined {
		return process.env.SLACK_BOT_TOKEN;
	}

	/**
	 * Resolve the effective verification mode and secret at request time.
	 * When started in proxy mode, checks if SLACK_SIGNING_SECRET and
	 * CYRUS_HOST_EXTERNAL have been added to the environment since startup,
	 * enabling a runtime switch to direct verification.
	 *
	 * Encapsulates all mode-switch detection and logging so callers only
	 * need to dispatch on the returned mode (SRP).
	 */
	private resolveVerification(): {
		mode: SlackVerificationMode;
		secret: string;
	} {
		// If already configured for direct mode at startup, keep using it
		if (this.config.verificationMode === "direct") {
			return { mode: "direct", secret: this.config.secret };
		}

		// Check if direct mode env vars have been added at runtime
		const isExternalHost =
			process.env.CYRUS_HOST_EXTERNAL?.toLowerCase().trim() === "true";
		const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
		const hasSlackSigningSecret =
			slackSigningSecret != null && slackSigningSecret !== "";

		if (isExternalHost && hasSlackSigningSecret) {
			this.logger.info(
				"Runtime switch: SLACK_SIGNING_SECRET detected, using direct Slack signature verification",
			);
			return { mode: "direct", secret: slackSigningSecret };
		}

		// Fall back to proxy mode with original config secret
		return { mode: "proxy", secret: this.config.secret };
	}

	/**
	 * Register the /slack-webhook endpoint with the Fastify server
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/slack-webhook",
			{
				config: {
					rawBody: true,
				},
			},
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					const { mode, secret } = this.resolveVerification();

					if (mode === "direct") {
						await this.handleDirectWebhook(request, reply, secret);
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
			`Registered POST /slack-webhook endpoint (${this.config.verificationMode} mode)`,
		);
	}

	/**
	 * Handle webhook using Slack signing secret (direct from Slack)
	 */
	private async handleDirectWebhook(
		request: FastifyRequest,
		reply: FastifyReply,
		secret: string,
	): Promise<void> {
		const timestamp = request.headers["x-slack-request-timestamp"] as string;
		const signature = request.headers["x-slack-signature"] as string;

		if (!timestamp || !signature) {
			reply.code(401).send({ error: "Missing Slack signature headers" });
			return;
		}

		// Reject requests older than 5 minutes (replay attack prevention)
		const requestAge = Math.abs(
			Math.floor(Date.now() / 1000) - parseInt(timestamp, 10),
		);
		if (requestAge > 60 * 5) {
			reply.code(401).send({ error: "Request timestamp too old" });
			return;
		}

		try {
			const body = (request as FastifyRequest & { rawBody: string }).rawBody;
			const isValid = this.verifySlackSignature(
				body,
				timestamp,
				signature,
				secret,
			);

			if (!isValid) {
				reply.code(401).send({ error: "Invalid webhook signature" });
				return;
			}

			// Direct mode: Slack delivers events straight to us with no upstream
			// gate, so the runtime must self-gate plain messages on its in-memory
			// thread bindings.
			this.processAndEmitEvent(request, reply, false);
		} catch (error) {
			const err = new Error("Slack signature verification failed");
			if (error instanceof Error) {
				err.cause = error;
			}
			this.logger.error("Slack signature verification failed", err);
			reply.code(401).send({ error: "Invalid webhook signature" });
		}
	}

	/**
	 * Verify Slack request signature using HMAC-SHA256
	 * @see https://api.slack.com/authentication/verifying-requests-from-slack
	 */
	private verifySlackSignature(
		body: string,
		timestamp: string,
		signature: string,
		secret: string,
	): boolean {
		const sigBaseString = `v0:${timestamp}:${body}`;
		const expectedSignature = `v0=${createHmac("sha256", secret)
			.update(sigBaseString)
			.digest("hex")}`;

		if (signature.length !== expectedSignature.length) {
			return false;
		}

		return timingSafeEqual(
			Buffer.from(signature),
			Buffer.from(expectedSignature),
		);
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

		try {
			// Proxy mode: CYHOST already verified this event against its
			// persistent thread bindings before forwarding, so a `message` event
			// reaching us is trusted to (re)start a session for its thread.
			this.processAndEmitEvent(request, reply, true);
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
		upstreamGated: boolean,
	): void {
		const envelope = request.body as SlackEventEnvelope;

		// Handle Slack URL verification challenge
		if (envelope.type === "url_verification") {
			this.logger.info("Responding to Slack URL verification challenge");
			reply.code(200).send({ challenge: envelope.challenge });
			return;
		}

		if (envelope.type !== "event_callback") {
			this.logger.debug(`Ignoring unsupported envelope type: ${envelope.type}`);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		const event = envelope.event;

		// Slack sends many event types at runtime; the envelope type only models
		// the two we handle, so widen to string for the membership check.
		const eventType = event?.type as string | undefined;
		if (eventType !== "app_mention" && eventType !== "message") {
			this.logger.debug(
				`Ignoring unsupported event type: ${eventType ?? "unknown"}`,
			);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		// Thread-following can be disabled (per-team toggle pushed via config, or
		// the CYRUS_SLACK_THREAD_FOLLOWING_DISABLED env kill-switch). When off,
		// behave exactly like the app_mention-only runtime: drop `message` events
		// here — BEFORE the de-dup below records their (channel, ts) — so a
		// mention's `message` twin can never suppress its `app_mention`.
		if (
			event.type === "message" &&
			this.config.isThreadFollowingEnabled &&
			!this.config.isThreadFollowingEnabled()
		) {
			this.logger.debug(
				`Slack thread-following disabled; ignoring message event (channel ${event.channel})`,
			);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		// `message` events fire for every message in every channel the bot can
		// see, so apply cheap structural filters before doing any work. Anything
		// that gets through here is a candidate follow-up prompt; the binding
		// check (is this thread actually bound to Cyrus?) happens downstream.
		if (event.type === "message" && !this.shouldEmitMessageEvent(event)) {
			reply.code(200).send({ success: true, ignored: true });
			return;
		}

		// Slack delivers both an app_mention and a message event for a single
		// message that mentions the bot. De-duplicate on (channel, ts) so the
		// thread only gets prompted once. The first event to arrive wins; both
		// carry identical text.
		const dedupKey = `${event.channel}:${event.ts}`;
		if (this.isDuplicateMessage(dedupKey)) {
			this.logger.debug(
				`Ignoring duplicate Slack event for ${dedupKey} (already processed)`,
			);
			reply.code(200).send({ success: true, ignored: true });
			return;
		}
		this.rememberMessage(dedupKey);

		// Token may be undefined during startup transitions (e.g. switching runtimes)
		// when the env update hasn't been processed yet. Downstream consumers
		// (SlackChatAdapter) fall back to process.env.SLACK_BOT_TOKEN at usage time.
		const slackBotToken = this.getSlackBotToken();

		const webhookEvent: SlackWebhookEvent = {
			eventType: event.type,
			eventId: envelope.event_id,
			payload: event,
			slackBotToken,
			teamId: envelope.team_id,
			upstreamGated,
		};

		this.logger.info(
			`Received ${event.type} webhook (event: ${envelope.event_id}, channel: ${event.channel})`,
		);

		// Emit "event" for transport-level listeners
		this.emit("event", webhookEvent);

		// Emit "message" with translated internal message
		this.emitMessage(webhookEvent);

		reply.code(200).send({ success: true });
	}

	/**
	 * Decide whether a `message` event is a candidate follow-up prompt.
	 *
	 * Drops the bot's own messages (which would otherwise loop), edited/deleted
	 * and other subtype events, and top-level (non-threaded) messages — only a
	 * threaded reply can belong to a thread Cyrus is already bound to.
	 */
	private shouldEmitMessageEvent(event: SlackMessageEvent): boolean {
		if (event.bot_id) {
			this.logger.debug(
				`Ignoring Slack message from bot ${event.bot_id} (channel ${event.channel})`,
			);
			return false;
		}
		if (event.subtype) {
			this.logger.debug(
				`Ignoring Slack message with subtype "${event.subtype}" (channel ${event.channel})`,
			);
			return false;
		}
		if (!event.thread_ts) {
			this.logger.debug(
				`Ignoring non-threaded Slack message (channel ${event.channel})`,
			);
			return false;
		}
		return true;
	}

	private isDuplicateMessage(key: string): boolean {
		this.pruneRecentMessageKeys();
		return this.recentMessageKeys.has(key);
	}

	private rememberMessage(key: string): void {
		this.recentMessageKeys.set(key, Date.now());
	}

	private pruneRecentMessageKeys(): void {
		const now = Date.now();
		for (const [key, seenAt] of this.recentMessageKeys) {
			if (now - seenAt > SlackEventTransport.DEDUP_TTL_MS) {
				this.recentMessageKeys.delete(key);
			}
		}
	}

	/**
	 * Translate and emit an internal message from a webhook event.
	 * Only emits if translation succeeds; logs debug message on failure.
	 */
	private emitMessage(event: SlackWebhookEvent): void {
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
