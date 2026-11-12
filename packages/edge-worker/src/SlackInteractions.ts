/**
 * Helpers for Slack interactivity (Block Kit clicks and slash commands).
 *
 * Kept pure so the mapping from a click or a command to a thread is testable
 * without standing up an EdgeWorker. The thread key format has to match
 * {@link SlackChatAdapter.getThreadKey} exactly — that key is how the chat
 * session handler finds the session a control belongs to.
 *
 * @see https://api.slack.com/interactivity/handling
 */

import type {
	SlackBlockActionsPayload,
	SlackSlashCommandPayload,
} from "cyrus-slack-event-transport";

/** `action_id` of the button that stops a running session. */
export const SLACK_STOP_ACTION_ID = "cyrus_stop";

/** Slash command registered by the Slack app manifest. */
export const SLACK_COMMAND = "/cyrus";

/**
 * Thread key for a Slack channel and message timestamp.
 *
 * Matches `SlackChatAdapter.getThreadKey`, which keys a thread on its root
 * message: a reply carries `thread_ts`, a root message only `ts`.
 */
export function formatSlackThreadKey(
	channel: string,
	timestamp: string,
): string {
	return `${channel}:${timestamp}`;
}

/**
 * Which control a slash command's text asks for, if any.
 *
 * Only `stop` exists today; the verb is the first word so `/cyrus stop please`
 * behaves the same as `/cyrus stop`.
 */
export function parseSlackControlCommand(text: string): "stop" | undefined {
	const verb = text.trim().toLowerCase().split(/\s+/, 1)[0];
	return verb === "stop" ? "stop" : undefined;
}

/**
 * Thread key behind a clicked block action, or null when the message it
 * belongs to cannot be placed in a thread.
 */
export function threadKeyFromBlockActions(
	payload: SlackBlockActionsPayload,
): string | null {
	const channel = payload.channel?.id ?? payload.container?.channel_id;
	const timestamp =
		payload.message?.thread_ts ??
		payload.message?.ts ??
		payload.container?.thread_ts ??
		payload.container?.message_ts;
	if (!channel || !timestamp) {
		return null;
	}
	return formatSlackThreadKey(channel, timestamp);
}

/**
 * Thread key behind a slash command, or null when it was not run in a thread.
 *
 * A command run from the channel composer has no `thread_ts` and therefore no
 * session to address; Cyrus only ever works in threads.
 */
export function threadKeyFromSlashCommand(
	payload: SlackSlashCommandPayload,
): string | null {
	if (!payload.channel_id || !payload.thread_ts) {
		return null;
	}
	return formatSlackThreadKey(payload.channel_id, payload.thread_ts);
}
