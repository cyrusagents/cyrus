/**
 * Service for adding reactions to Slack messages.
 *
 * Uses the Slack Web API with a bot token to add emoji reactions,
 * typically used to acknowledge receipt of @mention webhooks.
 */

/**
 * Parameters for adding a reaction to a Slack message
 */
export interface SlackAddReactionParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID where the message is */
	channel: string;
	/** Timestamp of the message to react to */
	timestamp: string;
	/** Emoji name (without colons), e.g. "eyes" */
	name: string;
}

export class SlackReactionService {
	private apiBaseUrl: string;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = apiBaseUrl ?? "https://slack.com/api";
	}

	/**
	 * Add a reaction to a Slack message.
	 *
	 * @see https://api.slack.com/methods/reactions.add
	 */
	async addReaction(params: SlackAddReactionParams): Promise<void> {
		const { token, channel, timestamp, name } = params;

		const url = `${this.apiBaseUrl}/reactions.add`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ channel, timestamp, name }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackReactionService] Failed to add reaction: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		// Slack API returns HTTP 200 even for errors — check the response body
		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
		};
		if (!responseBody.ok) {
			// "already_reacted" is not an error worth surfacing
			if (responseBody.error === "already_reacted") {
				return;
			}
			throw new Error(
				`[SlackReactionService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}
	}
}
