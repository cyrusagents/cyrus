import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	SlackMessageService,
	SlackReactionService,
	type SlackThreadMessage,
	type SlackWebhookEvent,
	stripMention as stripSlackMention,
} from "cyrus-slack-event-transport";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
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
	private repositoryProvider: ChatRepositoryProvider;
	private repositoryRoutingContext: string;
	private logger: ILogger;
	private selfBotId: string | undefined;

	constructor(
		repositoryProvider: ChatRepositoryProvider,
		logger?: ILogger,
		options?: {
			repositoryRoutingContext?: string;
		},
	) {
		this.repositoryProvider = repositoryProvider;
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		this.logger = logger ?? createLogger({ component: "SlackChatAdapter" });
	}

	/**
	 * Get the Slack bot token, falling back to process.env if the event doesn't carry one.
	 *
	 * The event's slackBotToken is set at webhook-reception time by SlackEventTransport.
	 * During startup transitions (e.g. switching from cloud to self-host), the token may
	 * not yet be in process.env when the event is created but may arrive shortly after
	 * via an async env update. This fallback ensures the token is picked up even if
	 * it was loaded into process.env after the event was created.
	 */
	private getSlackBotToken(event: SlackWebhookEvent): string | undefined {
		return event.slackBotToken ?? process.env.SLACK_BOT_TOKEN;
	}

	private async getSelfBotId(token: string): Promise<string | undefined> {
		if (this.selfBotId) {
			return this.selfBotId;
		}
		try {
			const identity = await new SlackMessageService().getIdentity(token);
			this.selfBotId = identity.bot_id;
			return this.selfBotId;
		} catch (error) {
			this.logger.warn(
				`Failed to resolve bot identity: ${error instanceof Error ? error.message : String(error)}`,
			);
			return undefined;
		}
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
		const repositoryPaths = Array.from(
			new Set(this.repositoryProvider.getRepositoryPaths().filter(Boolean)),
		).sort();
		const repositoryAccessSection =
			repositoryPaths.length > 0
				? `
## Repository Access
- You have read-only access to the following configured repositories:
${repositoryPaths.map((path) => `- ${path}`).join("\n")}

- If you need to inspect source code in one of these repositories, use:
  - Bash(git -C * pull)

- You are explicitly allowed to run git pull with:
  - Bash(git -C * pull)
			`
				: `
## Repository Access
- No repository paths are configured for this chat session.`;

		return `You are responding to a Slack @mention.

## Context
- **Requested by**: ${event.payload.user}
- **Channel**: ${event.payload.channel}

## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Slack
- If the user's request involves code changes, help them plan the work and suggest creating an issue in their project tracker (Linear, Jira, or GitHub Issues)
- You can answer questions, provide analysis, help with planning, and assist with research
- If files need to be created or examined, they will be in your working directory
${repositoryAccessSection}
${this.repositoryRoutingContext ? `\n\n${this.repositoryRoutingContext}` : ""}

## Self-Knowledge
- If the user asks about your capabilities, features, how you work, what you can do, setup instructions, or anything related to Cyrus documentation, use the \`mcp__cyrus-docs__search_documentation\` tool to look up the answer from the official Cyrus docs.
- Always prefer searching the docs over guessing or relying on your training data for Cyrus-specific questions.

## Orchestration Notes
- If the user asks you to make repo code changes immediately, use these steps:
  - First run \`mcp__linear__get_user\` with \`query: "me"\` to get your Linear identity.
  - Create an Issue in the user's tracker for the requested work (for example using \`mcp__linear__save_issue\`), including enough context and acceptance criteria to execute it. Default the issue status/state to "Backlog". **IMPORTANT: Never set the status to "Triage".**
  - To route the issue to a specific repository, add \`[repo=repo-name]\` to the issue description. To target a specific branch, use \`[repo=repo-name#branch-name]\`. For multiple repos: \`repos=repo1,repo2\`.
  - Assign that Issue to that same user (your own Linear user).
  - That assignment is what immediately kicks off work in your own agent session.
  - Track execution progress by searching \`mcp__cyrus-tools__linear_get_agent_sessions\` for the active session, then opening it with \`mcp__cyrus-tools__linear_get_agent_session\`.

## Slack Message Formatting (CRITICAL)
Your response will be posted as a Slack message. Slack uses its own "mrkdwn" format, which is NOT standard Markdown. You MUST follow these rules exactly.

NEVER use any of the following — they do not render in Slack and will appear as broken plain text:
- NO tables (no | --- | syntax — use numbered lists or plain text instead)
- NO headers (no # syntax — use *bold text* on its own line instead)
- NO [text](url) links — use <url|text> instead
- NO **double asterisk** bold — use *single asterisk* instead
- NO image embeds

Supported mrkdwn syntax:
- Bold: *bold text* (single asterisks only)
- Italic: _italic text_
- Strikethrough: ~struck text~
- Inline code: \`code\`
- Code blocks: \`\`\`code block\`\`\`
- Blockquote: > quoted text (at start of line)
- Links: <https://example.com|display text>
- Lists: use plain numbered lines (1. item) or dashes (- item) with newlines`;
	}

	async fetchThreadContext(event: SlackWebhookEvent): Promise<string> {
		// Only fetch context for threaded messages
		if (!event.payload.thread_ts) {
			return "";
		}

		const token = this.getSlackBotToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot fetch Slack thread context: no slackBotToken available",
			);
			return "";
		}

		try {
			const slackService = new SlackMessageService();
			const [messages, selfBotId] = await Promise.all([
				slackService.fetchThreadMessages({
					token,
					channel: event.payload.channel,
					thread_ts: event.payload.thread_ts,
					limit: 50,
				}),
				this.getSelfBotId(token),
			]);

			if (messages.length === 0) {
				return "";
			}

			// Include all messages (user and bot) so follow-up sessions retain
			// full conversation history, especially when the runner type changes.
			return this.formatThreadContext(messages, selfBotId);
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

			const token = this.getSlackBotToken(event);
			if (!token) {
				this.logger.warn("Cannot post Slack reply: no slackBotToken available");
				return;
			}

			// Thread the reply under the original message
			const threadTs = event.payload.thread_ts || event.payload.ts;

			await new SlackMessageService().postMessage({
				token,
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
		const token = this.getSlackBotToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot add Slack reaction: no slackBotToken available (SLACK_BOT_TOKEN env var not set)",
			);
			return;
		}

		await new SlackReactionService().addReaction({
			token,
			channel: event.payload.channel,
			timestamp: event.payload.ts,
			name: "eyes",
		});
	}

	async notifyBusy(event: SlackWebhookEvent): Promise<void> {
		const token = this.getSlackBotToken(event);
		if (!token) {
			return;
		}

		const threadTs = event.payload.thread_ts || event.payload.ts;

		await new SlackMessageService().postMessage({
			token,
			channel: event.payload.channel,
			text: "I'm still working on the previous request in this thread. I'll pick up your new message once I'm done.",
			thread_ts: threadTs,
		});
	}

	async notifyUnavailable(
		event: SlackWebhookEvent,
		_threadKey: string,
		message: string,
	): Promise<void> {
		const token = this.getSlackBotToken(event);
		if (!token) {
			return;
		}

		const threadTs = event.payload.thread_ts || event.payload.ts;

		await new SlackMessageService().postMessage({
			token,
			channel: event.payload.channel,
			text: message,
			thread_ts: threadTs,
		});
	}

	private formatThreadContext(
		messages: SlackThreadMessage[],
		selfBotId?: string,
	): string {
		const formattedMessages = messages
			.map((msg) => {
				const isSelf = selfBotId && msg.bot_id === selfBotId;
				const author = isSelf ? "assistant (you)" : (msg.user ?? "unknown");
				return `  <message>
    <author>${author}</author>
    <timestamp>${msg.ts}</timestamp>
    <content>
${msg.text}
    </content>
  </message>`;
			})
			.join("\n");

		return `<slack_thread_context>\n${formattedMessages}\n</slack_thread_context>`;
	}
}
