/**
 * Slack Message Translator
 *
 * Translates Slack webhook events into unified internal messages for the
 * internal message bus.
 *
 * @module slack-event-transport/SlackMessageTranslator
 */

import { randomUUID } from "node:crypto";
import type {
	IMessageTranslator,
	SessionStartMessage,
	SlackPlatformRef,
	SlackSessionStartPlatformData,
	SlackUserPromptPlatformData,
	TranslationContext,
	TranslationResult,
	UserPromptMessage,
} from "cyrus-core";
import type { SlackWebhookEvent } from "./types.js";

/**
 * Strips the @mention from Slack message text.
 * Slack mentions are in the format <@U1234567890> at the start of the text.
 */
export function stripMention(text: string): string {
	return text.replace(/^\s*<@[A-Z0-9]+>\s*/, "").trim();
}

/**
 * Translates Slack webhook events into internal messages.
 *
 * Note: Slack webhooks can result in either:
 * - SessionStartMessage: First mention in a channel/thread that starts a session
 * - UserPromptMessage: Follow-up messages in an existing thread session
 *
 * The distinction between session start vs user prompt is determined by
 * the EdgeWorker based on whether an active session exists for the thread.
 */
export class SlackMessageTranslator
	implements IMessageTranslator<SlackWebhookEvent>
{
	/**
	 * Check if this translator can handle the given event.
	 */
	canTranslate(event: unknown): event is SlackWebhookEvent {
		if (!event || typeof event !== "object") {
			return false;
		}

		const e = event as Record<string, unknown>;

		return (
			typeof e.eventType === "string" &&
			e.eventType === "app_mention" &&
			typeof e.eventId === "string" &&
			e.payload !== null &&
			typeof e.payload === "object"
		);
	}

	/**
	 * Translate a Slack webhook event into an internal message.
	 *
	 * By default, creates a SessionStartMessage. The EdgeWorker will
	 * determine if this should actually be a UserPromptMessage based
	 * on whether an active session exists.
	 */
	translate(
		event: SlackWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "app_mention") {
			return this.translateAppMention(event, context);
		}

		return {
			success: false,
			reason: `Unsupported Slack event type: ${event.eventType}`,
		};
	}

	/**
	 * Create a UserPromptMessage from a Slack event.
	 * This is called by EdgeWorker when it determines the message
	 * is a follow-up to an existing session.
	 */
	translateAsUserPrompt(
		event: SlackWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "app_mention") {
			return this.translateAppMentionAsUserPrompt(event, context);
		}

		return {
			success: false,
			reason: `Unsupported Slack event type: ${event.eventType}`,
		};
	}

	/**
	 * Translate app_mention event to SessionStartMessage.
	 */
	private translateAppMention(
		event: SlackWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const { payload } = event;

		const organizationId = context?.organizationId || event.teamId;

		// Session key: channel:thread_ts (or channel:ts if not in a thread)
		const threadTs = payload.thread_ts || payload.ts;
		const sessionKey = `${payload.channel}:${threadTs}`;

		// Work item identifier uses channel:thread format
		const workItemIdentifier = `slack:${payload.channel}:${threadTs}`;

		// Strip the @mention from the text to get the actual prompt
		const promptText = stripMention(payload.text);

		const platformData: SlackSessionStartPlatformData = {
			channel: this.buildChannelRef(payload.channel),
			thread: this.buildThreadRef(payload.ts, payload.thread_ts),
			message: this.buildMessageRef(payload),
			slackBotToken: event.slackBotToken,
		};

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "slack",
			action: "session_start",
			receivedAt: new Date(
				Number.parseFloat(payload.event_ts) * 1000,
			).toISOString(),
			organizationId,
			sessionKey,
			workItemId: `${payload.channel}:${threadTs}`,
			workItemIdentifier,
			author: {
				id: payload.user,
				name: payload.user,
			},
			initialPrompt: promptText,
			title: promptText.slice(0, 100) + (promptText.length > 100 ? "..." : ""),
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate app_mention as UserPromptMessage.
	 */
	private translateAppMentionAsUserPrompt(
		event: SlackWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const { payload } = event;

		const organizationId = context?.organizationId || event.teamId;

		const threadTs = payload.thread_ts || payload.ts;
		const sessionKey = `${payload.channel}:${threadTs}`;

		const promptText = stripMention(payload.text);

		const platformData: SlackUserPromptPlatformData = {
			channel: this.buildChannelRef(payload.channel),
			thread: this.buildThreadRef(payload.ts, payload.thread_ts),
			message: this.buildMessageRef(payload),
			slackBotToken: event.slackBotToken,
		};

		const message: UserPromptMessage = {
			id: randomUUID(),
			source: "slack",
			action: "user_prompt",
			receivedAt: new Date(
				Number.parseFloat(payload.event_ts) * 1000,
			).toISOString(),
			organizationId,
			sessionKey,
			workItemId: `${payload.channel}:${threadTs}`,
			workItemIdentifier: `slack:${payload.channel}:${threadTs}`,
			author: {
				id: payload.user,
				name: payload.user,
			},
			content: promptText,
			platformData,
		};

		return { success: true, message };
	}

	// ============================================================================
	// HELPER METHODS
	// ============================================================================

	/**
	 * Build channel reference from channel ID.
	 */
	private buildChannelRef(channelId: string): SlackPlatformRef["channel"] {
		return {
			id: channelId,
		};
	}

	/**
	 * Build thread reference from message timestamps.
	 */
	private buildThreadRef(
		ts: string,
		threadTs?: string,
	): SlackPlatformRef["thread"] {
		return {
			ts,
			parentTs: threadTs,
		};
	}

	/**
	 * Build message reference from event payload.
	 */
	private buildMessageRef(
		payload: SlackWebhookEvent["payload"],
	): SlackPlatformRef["message"] {
		return {
			ts: payload.ts,
			text: payload.text,
			user: {
				id: payload.user,
			},
		};
	}
}
