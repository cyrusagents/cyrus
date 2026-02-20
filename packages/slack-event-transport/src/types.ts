/**
 * Types for Slack event transport
 */

import type { InternalMessage } from "cyrus-core";
import type { FastifyInstance } from "fastify";

/**
 * Verification mode for Slack webhooks forwarded from CYHOST
 * - 'proxy': Use Bearer token for authentication (webhooks forwarded from CYHOST)
 */
export type SlackVerificationMode = "proxy";

/**
 * Configuration for SlackEventTransport
 */
export interface SlackEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'proxy' (webhooks forwarded from CYHOST) */
	verificationMode: SlackVerificationMode;
	/** Secret for verification (CYRUS_API_KEY for proxy mode) */
	secret: string;
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
	/** The Slack event type (e.g., 'app_mention') */
	eventType: SlackEventType;
	/** Unique event ID from Slack */
	eventId: string;
	/** The full Slack event payload */
	payload: SlackAppMentionEvent;
	/** Slack Bot token for API access */
	slackBotToken?: string;
	/** Workspace/team ID */
	teamId: string;
}

/**
 * Supported Slack event types
 */
export type SlackEventType = "app_mention";

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
	event: SlackAppMentionEvent;
	/** Type of envelope - "event_callback" for events */
	type: "event_callback" | "url_verification";
	/** Unique event ID */
	event_id: string;
	/** Event timestamp */
	event_time: number;
	/** Challenge string (only for url_verification) */
	challenge?: string;
}
