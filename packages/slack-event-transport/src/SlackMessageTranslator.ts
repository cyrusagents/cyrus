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
import type {
	SlackBlock,
	SlackEventPayload,
	SlackMessageAttachment,
	SlackRichTextElement,
	SlackWebhookEvent,
} from "./types.js";

/**
 * Strips the @mention from Slack message text.
 * Slack mentions are in the format <@U1234567890> at the start of the text.
 */
export function stripMention(text: string): string {
	return text.replace(/^\s*<@[A-Z0-9]+>\s*/, "").trim();
}

/** Flatten Slack rich_text / block nodes into plain text. */
function richTextToPlain(
	nodes: Array<SlackBlock | SlackRichTextElement> | undefined,
): string {
	if (!Array.isArray(nodes)) return "";
	const out: string[] = [];
	const walk = (el: SlackBlock | SlackRichTextElement): void => {
		const node = el as SlackRichTextElement;
		if (typeof node.text === "string") out.push(node.text);
		else if (node.type === "link" && typeof node.url === "string")
			out.push(node.url);
		else if (node.type === "user" && node.user_id)
			out.push(`<@${node.user_id}>`);
		if (Array.isArray(node.elements)) node.elements.forEach(walk);
	};
	nodes.forEach(walk);
	return out.join("");
}

/**
 * Pulls each attachment's body out of `payload.attachments[]` (not in `text`)
 * as a labeled block. Falls back to `blocks`/`message_blocks` when `text` is empty.
 */
export function extractAttachmentContent(payload: SlackEventPayload): string {
	const attachments: SlackMessageAttachment[] = Array.isArray(
		payload.attachments,
	)
		? payload.attachments
		: [];
	const parts: string[] = [];
	for (const att of attachments) {
		if (!att || typeof att !== "object") continue;
		let body = typeof att.text === "string" ? att.text.trim() : "";
		if (!body && Array.isArray(att.blocks)) {
			body = richTextToPlain(att.blocks).trim();
		}
		if (!body && Array.isArray(att.message_blocks)) {
			for (const mb of att.message_blocks) {
				const t = richTextToPlain(mb.message?.blocks).trim();
				if (t) body = body ? `${body}\n${t}` : t;
			}
		}
		if (!body) continue;
		const author = att.author_name || att.author_subname || att.author_id || "";
		const source =
			(att.channel_name && `#${att.channel_name}`) || att.footer || "";
		const bits: string[] = [];
		if (author) bits.push(`from ${author}`);
		if (source) bits.push(`(${source})`);
		const header = `[Attachment${bits.length ? ` ${bits.join(" ")}` : ""}]`;
		parts.push(`${header}\n${body}`);
	}
	return parts.join("\n\n");
}

/** User's own text (mention stripped) + any attachment content folded in. */
export function buildPromptText(payload: SlackEventPayload): string {
	const own = stripMention(payload.text || "");
	const attachments = extractAttachmentContent(payload);
	if (own && attachments) return `${own}\n\n${attachments}`;
	return attachments || own;
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
			(e.eventType === "app_mention" || e.eventType === "message") &&
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

		// A plain `message` event is always a follow-up in an existing thread —
		// it can only reach here for a thread Cyrus is already bound to, so it
		// maps to a user prompt rather than a session start.
		if (event.eventType === "message") {
			return this.translateAppMentionAsUserPrompt(event, context);
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
		if (event.eventType === "app_mention" || event.eventType === "message") {
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

		// Strip the @mention and fold in any attachment content
		const promptText = buildPromptText(payload);

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

		const promptText = buildPromptText(payload);

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
