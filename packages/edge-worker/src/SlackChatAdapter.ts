import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	SlackMessageService,
	SlackReactionService,
	type SlackThreadMessage,
	type SlackWebhookEvent,
	stripMention as stripSlackMention,
} from "cyrus-slack-event-transport";
import type { ChatPlatformAdapter } from "./ChatSessionHandler.js";

/**
 * Slack implementation of ChatPlatformAdapter.
 *
 * Contains all Slack-specific logic extracted from EdgeWorker:
 * text extraction, thread keys, system prompts, thread context,
 * reply posting, and acknowledgement reactions.
 */
export class SlackChatAdapter
	implements ChatPlatformAdapter<SlackWebhookEvent>
{
	readonly platformName = "slack" as const;
	private logger: ILogger;

	constructor(logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "SlackChatAdapter" });
	}

	extractTaskInstructions(event: SlackWebhookEvent): string {
		return (
			stripSlackMention(event.payload.text) || "Ask the user for more context"
		);
	}

	getThreadKey(event: SlackWebhookEvent): string {
		const threadTs = event.payload.thread_ts || event.payload.ts;
		return `${event.payload.channel}:${threadTs}`;
	}

	getEventId(event: SlackWebhookEvent): string {
		return event.eventId;
	}

	buildSystemPrompt(event: SlackWebhookEvent): string {
		return `You are responding to a Slack @mention.

## Context
- **Requested by**: ${event.payload.user}
- **Channel**: ${event.payload.channel}

## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Slack
- If the user's request involves code changes, help them plan the work and suggest creating an issue in their project tracker (Linear, Jira, or GitHub Issues)
- You can answer questions, provide analysis, help with planning, and assist with research
- If files need to be created or examined, they will be in your working directory`;
	}

	async fetchThreadContext(event: SlackWebhookEvent): Promise<string> {
		// Only fetch context for threaded messages
		if (!event.payload.thread_ts) {
			return "";
		}

		if (!event.slackBotToken) {
			this.logger.warn(
				"Cannot fetch Slack thread context: no slackBotToken available",
			);
			return "";
		}

		try {
			const slackService = new SlackMessageService();
			const messages = await slackService.fetchThreadMessages({
				token: event.slackBotToken,
				channel: event.payload.channel,
				thread_ts: event.payload.thread_ts,
				limit: 50,
			});

			// Filter out the @mention message itself and bot messages
			const contextMessages = messages.filter(
				(msg) =>
					msg.ts !== event.payload.ts &&
					!msg.bot_id &&
					msg.subtype !== "bot_message",
			);

			if (contextMessages.length === 0) {
				return "";
			}

			return this.formatThreadContext(contextMessages);
		} catch (error) {
			this.logger.warn(
				`Failed to fetch Slack thread context: ${error instanceof Error ? error.message : String(error)}`,
			);
			return "";
		}
	}

	async postReply(
		event: SlackWebhookEvent,
		runner: IAgentRunner,
	): Promise<void> {
		try {
			// Get the last assistant message from the runner as the summary
			const messages = runner.getMessages();
			const lastAssistantMessage = [...messages]
				.reverse()
				.find((m) => m.type === "assistant");

			let summary = "Task completed.";
			if (
				lastAssistantMessage &&
				lastAssistantMessage.type === "assistant" &&
				"message" in lastAssistantMessage
			) {
				const msg = lastAssistantMessage as {
					message: {
						content: Array<{ type: string; text?: string }>;
					};
				};
				const textBlock = msg.message.content?.find(
					(block) => block.type === "text" && block.text,
				);
				if (textBlock?.text) {
					summary = textBlock.text;
				}
			}

			if (!event.slackBotToken) {
				this.logger.warn("Cannot post Slack reply: no slackBotToken available");
				return;
			}

			// Thread the reply under the original message
			const threadTs = event.payload.thread_ts || event.payload.ts;

			await new SlackMessageService().postMessage({
				token: event.slackBotToken,
				channel: event.payload.channel,
				text: summary,
				thread_ts: threadTs,
			});

			this.logger.info(
				`Posted Slack reply to channel ${event.payload.channel} (thread ${threadTs})`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post Slack reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	async acknowledgeReceipt(event: SlackWebhookEvent): Promise<void> {
		if (!event.slackBotToken) {
			this.logger.warn(
				"Cannot add Slack reaction: no slackBotToken available (SLACK_BOT_TOKEN env var not set)",
			);
			return;
		}

		await new SlackReactionService().addReaction({
			token: event.slackBotToken,
			channel: event.payload.channel,
			timestamp: event.payload.ts,
			name: "eyes",
		});
	}

	async notifyBusy(event: SlackWebhookEvent): Promise<void> {
		if (!event.slackBotToken) {
			return;
		}

		const threadTs = event.payload.thread_ts || event.payload.ts;

		await new SlackMessageService().postMessage({
			token: event.slackBotToken,
			channel: event.payload.channel,
			text: "I'm still working on the previous request in this thread. I'll pick up your new message once I'm done.",
			thread_ts: threadTs,
		});
	}

	private formatThreadContext(messages: SlackThreadMessage[]): string {
		const formattedMessages = messages
			.map(
				(msg) =>
					`  <message>
    <author>${msg.user ?? "unknown"}</author>
    <timestamp>${msg.ts}</timestamp>
    <content>
${msg.text}
    </content>
  </message>`,
			)
			.join("\n");

		return `<slack_thread_context>\n${formattedMessages}\n</slack_thread_context>`;
	}
}
