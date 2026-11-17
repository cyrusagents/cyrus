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
	/**
	 * Only fetch messages after this timestamp. Must be server-side: pagination
	 * walks from the thread head, so a client-side filter would never reach
	 * recent messages in a thread longer than `limit`.
	 */
	oldest?: string;
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
	/** Small context footer displayed beneath the reply. */
	footer?: string;
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
		const { token, channel, text, thread_ts, footer } = params;

		const url = `${this.apiBaseUrl}/chat.postMessage`;

		const body: Record<string, unknown> = { channel, text };
		if (thread_ts) {
			body.thread_ts = thread_ts;
		}
		if (footer) {
			body.blocks = [
				...splitReplySections(text).map((section) => ({
					type: "section",
					text: { type: "mrkdwn", text: section },
				})),
				{
					type: "context",
					elements: [{ type: "plain_text", text: footer, emoji: false }],
				},
			];
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

	/** Resolve the prompting person's full Slack name without exposing profile data. */
	async getUserName(
		token: string,
		userId: string,
	): Promise<string | undefined> {
		const url = new URL(`${this.apiBaseUrl}/users.info`);
		url.searchParams.set("user", userId);
		const response = await fetch(url.toString(), {
			headers: { Authorization: `Bearer ${token}` },
			signal: AbortSignal.timeout(3000),
		});
		if (!response.ok) throw new Error("Slack user lookup failed");
		const data = (await response.json()) as {
			ok: boolean;
			user?: {
				id?: string;
				real_name?: string;
				name?: string;
				profile?: { real_name?: string; display_name?: string };
			};
		};
		if (!data.ok || data.user?.id !== userId) return undefined;
		return [
			data.user.profile?.real_name,
			data.user.real_name,
			data.user.profile?.display_name,
			data.user.name,
		]
			.find((name) => typeof name === "string" && name.trim())
			?.trim();
	}

	/**
	 * Get the bot's own identity (bot_id, user_id) via auth.test.
	 *
	 * @see https://api.slack.com/methods/auth.test
	 */
	async getIdentity(
		token: string,
	): Promise<{ bot_id?: string; user_id: string }> {
		const url = `${this.apiBaseUrl}/auth.test`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackMessageService] Failed to get identity: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
			bot_id?: string;
			user_id: string;
		};

		if (!responseBody.ok) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}

		return { bot_id: responseBody.bot_id, user_id: responseBody.user_id };
	}

	/**
	 * Fetch all messages in a Slack thread using cursor-based pagination.
	 *
	 * @see https://api.slack.com/methods/conversations.replies
	 */
	async fetchThreadMessages(
		params: SlackFetchThreadParams,
	): Promise<SlackThreadMessage[]> {
		const { token, channel, thread_ts, limit = 100, oldest } = params;
		const messages: SlackThreadMessage[] = [];
		let cursor: string | undefined;

		while (messages.length < limit) {
			const queryParams = new URLSearchParams({
				channel,
				ts: thread_ts,
				limit: String(Math.min(limit - messages.length, 200)),
			});
			if (oldest) {
				queryParams.set("oldest", oldest);
			}
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

/** Slack sections allow 3,000 characters; keep code fences balanced across sections. */
function splitReplySections(text: string): string[] {
	// Slack already truncates ordinary message text at 40,000 characters.
	let remaining =
		text.length > 40000
			? `${text.slice(0, 39999).replace(/[\uD800-\uDBFF]$/, "")}…`
			: text;
	const sections: string[] = [];
	let inCode = false;
	while (remaining) {
		let end = Math.min(2992, remaining.length);
		if (end < remaining.length) {
			const newline = remaining.lastIndexOf("\n", end - 1);
			const space = remaining.lastIndexOf(" ", end - 1);
			if (newline > end / 2) end = newline + 1;
			else if (space > end / 2) end = space + 1;
			// Do not divide a Unicode character or a triple-backtick delimiter.
			if (/[\uD800-\uDBFF]/.test(remaining[end - 1]!)) end--;
			if (remaining[end] === "`") {
				const trailingTicks =
					remaining.slice(0, end).match(/`+$/)?.[0].length ?? 0;
				end -= trailingTicks % 3;
			}
		}
		const chunk = remaining.slice(0, end);
		const prefix = inCode ? "```\n" : "";
		if ((chunk.match(/```/g)?.length ?? 0) % 2) inCode = !inCode;
		sections.push(`${prefix}${chunk}${inCode ? "\n```" : ""}`);
		remaining = remaining.slice(end);
	}
	return sections;
}
