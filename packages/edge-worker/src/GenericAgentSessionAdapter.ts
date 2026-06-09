import type { IAgentRunner, ILogger } from "cyrus-core";
import { createLogger } from "cyrus-core";
import type { AgentSessionSurfaceAdapter } from "./AgentSessionLifecycleService.js";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { GenericAgentSessionWebhook } from "./GenericAgentSessionTypes.js";

type CallbackKind = "received" | "processed" | "busy" | "stopped" | "response";

/**
 * Adapter for the first-class generic agent-session webhook contract.
 */
export class GenericAgentSessionAdapter
	implements AgentSessionSurfaceAdapter<GenericAgentSessionWebhook>
{
	readonly platformName = "generic" as const;
	private repositoryProvider: ChatRepositoryProvider;
	private repositoryRoutingContext: string;
	private logger: ILogger;

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
		this.logger =
			logger ?? createLogger({ component: "GenericAgentSessionAdapter" });
	}

	extractTaskInstructions(event: GenericAgentSessionWebhook): string {
		if (event.event.type === "agent_session.stopped") {
			return "";
		}
		return event.message?.body?.trim() || "Ask the user for more context.";
	}

	isSessionInitiatingEvent(event: GenericAgentSessionWebhook): boolean {
		return event.event.type === "agent_session.created";
	}

	isStopEvent(event: GenericAgentSessionWebhook): boolean {
		return event.event.type === "agent_session.stopped";
	}

	getThreadKey(event: GenericAgentSessionWebhook): string {
		return (
			event.session.bindingKey ??
			event.surface.threadId ??
			`${event.surface.type}:${event.surface.id ?? event.session.id}:${event.session.id}`
		);
	}

	getEventId(event: GenericAgentSessionWebhook): string {
		return event.event.id;
	}

	getSessionId(event: GenericAgentSessionWebhook): string {
		return `generic-${this.sanitizeId(event.surface.type)}-${this.sanitizeId(
			event.session.id,
		)}`;
	}

	buildSystemPrompt(event: GenericAgentSessionWebhook): string {
		const actor = event.actor
			? [
					event.actor.name ? `name=${event.actor.name}` : undefined,
					event.actor.email ? `email=${event.actor.email}` : undefined,
					event.actor.id ? `id=${event.actor.id}` : undefined,
				]
					.filter(Boolean)
					.join(", ") || "unknown"
			: "unknown";

		return `You are Cyrus responding to a generic agent-session webhook.

## Surface Context
- Surface type: ${event.surface.type}
- Surface id: ${event.surface.id ?? "unknown"}
- Surface thread id: ${event.surface.threadId ?? "unknown"}
- Surface URL: ${event.surface.url ?? "unknown"}
- Session id: ${event.session.id}
- Session title: ${event.session.title ?? "untitled"}
- Actor: ${actor}

## Response Contract
- Your final answer will be sent back to the source surface.
- Be concise and answer the latest message directly.
- If the request involves code changes, help plan the work and suggest creating an issue in the user's tracker unless the surface explicitly asks you to execute.

${this.buildRepositoryAccessSection()}
${this.repositoryRoutingContext ? `\n${this.repositoryRoutingContext}` : ""}

## Self-Knowledge
- If the user asks about Cyrus capabilities, setup, documentation, or how you work, use the \`mcp__cyrus-docs__search_documentation\` tool before answering.`;
	}

	async fetchThreadContext(event: GenericAgentSessionWebhook): Promise<string> {
		const messages = event.context?.messages ?? [];
		if (messages.length === 0) {
			return "";
		}

		const formattedMessages = messages
			.map((message) => {
				return `  <message>
    <author>${message.author ?? "unknown"}</author>
    <timestamp>${message.createdAt ?? ""}</timestamp>
    <content>
${message.body ?? ""}
    </content>
  </message>`;
			})
			.join("\n");

		return `<generic_agent_session_context>\n${formattedMessages}\n</generic_agent_session_context>`;
	}

	async postReply(
		event: GenericAgentSessionWebhook,
		runner: IAgentRunner,
	): Promise<void> {
		const body = this.extractLastAssistantText(runner) ?? "Task completed.";
		await this.postCallback(event, "response", body);
	}

	async acknowledgeReceipt(event: GenericAgentSessionWebhook): Promise<void> {
		await this.postCallback(event, "received");
	}

	async acknowledgeProcessed(event: GenericAgentSessionWebhook): Promise<void> {
		await this.postCallback(event, "processed");
	}

	async notifyBusy(event: GenericAgentSessionWebhook): Promise<void> {
		await this.postCallback(
			event,
			"busy",
			"I'm still working on the previous request for this session. I'll pick up the new message once I'm done.",
		);
	}

	async notifyStopped(event: GenericAgentSessionWebhook): Promise<void> {
		await this.postCallback(event, "stopped", "Session stop requested.");
	}

	private buildRepositoryAccessSection(): string {
		const repositoryPaths = Array.from(
			new Set(this.repositoryProvider.getRepositoryPaths().filter(Boolean)),
		).sort();

		if (repositoryPaths.length === 0) {
			return `## Repository Access
- No repository paths are configured for this session.`;
		}

		return `## Repository Access
- You have read-only access to the following configured repositories:
${repositoryPaths.map((path) => `- ${path}`).join("\n")}
- If you need to inspect source code in one of these repositories, use:
  - Bash(git -C * pull)`;
	}

	private extractLastAssistantText(runner: IAgentRunner): string | undefined {
		const lastAssistantMessage = [...runner.getMessages()]
			.reverse()
			.find((message) => message.type === "assistant");

		if (
			!lastAssistantMessage ||
			lastAssistantMessage.type !== "assistant" ||
			!("message" in lastAssistantMessage)
		) {
			return undefined;
		}

		const msg = lastAssistantMessage as {
			message: {
				content: Array<{ type: string; text?: string }>;
			};
		};
		const textBlock = msg.message.content?.find(
			(block) => block.type === "text" && block.text,
		);
		return textBlock?.text;
	}

	private async postCallback(
		event: GenericAgentSessionWebhook,
		kind: CallbackKind,
		body?: string,
	): Promise<void> {
		const url =
			kind === "response"
				? (event.response?.replyCallbackUrl ??
					event.response?.activityCallbackUrl)
				: event.response?.activityCallbackUrl;
		if (!url) {
			return;
		}

		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				...(process.env.CYRUS_API_KEY
					? { Authorization: `Bearer ${process.env.CYRUS_API_KEY}` }
					: {}),
			},
			body: JSON.stringify({
				version: 1,
				type: kind,
				sessionId: event.session.id,
				bindingKey: this.getThreadKey(event),
				eventId: event.event.id,
				surface: event.surface,
				body,
				createdAt: new Date().toISOString(),
			}),
		});

		if (!response.ok) {
			this.logger.warn(
				`Generic agent-session ${kind} callback failed (${response.status})`,
			);
		}
	}

	private sanitizeId(value: string): string {
		const sanitized = value.replace(/[^a-zA-Z0-9.-]/g, "_").slice(0, 120);
		return sanitized || "unknown";
	}
}
