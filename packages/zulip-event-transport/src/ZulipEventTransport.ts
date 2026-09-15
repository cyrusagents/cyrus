import { timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { createLogger, type ILogger } from "cyrus-core";
import type { FastifyReply, FastifyRequest } from "fastify";
import type {
	ZulipEventTransportConfig,
	ZulipEventTransportEvents,
	ZulipOutgoingWebhookPayload,
	ZulipTrigger,
	ZulipWebhookEvent,
} from "./types.js";

export declare interface ZulipEventTransport {
	on<K extends keyof ZulipEventTransportEvents>(
		event: K,
		listener: ZulipEventTransportEvents[K],
	): this;
	emit<K extends keyof ZulipEventTransportEvents>(
		event: K,
		...args: Parameters<ZulipEventTransportEvents[K]>
	): boolean;
}

/**
 * ZulipEventTransport - Handles Zulip outgoing webhook delivery
 *
 * Registers a POST /zulip-webhook endpoint with a Fastify server and verifies
 * incoming requests against the bot's fixed token.
 *
 * Two things differ from the Slack transport, both forced by Zulip's protocol:
 *
 * 1. **Verification is a token compare, not a signature check.** Zulip does
 *    not sign outgoing webhook requests; the payload carries the bot's fixed
 *    token and that is the only credential available. Deploy behind TLS.
 *
 * 2. **The reply does not go in the response.** Zulip expects the bot's answer
 *    in the HTTP response body, which cannot work for a turn that takes
 *    minutes. This transport always answers `response_not_required` right
 *    away and the reply is posted later through the REST API.
 *
 * An outgoing webhook bot is only notified about messages that address it —
 * an @mention in a channel, or a DM — so there is no equivalent of Slack's
 * plain `message` event and no passive thread following. Everything said in a
 * topic between two mentions is picked up by the catch-up read in
 * ZulipChatAdapter instead.
 *
 * @see https://zulip.com/api/outgoing-webhooks
 */
export class ZulipEventTransport extends EventEmitter {
	private config: ZulipEventTransportConfig;
	private logger: ILogger;

	constructor(config: ZulipEventTransportConfig, logger?: ILogger) {
		super();
		this.config = config;
		this.logger = logger ?? createLogger({ component: "ZulipEventTransport" });
	}

	/**
	 * Register the /zulip-webhook endpoint with the Fastify server
	 */
	register(): void {
		this.config.fastifyServer.post(
			"/zulip-webhook",
			async (request: FastifyRequest, reply: FastifyReply) => {
				try {
					this.handleWebhook(request, reply);
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

		this.logger.info("Registered POST /zulip-webhook endpoint");
	}

	private handleWebhook(request: FastifyRequest, reply: FastifyReply): void {
		const payload = request.body as ZulipOutgoingWebhookPayload | undefined;

		if (!payload || typeof payload.token !== "string") {
			reply.code(401).send({ error: "Missing webhook token" });
			return;
		}

		if (!this.verifyToken(payload.token)) {
			reply.code(401).send({ error: "Invalid webhook token" });
			return;
		}

		const trigger = this.normalizeTrigger(payload.trigger);
		if (!trigger) {
			this.logger.debug(`Ignoring unsupported trigger: ${payload.trigger}`);
			reply.code(200).send({ response_not_required: true });
			return;
		}

		if (!payload.message || typeof payload.message.id !== "number") {
			this.logger.debug("Ignoring payload with no usable message");
			reply.code(200).send({ response_not_required: true });
			return;
		}

		const event: ZulipWebhookEvent = {
			trigger,
			message: payload.message,
			data: payload.data ?? payload.message.content ?? "",
			botEmail: payload.bot_email,
			botFullName: payload.bot_full_name,
			credentials: this.config.credentials,
		};

		this.logger.info(
			`Received ${trigger} webhook (message: ${payload.message.id}, topic: ${payload.message.subject})`,
		);

		this.emit("event", event);

		// Answer immediately — the real reply is posted through the REST API
		// once the agent finishes. Zulip posts nothing for this response.
		reply.code(200).send({ response_not_required: true });
	}

	/**
	 * Constant-time comparison of the payload token against the configured one.
	 *
	 * `timingSafeEqual` throws on a length mismatch, so that is checked first —
	 * the length of a token is not a secret worth protecting.
	 */
	private verifyToken(token: string): boolean {
		const expected = Buffer.from(this.config.token);
		const actual = Buffer.from(token);
		if (expected.length === 0 || expected.length !== actual.length) {
			return false;
		}
		return timingSafeEqual(expected, actual);
	}

	/**
	 * Zulip sends `mention` and `direct_message`, but has historically used
	 * other spellings (`private_message`) for the DM trigger, so both are
	 * accepted. Anything else is ignored rather than guessed at.
	 */
	private normalizeTrigger(trigger: string): ZulipTrigger | null {
		if (trigger === "mention") {
			return "mention";
		}
		if (trigger === "direct_message" || trigger === "private_message") {
			return "direct_message";
		}
		return null;
	}
}
