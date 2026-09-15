/**
 * Types for Zulip event transport
 */

import type { FastifyInstance } from "fastify";

/**
 * Configuration for ZulipEventTransport
 */
export interface ZulipEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/**
	 * The outgoing webhook bot's token, used to authenticate incoming requests.
	 *
	 * Zulip does not sign outgoing webhook requests — every payload simply
	 * carries the bot's fixed token, so this is compared against
	 * `payload.token` in constant time. Note this is NOT the bot's API key:
	 * the token lives in the bot's downloadable Zulip Botserver config
	 * (`botserverrc`), while the API key is shown in the bot's settings.
	 */
	token: string;
	/** Credentials the adapter needs to call back into the Zulip REST API */
	credentials: ZulipCredentials;
}

/**
 * REST API credentials for a Zulip bot.
 *
 * Zulip's outgoing webhook protocol expects the reply in the HTTP response,
 * which cannot work for an agent turn that takes minutes. Everything Cyrus
 * does after acknowledging a webhook — posting the reply, adding reactions,
 * back-reading a topic — goes through the REST API with these credentials
 * instead.
 */
export interface ZulipCredentials {
	/** Realm base URL, e.g. `https://example.zulipchat.com` (no trailing slash) */
	site: string;
	/** The bot's Zulip API email address */
	botEmail: string;
	/** The bot's API key */
	apiKey: string;
}

/**
 * Events emitted by ZulipEventTransport
 */
export interface ZulipEventTransportEvents {
	/** Emitted when a Zulip outgoing webhook is received and verified */
	event: (event: ZulipWebhookEvent) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}

/**
 * What caused Zulip to invoke the outgoing webhook.
 *
 * An outgoing webhook bot is only ever notified about messages that address
 * it directly: an @mention in a channel, or a direct message. There is no
 * equivalent of Slack's plain `message` event, so Cyrus cannot passively
 * follow a Zulip topic — the catch-up read in ZulipChatAdapter covers what
 * was said between two mentions instead.
 */
export type ZulipTrigger = "mention" | "direct_message";

/**
 * Processed Zulip webhook event that is emitted to listeners
 */
export interface ZulipWebhookEvent {
	/** What triggered the webhook */
	trigger: ZulipTrigger;
	/** The message that triggered it */
	message: ZulipMessage;
	/** Raw message content in Zulip-flavored Markdown, as sent by Zulip */
	data: string;
	/** Email of the bot that was addressed */
	botEmail: string;
	/** Full name of the bot that was addressed, used to strip @mentions */
	botFullName: string;
	/** Credentials for calling back into the Zulip REST API */
	credentials: ZulipCredentials;
}

/**
 * A Zulip message, as delivered in an outgoing webhook payload or returned
 * by `GET /api/v1/messages`.
 *
 * @see https://zulip.com/api/outgoing-webhook-payload
 */
export interface ZulipMessage {
	/** Unique, monotonically increasing message ID */
	id: number;
	/** `stream` for a channel message, `private` for a DM */
	type: "stream" | "private";
	/** The message body */
	content: string;
	/** User ID of the sender */
	sender_id: number;
	/** Zulip API email address of the sender */
	sender_email: string;
	/** Display name of the sender */
	sender_full_name: string;
	/**
	 * The topic. Zulip's API still calls this `subject` in message objects,
	 * even though the UI (and newer endpoints) call it `topic`.
	 */
	subject: string;
	/** Channel ID — only present on channel messages */
	stream_id?: number;
	/**
	 * Channel name for a channel message, or the list of recipients for a DM.
	 */
	display_recipient?: string | ZulipRecipient[];
	/** UNIX timestamp (UTC seconds) of when the message was sent */
	timestamp: number;
	/** True when the message was sent by a bot */
	is_bot?: boolean;
}

/** One participant of a direct message conversation */
export interface ZulipRecipient {
	id: number;
	email: string;
	full_name: string;
}

/**
 * The raw body Zulip POSTs to an outgoing webhook.
 *
 * @see https://zulip.com/api/outgoing-webhook-payload
 */
export interface ZulipOutgoingWebhookPayload {
	/** Fixed per-bot token used to authenticate the request */
	token: string;
	/** Email of the bot user */
	bot_email: string;
	/** Full name of the bot user */
	bot_full_name: string;
	/** The message content in raw Zulip-flavored Markdown */
	data: string;
	/** What aspect of the message triggered the notification */
	trigger: string;
	/** The full message object */
	message: ZulipMessage;
}
