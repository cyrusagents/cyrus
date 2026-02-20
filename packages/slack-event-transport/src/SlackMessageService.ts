/**
 * Service for posting messages to Slack channels.
 *
 * Uses the Slack Web API with a bot token to post messages,
 * typically used to reply to @mention webhooks in a thread.
 */

/**
 * A single message from a Slack thread (conversations.replies)
 */
export interface SlackThreadMessage {
	/** User ID who posted the message (absent for some bot messages) */
	user?: string;
	/** Message text */
	text: string;
	/** Message timestamp (unique ID) */
	ts: string;
	/** Bot ID if the message was posted by a bot */
	bot_id?: string;
	/** Message subtype (e.g., "bot_message") */
	subtype?: string;
}

/**
 * Parameters for fetching thread messages from Slack
 */
export interface SlackFetchThreadParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID containing the thread */
	channel: string;
	/** Timestamp of the thread parent message */
	thread_ts: string;
	/** Maximum number of messages to fetch (default 100) */
	limit?: number;
}

/**
 * Parameters for posting a message to Slack
 */
export interface SlackPostMessageParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID to post the message in */
	channel: string;
	/** Message text */
	text: string;
	/** Thread timestamp to reply in a thread */
	thread_ts?: string;
}

export class SlackMessageService {
	private apiBaseUrl: string;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = apiBaseUrl ?? "https://slack.com/api";
	}

	/**
	 * Post a message to a Slack channel.
	 *
	 * @see https://api.slack.com/methods/chat.postMessage
	 */
	async postMessage(params: SlackPostMessageParams): Promise<void> {
		const { token, channel, text, thread_ts } = params;

		const url = `${this.apiBaseUrl}/chat.postMessage`;

		const body: Record<string, string> = { channel, text };
		if (thread_ts) {
			body.thread_ts = thread_ts;
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(body),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackMessageService] Failed to post message: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		// Slack API returns HTTP 200 even for errors — check the response body
		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
		};
		if (!responseBody.ok) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}
	}

	/**
	 * Fetch all messages in a Slack thread using cursor-based pagination.
	 *
	 * @see https://api.slack.com/methods/conversations.replies
	 */
	async fetchThreadMessages(
		params: SlackFetchThreadParams,
	): Promise<SlackThreadMessage[]> {
		const { token, channel, thread_ts, limit = 100 } = params;
		const messages: SlackThreadMessage[] = [];
		let cursor: string | undefined;

		while (messages.length < limit) {
			const queryParams = new URLSearchParams({
				channel,
				ts: thread_ts,
				limit: String(Math.min(limit - messages.length, 200)),
			});
			if (cursor) {
				queryParams.set("cursor", cursor);
			}

			const url = `${this.apiBaseUrl}/conversations.replies?${queryParams.toString()}`;

			const response = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(
					`[SlackMessageService] Failed to fetch thread messages: ${response.status} ${response.statusText} - ${errorBody}`,
				);
			}

			const responseBody = (await response.json()) as {
				ok: boolean;
				error?: string;
				messages?: SlackThreadMessage[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			};

			if (!responseBody.ok) {
				throw new Error(
					`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
				);
			}

			if (responseBody.messages) {
				messages.push(...responseBody.messages);
			}

			// Continue pagination if there are more messages
			const nextCursor = responseBody.response_metadata?.next_cursor;
			if (!responseBody.has_more || !nextCursor) {
				break;
			}
			cursor = nextCursor;
		}

		// Enforce limit
		return messages.slice(0, limit);
	}
}
