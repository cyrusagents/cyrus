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
 * Sentinel the agent emits when it has decided a Slack message does not warrant
 * a reply. `postReply` recognizes it and stays silent instead of posting.
 *
 * This is what makes the "only respond when relevant" policy in the system
 * prompt actually take effect: because every completed turn would otherwise be
 * posted back to the thread, the agent needs an explicit way to say "nothing to
 * post here". Kept as a single constant so the prompt and the suppression check
 * can never drift apart.
 */
export const SLACK_NO_RESPONSE_SENTINEL = "<<NO_RESPONSE>>";

/**
 * Route of the hosted Behaviours settings page (relative to the Cyrus app
 * base URL) where automatic Slack thread listening can be turned off.
 */
export const BEHAVIOURS_PAGE_ROUTE = "/settings/behaviours";

/** Reaction added when a message is received and queued for processing (👀) */
export const RECEIPT_REACTION = "eyes";

/** Reaction that replaces the receipt one once the agent finished its turn (✅) */
export const PROCESSED_REACTION = "white_check_mark";

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
	private behavioursPageUrl: string;
	private logger: ILogger;
	private selfBotId: string | undefined;

	constructor(
		repositoryProvider: ChatRepositoryProvider,
		logger?: ILogger,
		options?: {
			repositoryRoutingContext?: string;
			/**
			 * Base URL of the hosted Cyrus app (e.g. https://app.atcyrus.com).
			 * Only set for managed teams — community members have no Behaviours
			 * page, so the system prompt omits the stop-listening guidance
			 * entirely when this is empty. The Behaviours page URL is composed
			 * from this base and BEHAVIOURS_PAGE_ROUTE.
			 */
			cyrusAppBaseUrl?: string;
		},
	) {
		this.repositoryProvider = repositoryProvider;
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		const appBaseUrl = options?.cyrusAppBaseUrl?.trim().replace(/\/+$/, "");
		this.behavioursPageUrl = appBaseUrl
			? `${appBaseUrl}${BEHAVIOURS_PAGE_ROUTE}`
			: "";
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

	/**
	 * Decide whether an event may start a session when the runtime has no
	 * in-memory binding for its thread.
	 *
	 * - An explicit @mention always may.
	 * - A plain `message` event may only when it was upstream-gated (proxy mode):
	 *   CYHOST forwards `message` events solely for threads it has a persistent
	 *   binding row for, so reaching us means the thread is genuinely bound. This
	 *   is what lets Cyrus keep answering follow-ups after a process restart wipes
	 *   the in-memory binding — the prior Slack thread is rehydrated via
	 *   `fetchThreadContext`. In direct mode (`upstreamGated` false) there is no
	 *   such guarantee, so an unbound plain message is ignored to avoid starting a
	 *   session for arbitrary channel chatter.
	 */
	isSessionInitiatingEvent(event: SlackWebhookEvent): boolean {
		return event.eventType === "app_mention" || event.upstreamGated === true;
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

		const stopListeningSection = this.behavioursPageUrl
			? `

## Stopping Automatic Listening
- If the user asks you to stop listening to, following, or responding in this thread:
  - Tell them automatic thread listening can be turned off on the Behaviours page: <${this.behavioursPageUrl}|Behaviours page>.
  - From that point on, treat this thread as muted: stay silent (emit \`${SLACK_NO_RESPONSE_SENTINEL}\` and nothing else) for every subsequent message until someone asks you a direct question — addressing you by name ("Cyrus, …") or with an @mention. When you resume responding, just answer — do not announce that you are listening again.`
			: "";

		return `You are participating in a Slack thread.

## Context
- **Requested by**: ${event.payload.user}
- **Channel**: ${event.payload.channel}

## When to Respond (IMPORTANT)
- After you are first @mentioned, you receive **every** subsequent message in this thread, not just the ones aimed at you. Do not treat every message as a request for you.
- Respond ONLY when at least one of these is true:
  1. The message asks a question you can genuinely and helpfully answer, OR
  2. Someone addresses you directly — by name ("Cyrus, …") or with an @mention.
- For anything else — side conversation between people, acknowledgements ("thanks", "👍"), status chatter, or messages clearly not directed at you — do NOT reply.
- When you should stay silent, output exactly \`${SLACK_NO_RESPONSE_SENTINEL}\` and nothing else — no reasoning, no explanation, not a single word before or after the token.
- NEVER narrate your decision about whether to respond. Your entire output is posted verbatim to the thread — there is no private scratchpad. Thoughts like "the user didn't address me by name, so I should stay quiet" or "they addressed me by name, so I'm listening again" must never appear in your output. Either emit the bare token, or reply directly to the user's message as if the decision never happened.
- When you do respond, be genuinely helpful and concise.${stopListeningSection}

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
  - To choose a specific execution harness, add \`[agent=claude]\`, \`[agent=gemini]\`, \`[agent=codex]\`, \`[agent=cursor]\`, or \`[agent=opencode]\` to the issue description.
  - Assign that Issue to that same user (your own Linear user).
  - That assignment is what immediately kicks off work in your own agent session.
  - Track execution progress by searching \`mcp__cyrus-tools__linear_get_agent_sessions\` for the active session, then opening it with \`mcp__cyrus-tools__linear_get_agent_session\`.
  - To send mid-flight feedback or corrections to a running child session, use \`mcp__cyrus-tools__linear_agent_give_feedback\` with the session ID returned by \`linear_get_agent_sessions\`. This is the ONLY way to directly prompt a running child agent. \`mcp__linear__save_comment\` does NOT trigger or notify the agent in any way — it just writes a comment on the issue, which the running session will not see. Always prefer \`linear_agent_give_feedback\` when the child agent is actively working.

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

			// The agent emits the no-response sentinel when it judged this message
			// didn't warrant a reply (see the "When to Respond" system prompt
			// section). Honor that by posting nothing. Deliberately a substring
			// check, not an exact match: agents sometimes narrate their reasoning
			// around the token despite being told not to, and that deliberation
			// must never reach the thread — the token's presence anywhere means
			// "do not post".
			if (summary.includes(SLACK_NO_RESPONSE_SENTINEL)) {
				this.logger.info(
					`Slack agent opted not to respond in channel ${event.payload.channel} (no-response sentinel)`,
				);
				return;
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
			name: RECEIPT_REACTION,
		});
	}

	/**
	 * Swap the receipt reaction (👀) for a processed one (✅) once the agent
	 * has finished its turn for this message. This runs whether or not a reply
	 * was posted, so users can tell a silently-skipped message was still seen.
	 */
	async acknowledgeProcessed(event: SlackWebhookEvent): Promise<void> {
		const token = this.getSlackBotToken(event);
		if (!token) {
			this.logger.warn(
				"Cannot update Slack reaction: no slackBotToken available (SLACK_BOT_TOKEN env var not set)",
			);
			return;
		}

		const reactionService = new SlackReactionService();
		const target = {
			token,
			channel: event.payload.channel,
			timestamp: event.payload.ts,
		};

		// Remove the receipt reaction before adding the processed one so the
		// two are never visible together — the swap reads as a clean
		// transition. (Slack has no atomic swap; if the add fails the message
		// is briefly indicator-less, which beats showing both.)
		await reactionService.removeReaction({ ...target, name: RECEIPT_REACTION });
		await reactionService.addReaction({ ...target, name: PROCESSED_REACTION });
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
