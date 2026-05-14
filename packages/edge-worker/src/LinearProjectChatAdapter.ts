import type { IAgentRunner, ILogger, ProjectUpdateWebhook } from "cyrus-core";
import { createLogger } from "cyrus-core";
import type { LinearIssueTrackerService } from "cyrus-linear-event-transport";
import type { ChatRepositoryProvider } from "./ChatRepositoryProvider.js";
import type { ChatPlatformAdapter } from "./ChatSessionHandler.js";

/**
 * Resolves the Linear issue-tracker service for a given workspace.
 * Passed `undefined` when the workspace id can't be determined — implementers
 * should fall back to the single configured Linear workspace.
 */
export type LinearServiceResolver = (
	workspaceId: string | undefined,
) => LinearIssueTrackerService | undefined;

/**
 * Strip a leading/standalone `@<name>` mention of this agent from a Project
 * Update body, so the prompt handed to the runner is just the actual ask.
 *
 * Liberal on encoding: matches a bare `@Name`, and also a markdown-link form
 * `[@Name](url)` that Linear sometimes emits for mentions. Case-insensitive.
 */
export function stripLinearSelfMention(
	body: string,
	selfName: string | undefined,
): string {
	if (!selfName) return body.trim();
	const escaped = selfName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return body
		.replace(new RegExp(`\\[@?${escaped}\\]\\([^)]*\\)`, "gi"), "")
		.replace(new RegExp(`@${escaped}\\b`, "gi"), "")
		.trim();
}

/**
 * Linear Project Update implementation of {@link ChatPlatformAdapter}.
 *
 * Lets an agent be @-mentioned inside a Linear **Project Update** and reply
 * conversationally. Unlike issue-bound sessions, a Project Update session has
 * no git worktree — it runs in a plain workspace directory (see
 * {@link ChatSessionHandler}) because the surface is a discussion, not code.
 *
 * The "thread" is the project itself: every Update on a given project resumes
 * the same chat session, so the agent keeps continuity across the project's
 * Updates feed. A reply is posted as a *new* Project Update on the same
 * project — Project Updates have no comment thread of their own.
 */
export class LinearProjectChatAdapter
	implements ChatPlatformAdapter<ProjectUpdateWebhook>
{
	readonly platformName = "linear" as const;
	private repositoryProvider: ChatRepositoryProvider;
	private getLinearService: LinearServiceResolver;
	private getSelfName: () => string | undefined;
	private logger: ILogger;

	constructor(
		repositoryProvider: ChatRepositoryProvider,
		getLinearService: LinearServiceResolver,
		getSelfName: () => string | undefined,
		logger?: ILogger,
	) {
		this.repositoryProvider = repositoryProvider;
		this.getLinearService = getLinearService;
		this.getSelfName = getSelfName;
		this.logger =
			logger ?? createLogger({ component: "LinearProjectChatAdapter" });
	}

	private serviceFor(
		event: ProjectUpdateWebhook,
	): LinearIssueTrackerService | undefined {
		const service = this.getLinearService(event.organizationId);
		if (!service) {
			this.logger.warn(
				`No Linear service for workspace ${event.organizationId} — cannot process Project Update ${event.data.id}`,
			);
		}
		return service;
	}

	extractTaskInstructions(event: ProjectUpdateWebhook): string {
		const stripped = stripLinearSelfMention(
			event.data.body ?? "",
			this.getSelfName(),
		);
		return stripped || "Ask the user what they need.";
	}

	/**
	 * The "thread" is the project — every Update on the same project resumes
	 * one chat session, giving the agent continuity across the Updates feed.
	 */
	getThreadKey(event: ProjectUpdateWebhook): string {
		return `linear-project:${event.data.projectId}`;
	}

	getEventId(event: ProjectUpdateWebhook): string {
		return event.data.id;
	}

	buildSystemPrompt(event: ProjectUpdateWebhook): string {
		const repositoryPaths = Array.from(
			new Set(this.repositoryProvider.getRepositoryPaths().filter(Boolean)),
		).sort();
		const repositoryAccessSection =
			repositoryPaths.length > 0
				? `
## Repository Access
- You have read-only access to the following configured repositories:
${repositoryPaths.map((path) => `- ${path}`).join("\n")}
- If you need to inspect source code, use \`Bash(git -C * pull)\` first to refresh it.`
				: `
## Repository Access
- No repository paths are configured for this session.`;

		// The agent's persona lives in the default repository's appendInstruction
		// (per-repo persona block — see cyrus-runbook). Carry it into the prompt
		// so a Project Update session still knows which agent it is.
		const persona = this.repositoryProvider
			.getDefaultRepository()
			?.appendInstruction?.trim();
		const personaSection = persona ? `\n## Who you are\n${persona}\n` : "";

		return `You are responding to an @mention inside a Linear **Project Update**.
${personaSection}
## Context
- **Project**: ${event.data.project.name}
- **Posted by**: ${event.data.user?.name ?? event.data.userId}
- This is a project-level discussion surface, not an issue and not a code task.

## Instructions
- You are running in a transient workspace, not associated with any code repository worktree.
- Be concise and direct — your reply is posted back as a new Project Update on this project.
- Answer the question, give the analysis, or help plan the work. If the request needs code changes, help scope it and suggest creating a Linear issue (issues are where code work happens — Project Updates are for discussion).
- The project's description and recent Updates are provided below as standing context.
${repositoryAccessSection}

## Reply formatting
- Your reply is posted as a Linear Project Update. Linear renders standard Markdown — headings, **bold**, lists, \`code\`, and [links](url) all work.
- Do not prefix your reply with an @mention or a greeting; just give the substantive response.`;
	}

	async fetchThreadContext(event: ProjectUpdateWebhook): Promise<string> {
		const service = this.serviceFor(event);
		if (!service) return "";

		const projectId = event.data.projectId;
		try {
			const project = await service.fetchProject(projectId);

			const descriptionBlock = project.description
				? `  <project_description>\n${project.description}\n  </project_description>`
				: "";

			// Recent Updates on this project, oldest-first, excluding the one that
			// triggered this session (its text is already the user prompt).
			let updatesBlock = "";
			try {
				const updates = await project.projectUpdates({ first: 15 });
				const formatted = (
					await Promise.all(
						updates.nodes
							.filter((u) => u.id !== event.data.id)
							.map(async (u) => {
								let author = "unknown";
								try {
									const user = await u.user;
									author = user?.displayName ?? user?.name ?? "unknown";
								} catch {
									// author lookup is best-effort
								}
								return `  <update>
    <author>${author}</author>
    <timestamp>${u.createdAt}</timestamp>
    <content>
${u.body}
    </content>
  </update>`;
							}),
					)
				)
					.reverse()
					.join("\n");
				if (formatted) {
					updatesBlock = `  <recent_updates>\n${formatted}\n  </recent_updates>`;
				}
			} catch (error) {
				this.logger.warn(
					`Failed to fetch recent updates for project ${projectId}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}

			const inner = [descriptionBlock, updatesBlock].filter(Boolean).join("\n");
			return inner
				? `<linear_project_context>\n${inner}\n</linear_project_context>`
				: "";
		} catch (error) {
			this.logger.warn(
				`Failed to fetch project context for ${projectId}: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return "";
		}
	}

	async postReply(
		event: ProjectUpdateWebhook,
		runner: IAgentRunner,
	): Promise<void> {
		const service = this.serviceFor(event);
		if (!service) return;

		// Pull the last assistant text block from the runner as the reply body.
		const messages = runner.getMessages();
		const lastAssistantMessage = [...messages]
			.reverse()
			.find((m) => m.type === "assistant");

		let body = "Done.";
		if (
			lastAssistantMessage &&
			lastAssistantMessage.type === "assistant" &&
			"message" in lastAssistantMessage
		) {
			const msg = lastAssistantMessage as {
				message: { content: Array<{ type: string; text?: string }> };
			};
			const textBlock = msg.message.content?.find(
				(block) => block.type === "text" && block.text,
			);
			if (textBlock?.text) {
				body = textBlock.text;
			}
		}

		try {
			await service.createProjectUpdate(event.data.projectId, body);
			this.logger.info(
				`Posted reply Project Update on project ${event.data.project.name} (${event.data.projectId})`,
			);
		} catch (error) {
			this.logger.error(
				`Failed to post reply Project Update on project ${event.data.projectId}`,
				error instanceof Error ? error : new Error(String(error)),
			);
		}
	}

	/**
	 * No lightweight ack primitive for Project Updates (a reaction would be
	 * possible but noisy). The reply Update itself is the acknowledgement.
	 */
	async acknowledgeReceipt(_event: ProjectUpdateWebhook): Promise<void> {
		// intentional no-op
	}

	/**
	 * If a previous turn is still running for this project, we don't post a
	 * "still working" Update — that would spam the project's Updates feed.
	 * The follow-up is dropped with a log line; the user can re-post.
	 */
	async notifyBusy(
		event: ProjectUpdateWebhook,
		threadKey: string,
	): Promise<void> {
		this.logger.info(
			`Project Update ${event.data.id} arrived while session for ${threadKey} is busy — not posting a busy notice (would spam the Updates feed). Dropping follow-up.`,
		);
	}
}
