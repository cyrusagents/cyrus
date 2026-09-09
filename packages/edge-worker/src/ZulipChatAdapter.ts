import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import {
	buildPromptText,
	type ZulipDestination,
	type ZulipMessage,
	ZulipMessageService,
	type ZulipWebhookEvent,
} from "cyrus-zulip-event-transport";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { ChatPlatformAdapter } from "./ChatSessionHandler.js";

/** How many topic messages a single catch-up read carries. */
const TOPIC_CONTEXT_MESSAGE_LIMIT = 50;

/** Reaction added when a message is received and queued for processing (👀) */
export const RECEIPT_REACTION = "eyes";

/**
 * Reaction that replaces the receipt one once the agent finished its turn (✅).
 *
 * Zulip's name for U+2705 is `check`, not the `white_check_mark` that Slack
 * and GitHub use — Zulip rejects an unknown name with a 400, and
 * `check_mark` is a different emoji (U+2714 ✔️).
 */
export const PROCESSED_REACTION = "check";

/**
 * Prefix Zulip puts on a topic's name when someone marks it resolved.
 *
 * Resolving renames the topic rather than setting a flag, so one continuous
 * conversation arrives under two different names over its life. Keying a
 * session on the raw name would strand that session — and its catch-up
 * cursor — the moment anyone resolves or unresolves the topic, which is a
 * routine action rather than an edge case.
 */
const RESOLVED_TOPIC_PREFIX = "\u2714 ";

/**
 * Width the message ID cursor is padded to.
 *
 * ChatSessionHandler compares thread cursors as strings (Slack timestamps are
 * zero-padded, so string order is chronological there). Zulip message IDs are
 * plain integers, where `"9" > "10"` — a raw ID would make the cursor move
 * backwards and re-deliver messages. Padding restores chronological string
 * ordering; `parseCursor` undoes it before the ID reaches the API.
 */
const CURSOR_WIDTH = 20;

/**
 * Zulip implementation of ChatPlatformAdapter.
 *
 * A Zulip topic is the thread unit, so a channel message's thread key is
 * `<stream_id>:<topic>`; a DM conversation keys on its participants instead.
 *
 * Unlike Slack, an outgoing webhook bot is only notified about messages that
 * address it (an @mention or a DM), so every event Cyrus sees is directed at
 * it. That removes the whole "decide whether this message was meant for you"
 * apparatus the Slack prompt needs — and it is why the catch-up read matters:
 * it is the only way anything said in the topic between two mentions reaches
 * the agent.
 */
export class ZulipChatAdapter
	implements ChatPlatformAdapter<ZulipWebhookEvent>
{
	readonly platformName = "zulip" as const;
	private repositoryProvider: ChatRepositoryProvider;
	private repositoryRoutingContext: string;
	private messageService: ZulipMessageService;
	private logger: ILogger;

	constructor(
		repositoryProvider: ChatRepositoryProvider,
		logger?: ILogger,
		options?: {
			repositoryRoutingContext?: string;
			messageService?: ZulipMessageService;
		},
	) {
		this.repositoryProvider = repositoryProvider;
		this.repositoryRoutingContext =
			options?.repositoryRoutingContext?.trim() || "";
		this.messageService = options?.messageService ?? new ZulipMessageService();
		this.logger = logger ?? createLogger({ component: "ZulipChatAdapter" });
	}

	extractTaskInstructions(event: ZulipWebhookEvent): string {
		return buildPromptText(event.data) || "Ask the user for more context";
	}

	getThreadKey(event: ZulipWebhookEvent): string {
		const { message } = event;
		if (message.type === "stream") {
			return `${message.stream_id}:${this.unresolvedTopic(message.subject)}`;
		}
		return `dm:${this.recipientIds(message).join(",")}`;
	}

	getEventId(event: ZulipWebhookEvent): string {
		return String(event.message.id);
	}

	/**
	 * Only channel topics get a catch-up cursor. Every DM sent to the bot
	 * triggers the webhook, so a DM session has already seen its whole
	 * conversation and re-reading it would only duplicate context.
	 */
	getThreadContextTs(event: ZulipWebhookEvent): string | undefined {
		if (event.message.type !== "stream") {
			return undefined;
		}
		return String(event.message.id).padStart(CURSOR_WIDTH, "0");
	}

	/**
	 * What was said in this topic since Cyrus last had context.
	 *
	 * One request either way: the newest window of the topic, from which the
	 * cursor selects what the agent has not seen. A resumed session already
	 * holds its own replies in memory, so those are dropped from a catch-up —
	 * but a fresh session has no memory at all and gets the whole window,
	 * Cyrus's own past replies included.
	 *
	 * Returns "" when there is nothing to add, `null` when the read failed —
	 * the caller only advances its cursor on a non-null result, so a failure
	 * retries the same window on the next mention instead of losing it.
	 */
	async fetchThreadContext(
		event: ZulipWebhookEvent,
		sinceTs?: string,
	): Promise<string | null> {
		const { message } = event;
		if (message.type !== "stream") {
			return "";
		}

		const channel = this.channelName(message);
		if (!channel) {
			this.logger.warn(
				`Cannot fetch Zulip topic context: no channel name on message ${message.id}`,
			);
			return null;
		}

		const sinceId = sinceTs ? this.parseCursor(sinceTs) : undefined;

		try {
			const messages = await this.messageService.fetchTopicMessages({
				credentials: event.credentials,
				channel,
				topic: message.subject,
				limit: TOPIC_CONTEXT_MESSAGE_LIMIT,
			});

			// Zulip returns the window oldest-first. Filling it means the topic
			// (or the gap since the cursor) is longer than one window and its
			// oldest messages fell off — worth saying so, rather than letting the
			// agent read a partial history as if it were complete.
			const oldestId = messages[0]?.id;
			const omittedEarlier =
				messages.length >= TOPIC_CONTEXT_MESSAGE_LIMIT &&
				oldestId !== undefined &&
				(sinceId === undefined || oldestId > sinceId);

			const relevant = messages.filter((msg) => {
				// Already carried by the task instructions
				if (msg.id === message.id) {
					return false;
				}
				if (sinceId === undefined) {
					return true;
				}
				// Already seen: either before the cursor, or said by this session
				return msg.id > sinceId && msg.sender_email !== event.botEmail;
			});

			if (relevant.length === 0) {
				return "";
			}

			const preamble =
				sinceId === undefined
					? ""
					: "The following messages were posted in this topic since you last had context. Read them for background before responding.\n\n";
			const truncationNote = omittedEarlier
				? "Older messages in this topic are not shown.\n\n"
				: "";

			return `${preamble}${truncationNote}${this.formatTopicContext(
				relevant,
				event.botEmail,
			)}`;
		} catch (error) {
			this.logger.warn(
				`Failed to fetch Zulip topic context: ${error instanceof Error ? error.message : String(error)}`,
			);
			return null;
		}
	}

	buildSystemPrompt(event: ZulipWebhookEvent): string {
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

		const { message } = event;
		const location =
			message.type === "stream"
				? `- **Channel**: ${this.channelName(message) ?? message.stream_id}\n- **Topic**: ${message.subject}`
				: "- **Direct message**";

		return `You are participating in a Zulip conversation.

## Context
- **Requested by**: ${message.sender_full_name} (${message.sender_email})
${location}

## When to Respond
- You are only notified about messages that address you directly — an @mention in a channel, or a direct message. Every message you receive is meant for you, so always respond.
- You may be given a catch-up block of messages posted since you last replied. That is background for your answer, not a set of requests to answer one by one.
- Be genuinely helpful and concise.

## Instructions
- You are running in a transient workspace, not associated with any code repository
- Be concise in your responses as they will be posted back to Zulip
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
  - To choose both execution harness and model from Linear labels, apply a \`<provider>/<model>\` label such as \`openai/gpt-5.5\`. For OpenCode, use \`opencode/<provider>/<model>\`, such as \`opencode/openai/gpt-5.5\`.
  - Assign that Issue to that same user (your own Linear user).
  - That assignment is what immediately kicks off work in your own agent session.
  - Track execution progress by searching \`mcp__cyrus-tools__linear_get_agent_sessions\` for the active session, then opening it with \`mcp__cyrus-tools__linear_get_agent_session\`.
  - To send mid-flight feedback or corrections to a running child session, use \`mcp__cyrus-tools__linear_agent_give_feedback\` with the session ID returned by \`linear_get_agent_sessions\`. This is the ONLY way to directly prompt a running child agent. \`mcp__linear__save_comment\` does NOT trigger or notify the agent in any way — it just writes a comment on the issue, which the running session will not see. Always prefer \`linear_agent_give_feedback\` when the child agent is actively working.

## Zulip Message Formatting
Your response is posted as a Zulip message. Zulip uses Markdown, so ordinary Markdown is correct — including \`[text](url)\` links, \`**bold**\`, tables, and fenced code blocks (give them a language, e.g. \`\`\`python).

Two Zulip-specific rules:
- To mention someone, write \`@**Full Name**\`. A plain \`@name\` does not notify anyone.
- Do not use headers (\`#\`). Zulip messages are short; use \`**bold**\` on its own line to separate sections.`;
	}

	async postReply(
		event: ZulipWebhookEvent,
		runner: IAgentRunner,
	): Promise<void> {
		try {
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

			await this.messageService.postMessage({
				credentials: event.credentials,
				destination: this.destinationFor(event.message),
				content: summary,
			});

			this.logger.info(
				`Posted Zulip reply (thread ${this.getThreadKey(event)})`,
			);
		} catch (error) {
			this.logger.error(
				"Failed to post Zulip reply",
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	async acknowledgeReceipt(event: ZulipWebhookEvent): Promise<void> {
		await this.messageService.addReaction(
			event.credentials,
			event.message.id,
			RECEIPT_REACTION,
		);
	}

	/**
	 * Swap the receipt reaction (👀) for a processed one (✅) once the agent
	 * has finished its turn for this message.
	 */
	async acknowledgeProcessed(event: ZulipWebhookEvent): Promise<void> {
		// Remove before adding so the two are never visible together — the swap
		// reads as a clean transition.
		await this.messageService.removeReaction(
			event.credentials,
			event.message.id,
			RECEIPT_REACTION,
		);
		await this.messageService.addReaction(
			event.credentials,
			event.message.id,
			PROCESSED_REACTION,
		);
	}

	async notifyBusy(event: ZulipWebhookEvent): Promise<void> {
		await this.messageService.postMessage({
			credentials: event.credentials,
			destination: this.destinationFor(event.message),
			content:
				"I'm still working on the previous request in this topic. I'll pick up your new message once I'm done.",
		});
	}

	/** Where a reply to this message should go */
	private destinationFor(message: ZulipMessage): ZulipDestination {
		if (message.type === "stream" && message.stream_id !== undefined) {
			return {
				type: "stream",
				streamId: message.stream_id,
				topic: message.subject,
			};
		}
		return { type: "private", userIds: this.recipientIds(message) };
	}

	/** Participants of a DM conversation, sorted so the key is stable */
	private recipientIds(message: ZulipMessage): number[] {
		const recipients = Array.isArray(message.display_recipient)
			? message.display_recipient
			: [];
		if (recipients.length === 0) {
			return [message.sender_id];
		}
		return recipients.map((recipient) => recipient.id).sort((a, b) => a - b);
	}

	/**
	 * The topic's name with any resolved marker removed, for identity only.
	 *
	 * Every call that actually addresses Zulip — posting a reply, narrowing a
	 * history read — uses the raw subject instead, because that is the topic's
	 * real name right now.
	 */
	private unresolvedTopic(subject: string): string {
		return subject.startsWith(RESOLVED_TOPIC_PREFIX)
			? subject.slice(RESOLVED_TOPIC_PREFIX.length)
			: subject;
	}

	/** Channel name of a channel message, needed to build a narrow */
	private channelName(message: ZulipMessage): string | undefined {
		return typeof message.display_recipient === "string"
			? message.display_recipient
			: undefined;
	}

	private parseCursor(cursor: string): number {
		return Number(cursor);
	}

	private formatTopicContext(
		messages: ZulipMessage[],
		botEmail: string,
	): string {
		const formattedMessages = messages
			.map((msg) => {
				const author =
					msg.sender_email === botEmail
						? "assistant (you)"
						: msg.sender_full_name;
				return `  <message>
    <author>${author}</author>
    <id>${msg.id}</id>
    <content>
${msg.content}
    </content>
  </message>`;
			})
			.join("\n");

		return `<zulip_topic_context>\n${formattedMessages}\n</zulip_topic_context>`;
	}
}
