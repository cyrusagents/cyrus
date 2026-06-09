/**
 * Types for Slack event transport
 */

import type { InternalMessage } from "cyrus-core";
import type { FastifyInstance } from "fastify";

/**
 * Verification mode for Slack webhooks
 * - 'proxy': Use Bearer token for authentication (webhooks forwarded from CYHOST)
 * - 'direct': Use Slack signing secret for HMAC-SHA256 signature verification
 */
export type SlackVerificationMode = "proxy" | "direct";

/**
 * Configuration for SlackEventTransport
 */
export interface SlackEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'proxy' (via CYHOST) or 'direct' (Slack signing secret) */
	verificationMode: SlackVerificationMode;
	/** Secret for verification (CYRUS_API_KEY for proxy, SLACK_SIGNING_SECRET for direct) */
	secret: string;
	/**
	 * Live predicate for whether Cyrus should follow plain (non-@mention)
	 * messages in a thread. When it returns false, `message` events are ignored
	 * entirely (app_mention-only behaviour) — they're dropped before the
	 * app_mention/message de-dup so a mention's `message` twin never suppresses
	 * its `app_mention`. Omitted ⇒ always enabled.
	 */
	isThreadFollowingEnabled?: () => boolean;
}

/**
 * Events emitted by SlackEventTransport
 */
export interface SlackEventTransportEvents {
	/** Emitted when a Slack webhook is received and verified */
	event: (event: SlackWebhookEvent) => void;
	/** Emitted when a unified internal message is received */
	message: (message: InternalMessage) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}

/**
 * Processed Slack webhook event that is emitted to listeners
 */
export interface SlackWebhookEvent {
	/** The Slack event type (e.g., 'app_mention', 'message') */
	eventType: SlackEventType;
	/** Unique event ID from Slack */
	eventId: string;
	/** The full Slack event payload */
	payload: SlackEventPayload;
	/** Slack Bot token for API access */
	slackBotToken?: string;
	/** Workspace/team ID */
	teamId: string;
	/**
	 * True when the event arrived via an upstream gate that already verified it
	 * should be acted on (proxy mode: CYHOST only forwards `message` events for
	 * threads it has a persistent binding row for). When true, a plain `message`
	 * event is trusted to (re)start a session for its thread even if the runtime
	 * has no in-memory binding — e.g. after a process restart. In direct mode
	 * (Slack → runtime, no upstream gate) this is false and the runtime must
	 * self-gate on its in-memory thread bindings.
	 */
	upstreamGated?: boolean;
}

/**
 * Supported Slack event types.
 *
 * - `app_mention`: an explicit @mention of the bot — always starts (or resumes)
 *   a session for the thread.
 * - `message`: a plain message in a channel/thread the bot can see. Only acted
 *   on as a follow-up prompt for a thread the bot is already bound to; never
 *   starts a new session (see the surface lifecycle's initiation gate).
 */
export type SlackEventType = "app_mention" | "message";

/**
 * Union of the Slack event payloads this transport understands.
 *
 * Both members share the `user`/`text`/`ts`/`channel`/`thread_ts`/`event_ts`
 * fields, so downstream consumers can read those without narrowing.
 */
export type SlackEventPayload = SlackAppMentionEvent | SlackMessageEvent;

// ============================================================================
// Slack Event API Payload Types
// ============================================================================
// Based on Slack Event API documentation:
// - app_mention: https://api.slack.com/events/app_mention

/**
 * Slack user object (minimal)
 */
export interface SlackUser {
	/** User ID (e.g., "U1234567890") */
	id: string;
	/** Display name */
	name?: string;
	/** Real name */
	real_name?: string;
}

/**
 * Slack channel object (minimal)
 */
export interface SlackChannel {
	/** Channel ID (e.g., "C1234567890") */
	id: string;
	/** Channel name */
	name?: string;
}

/**
 * Slack app_mention event payload
 * @see https://api.slack.com/events/app_mention
 */
export interface SlackAppMentionEvent {
	/** Event type - always "app_mention" */
	type: "app_mention";
	/** User ID who mentioned the app */
	user: string;
	/** The message text (includes the @mention) */
	text: string;
	/** Message timestamp (unique ID within channel) */
	ts: string;
	/** Channel ID where the mention occurred */
	channel: string;
	/** Thread timestamp - present if this is a threaded reply */
	thread_ts?: string;
	/** Event timestamp */
	event_ts: string;
}

/**
 * Slack message event payload
 *
 * Fired for plain messages in channels/threads the bot can see (requires the
 * `message.*` bot event subscriptions and matching `*:history` scopes). Cyrus
 * only acts on threaded replies (`thread_ts` present) in threads it is already
 * bound to; the gating lives in SlackEventTransport (cheap structural filters)
 * and the runtime surface lifecycle (binding check).
 * @see https://api.slack.com/events/message
 */
export interface SlackMessageEvent {
	/** Event type - always "message" */
	type: "message";
	/**
	 * Message subtype (e.g. "message_changed", "channel_join", "bot_message").
	 * Plain user messages have no subtype; we ignore anything with one.
	 */
	subtype?: string;
	/** ID of the bot that posted this message, if any. Used to ignore bot/own messages. */
	bot_id?: string;
	/** User ID who sent the message */
	user: string;
	/** The message text */
	text: string;
	/** Message timestamp (unique ID within channel) */
	ts: string;
	/** Channel ID where the message occurred */
	channel: string;
	/** Thread timestamp - present if this is a threaded reply */
	thread_ts?: string;
	/** Event timestamp */
	event_ts: string;
}

/**
 * Slack Event API wrapper envelope
 * This is the outer payload that wraps the actual event.
 * @see https://api.slack.com/types/event
 */
export interface SlackEventEnvelope {
	/** Token for verification (deprecated, use signing secret) */
	token?: string;
	/** Team/workspace ID */
	team_id: string;
	/** API app ID */
	api_app_id: string;
	/** The actual event data */
	event: SlackEventPayload;
	/** Type of envelope - "event_callback" for events */
	type: "event_callback" | "url_verification";
	/** Unique event ID */
	event_id: string;
	/** Event timestamp */
	event_time: number;
	/** Challenge string (only for url_verification) */
	challenge?: string;
}
