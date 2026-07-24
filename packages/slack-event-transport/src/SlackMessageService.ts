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

/**
 * Parameters for setting or clearing a Slack assistant thread status.
 */
export interface SlackAssistantThreadStatusParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID containing the assistant thread */
	channel_id: string;
	/** Timestamp of the thread where the status should appear */
	thread_ts: string;
	/** Status text. Pass an empty string to clear the active status. */
	status: string;
	/** Loading messages Slack rotates while the assistant is working */
	loading_messages?: string[];
	/** Optional display override. Prefer omitting to use the installed app identity. */
	username?: string;
	/** Optional icon URL override. Prefer omitting to use the installed app icon. */
	icon_url?: string;
	/** Optional emoji override. Avoid production placeholders. */
	icon_emoji?: string;
}

export type SlackStreamMode = "markdown" | "chunks";

export interface SlackMarkdownTextChunk {
	type: "markdown_text";
	text: string;
}

export interface SlackTaskUpdateChunk {
	type: "task_update";
	id: string;
	title: string;
	status: "pending" | "in_progress" | "complete" | "error";
	details?: string;
	output?: string;
	sources?: Array<{ type: "url"; text: string; url: string }>;
}

export interface SlackPlanUpdateChunk {
	type: "plan_update";
	title: string;
}

export interface SlackBlocksChunk {
	type: "blocks";
	blocks: unknown[];
}

export type SlackStreamChunk =
	| SlackMarkdownTextChunk
	| SlackTaskUpdateChunk
	| SlackPlanUpdateChunk
	| SlackBlocksChunk;

export interface SlackStreamHandle {
	channel: string;
	ts: string;
	mode: SlackStreamMode;
}

interface SlackStreamPresentationParams {
	/** Optional display override. Prefer omitting to use the installed app identity. */
	username?: string;
	/** Optional icon URL override. Prefer omitting to use the installed app icon. */
	icon_url?: string;
	/** Optional emoji override. Avoid production placeholders. */
	icon_emoji?: string;
}

interface SlackStartStreamBaseParams extends SlackStreamPresentationParams {
	token: string;
	channel: string;
	thread_ts: string;
	/** Required by Slack when streaming into channels. */
	recipient_user_id?: string;
	/** Required by Slack when streaming into channels. */
	recipient_team_id?: string;
	task_display_mode?: "timeline" | "plan" | "dense";
}

export type SlackStartStreamParams =
	| (SlackStartStreamBaseParams & {
			mode: "markdown";
			markdown_text?: string;
			chunks?: never;
	  })
	| (SlackStartStreamBaseParams & {
			mode: "chunks";
			chunks?: SlackStreamChunk[];
			markdown_text?: never;
	  });

export type SlackAppendStreamParams =
	| {
			token: string;
			stream: SlackStreamHandle & { mode: "markdown" };
			markdown_text: string;
			chunks?: never;
	  }
	| {
			token: string;
			stream: SlackStreamHandle & { mode: "chunks" };
			chunks: SlackStreamChunk[];
			markdown_text?: never;
	  };

export type SlackStopStreamParams =
	| {
			token: string;
			stream: SlackStreamHandle & { mode: "markdown" };
			markdown_text?: string;
			chunks?: never;
			blocks?: unknown[];
			metadata?: unknown;
	  }
	| {
			token: string;
			stream: SlackStreamHandle & { mode: "chunks" };
			chunks?: SlackStreamChunk[];
			markdown_text?: never;
			blocks?: unknown[];
			metadata?: unknown;
	  };

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
	 * Set or clear the assistant thread status Slack renders while Cyrus works.
	 *
	 * @see https://api.slack.com/methods/assistant.threads.setStatus
	 */
	async setAssistantThreadStatus(
		params: SlackAssistantThreadStatusParams,
	): Promise<void> {
		const {
			token,
			channel_id,
			thread_ts,
			status,
			loading_messages,
			username,
			icon_url,
			icon_emoji,
		} = params;
		const url = `${this.apiBaseUrl}/assistant.threads.setStatus`;
		const body: Record<string, unknown> = {
			channel_id,
			thread_ts,
			status,
		};
		if (loading_messages) body.loading_messages = loading_messages;
		if (username) body.username = username;
		if (icon_url) body.icon_url = icon_url;
		if (icon_emoji) body.icon_emoji = icon_emoji;

		await this.postSlackApi(url, token, body, "set assistant thread status");
	}

	/**
	 * Start a Slack streamed message in exactly one mode.
	 *
	 * The returned handle records the selected mode so append/stop calls cannot
	 * accidentally mix `markdown_text` and `chunks` for the same stream.
	 *
	 * @see https://api.slack.com/methods/chat.startStream
	 */
	async startStream(
		params: SlackStartStreamParams,
	): Promise<SlackStreamHandle> {
		this.assertChannelRecipientFields(params.channel, params);
		const url = `${this.apiBaseUrl}/chat.startStream`;
		const body: Record<string, unknown> = {
			channel: params.channel,
			thread_ts: params.thread_ts,
		};
		if (params.recipient_user_id) {
			body.recipient_user_id = params.recipient_user_id;
		}
		if (params.recipient_team_id) {
			body.recipient_team_id = params.recipient_team_id;
		}
		if (params.task_display_mode) {
			body.task_display_mode = params.task_display_mode;
		}
		if (params.username) body.username = params.username;
		if (params.icon_url) body.icon_url = params.icon_url;
		if (params.icon_emoji) body.icon_emoji = params.icon_emoji;
		this.applyStreamContent(body, params, false);

		const response = await this.postSlackApi<{
			ok: boolean;
			channel?: string;
			ts?: string;
		}>(url, params.token, body, "start stream");

		if (!response.channel || !response.ts) {
			throw new Error(
				"[SlackMessageService] Slack API response missing stream handle",
			);
		}

		return {
			channel: response.channel,
			ts: response.ts,
			mode: params.mode,
		};
	}

	/**
	 * Append content to a Slack stream. The stream handle's mode determines
	 * which payload field is valid.
	 *
	 * @see https://api.slack.com/methods/chat.appendStream
	 */
	async appendStream(
		params: SlackAppendStreamParams,
	): Promise<SlackStreamHandle> {
		const url = `${this.apiBaseUrl}/chat.appendStream`;
		const body: Record<string, unknown> = {
			channel: params.stream.channel,
			ts: params.stream.ts,
		};
		this.applyStreamContent(body, params, true, params.stream.mode);

		const response = await this.postSlackApi<{
			ok: boolean;
			channel?: string;
			ts?: string;
		}>(url, params.token, body, "append stream");

		return {
			channel: response.channel ?? params.stream.channel,
			ts: response.ts ?? params.stream.ts,
			mode: params.stream.mode,
		};
	}

	/**
	 * Stop a Slack stream. Optional final content must match the stream mode.
	 *
	 * @see https://api.slack.com/methods/chat.stopStream
	 */
	async stopStream(params: SlackStopStreamParams): Promise<void> {
		const url = `${this.apiBaseUrl}/chat.stopStream`;
		const body: Record<string, unknown> = {
			channel: params.stream.channel,
			ts: params.stream.ts,
		};
		this.applyStreamContent(body, params, false, params.stream.mode);
		if (params.blocks) body.blocks = params.blocks;
		if (params.metadata) body.metadata = params.metadata;

		await this.postSlackApi(url, params.token, body, "stop stream");
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

	private async postSlackApi<TBody extends { ok?: boolean; error?: string }>(
		url: string,
		token: string,
		body: Record<string, unknown>,
		action: string,
	): Promise<TBody> {
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
				`[SlackMessageService] Failed to ${action}: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const responseBody = (await response.json()) as TBody;
		if (!responseBody.ok) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}
		return responseBody;
	}

	private assertChannelRecipientFields(
		channel: string,
		params: {
			recipient_user_id?: string;
			recipient_team_id?: string;
		},
	): void {
		if (channel.startsWith("D")) {
			return;
		}
		if (!params.recipient_user_id || !params.recipient_team_id) {
			throw new Error(
				"[SlackMessageService] recipient_user_id and recipient_team_id are required when starting a stream in a channel",
			);
		}
	}

	private applyStreamContent(
		body: Record<string, unknown>,
		params: {
			mode?: SlackStreamMode;
			markdown_text?: string;
			chunks?: SlackStreamChunk[];
		},
		requireContent: boolean,
		expectedMode = params.mode,
	): void {
		const hasMarkdown = params.markdown_text !== undefined;
		const hasChunks = params.chunks !== undefined;

		if (hasMarkdown && hasChunks) {
			throw new Error(
				"[SlackMessageService] Slack streams must use either markdown_text or chunks, not both",
			);
		}

		if (expectedMode === "markdown" && hasChunks) {
			throw new Error(
				"[SlackMessageService] Cannot append chunks to a markdown Slack stream",
			);
		}

		if (expectedMode === "chunks" && hasMarkdown) {
			throw new Error(
				"[SlackMessageService] Cannot append markdown_text to a chunks Slack stream",
			);
		}

		if (requireContent && !hasMarkdown && !hasChunks) {
			throw new Error(
				"[SlackMessageService] Slack stream append requires content for the stream mode",
			);
		}

		if (hasMarkdown) body.markdown_text = params.markdown_text;
		if (hasChunks) body.chunks = params.chunks;
	}
}
