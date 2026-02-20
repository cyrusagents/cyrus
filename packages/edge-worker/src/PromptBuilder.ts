import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
	Comment,
	EdgeWorkerConfig,
	GuidanceRule,
	IIssueTrackerService,
	ILogger,
	Issue,
	IssueMinimal,
	RepositoryConfig,
	WebhookAgentSession,
	WebhookComment,
} from "cyrus-core";
import type { GitService } from "./GitService.js";
import type { SubroutineDefinition } from "./procedures/index.js";

/**
 * Dependencies required by the PromptBuilder
 */
export interface PromptBuilderDeps {
	logger: ILogger;
	repositories: Map<string, RepositoryConfig>;
	issueTrackers: Map<string, IIssueTrackerService>;
	gitService: GitService;
	config: EdgeWorkerConfig;
}

/**
 * System prompt result from label-based determination
 */
export interface SystemPromptResult {
	prompt: string;
	version?: string;
	type?:
		| "debugger"
		| "builder"
		| "scoper"
		| "orchestrator"
		| "graphite-orchestrator";
}

/**
 * Result from building a prompt (prompt text + optional version)
 */
export interface PromptResult {
	prompt: string;
	version?: string;
}

/**
 * Responsible for building various prompt types used in the EdgeWorker.
 *
 * Extracted from EdgeWorker to improve separation of concerns.
 * Handles label-based prompts, mention prompts, issue context prompts,
 * issue update prompts, subroutine prompt loading, and related utilities.
 */
export class PromptBuilder {
	private readonly logger: ILogger;
	private readonly repositories: Map<string, RepositoryConfig>;
	private readonly issueTrackers: Map<string, IIssueTrackerService>;
	private readonly gitService: GitService;
	private readonly config: EdgeWorkerConfig;

	constructor(deps: PromptBuilderDeps) {
		this.logger = deps.logger;
		this.repositories = deps.repositories;
		this.issueTrackers = deps.issueTrackers;
		this.gitService = deps.gitService;
		this.config = deps.config;
	}

	// ========================================================================
	// PROMPT BUILDING METHODS
	// ========================================================================

	/**
	 * Determine system prompt based on issue labels and repository configuration
	 */
	async determineSystemPromptFromLabels(
		labels: string[],
		repository: RepositoryConfig,
	): Promise<SystemPromptResult | undefined> {
		if (labels.length === 0) {
			return undefined;
		}

		// Lowercase labels for case-insensitive comparison
		const lowercaseLabels = labels.map((label) => label.toLowerCase());

		// HARDCODED RULE: Always check for 'orchestrator' label (case-insensitive)
		// regardless of whether repository.labelPrompts is configured.
		// This matches the hardcoded routing behavior from CYPACK-715.
		const hasHardcodedOrchestratorLabel =
			lowercaseLabels.includes("orchestrator");

		// If no labelPrompts configured but has hardcoded orchestrator label,
		// load orchestrator system prompt directly
		if (!repository.labelPrompts && hasHardcodedOrchestratorLabel) {
			try {
				const __filename = fileURLToPath(import.meta.url);
				const __dirname = dirname(__filename);
				const promptPath = join(__dirname, "..", "prompts", "orchestrator.md");
				const promptContent = await readFile(promptPath, "utf-8");
				this.logger.debug(
					`Using orchestrator system prompt (hardcoded rule) for labels: ${labels.join(", ")}`,
				);

				const promptVersion = this.extractVersionTag(promptContent);
				if (promptVersion) {
					this.logger.debug(
						`orchestrator system prompt version: ${promptVersion}`,
					);
				}

				return {
					prompt: promptContent,
					version: promptVersion,
					type: "orchestrator",
				};
			} catch (error) {
				this.logger.error(
					`Failed to load orchestrator prompt template:`,
					error,
				);
				return undefined;
			}
		}

		// If no labelPrompts configured and no hardcoded orchestrator, return undefined
		if (!repository.labelPrompts) {
			return undefined;
		}

		// Check for graphite-orchestrator first (requires BOTH graphite AND orchestrator labels)
		const graphiteConfig = repository.labelPrompts.graphite;
		const graphiteLabels = Array.isArray(graphiteConfig)
			? graphiteConfig
			: (graphiteConfig?.labels ?? ["graphite"]);
		const hasGraphiteLabel = graphiteLabels?.some((label: string) =>
			lowercaseLabels.includes(label.toLowerCase()),
		);

		const orchestratorConfig = repository.labelPrompts.orchestrator;
		const orchestratorLabels = Array.isArray(orchestratorConfig)
			? orchestratorConfig
			: (orchestratorConfig?.labels ?? ["orchestrator"]);
		// Use hardcoded check OR config-based check for orchestrator
		const hasOrchestratorLabel =
			hasHardcodedOrchestratorLabel ||
			orchestratorLabels?.some((label: string) =>
				lowercaseLabels.includes(label.toLowerCase()),
			);

		// If both graphite AND orchestrator labels are present, use graphite-orchestrator prompt
		if (hasGraphiteLabel && hasOrchestratorLabel) {
			try {
				const __filename = fileURLToPath(import.meta.url);
				const __dirname = dirname(__filename);
				const promptPath = join(
					__dirname,
					"..",
					"prompts",
					"graphite-orchestrator.md",
				);
				const promptContent = await readFile(promptPath, "utf-8");
				this.logger.debug(
					`Using graphite-orchestrator system prompt for labels: ${labels.join(", ")}`,
				);

				const promptVersion = this.extractVersionTag(promptContent);
				if (promptVersion) {
					this.logger.debug(
						`graphite-orchestrator system prompt version: ${promptVersion}`,
					);
				}

				return {
					prompt: promptContent,
					version: promptVersion,
					type: "graphite-orchestrator",
				};
			} catch (error) {
				this.logger.error(
					`Failed to load graphite-orchestrator prompt template:`,
					error,
				);
				// Fall through to regular orchestrator if graphite-orchestrator prompt fails
			}
		}

		// Check each prompt type for matching labels
		const promptTypes = [
			"debugger",
			"builder",
			"scoper",
			"orchestrator",
		] as const;

		for (const promptType of promptTypes) {
			const promptConfig = repository.labelPrompts[promptType];
			// Handle both old array format and new object format for backward compatibility
			const configuredLabels = Array.isArray(promptConfig)
				? promptConfig
				: promptConfig?.labels;

			// For orchestrator type, also check the hardcoded 'orchestrator' label
			// This ensures orchestrator prompt loads even without explicit labelPrompts config
			const matchesLabel =
				promptType === "orchestrator"
					? hasHardcodedOrchestratorLabel ||
						configuredLabels?.some((label: string) =>
							lowercaseLabels.includes(label.toLowerCase()),
						)
					: configuredLabels?.some((label: string) =>
							lowercaseLabels.includes(label.toLowerCase()),
						);

			if (matchesLabel) {
				try {
					// Load the prompt template from file
					const __filename = fileURLToPath(import.meta.url);
					const __dirname = dirname(__filename);
					const promptPath = join(
						__dirname,
						"..",
						"prompts",
						`${promptType}.md`,
					);
					const promptContent = await readFile(promptPath, "utf-8");
					this.logger.debug(
						`Using ${promptType} system prompt for labels: ${labels.join(", ")}`,
					);

					// Extract and log version tag if present
					const promptVersion = this.extractVersionTag(promptContent);
					if (promptVersion) {
						this.logger.debug(
							`${promptType} system prompt version: ${promptVersion}`,
						);
					}

					return {
						prompt: promptContent,
						version: promptVersion,
						type: promptType,
					};
				} catch (error) {
					this.logger.error(
						`Failed to load ${promptType} prompt template:`,
						error,
					);
					return undefined;
				}
			}
		}

		return undefined;
	}

	/**
	 * Build simplified prompt for label-based workflows
	 * @param issue Full Linear issue
	 * @param repository Repository configuration
	 * @param attachmentManifest Optional attachment manifest
	 * @param guidance Optional agent guidance rules from Linear
	 * @returns Formatted prompt string
	 */
	async buildLabelBasedPrompt(
		issue: Issue,
		repository: RepositoryConfig,
		attachmentManifest: string = "",
		guidance?: GuidanceRule[],
	): Promise<PromptResult> {
		this.logger.debug(
			`buildLabelBasedPrompt called for issue ${issue.identifier}`,
		);

		try {
			// Load the label-based prompt template
			const __filename = fileURLToPath(import.meta.url);
			const __dirname = dirname(__filename);
			const templatePath = resolve(__dirname, "../label-prompt-template.md");

			this.logger.debug(`Loading label prompt template from: ${templatePath}`);
			const template = await readFile(templatePath, "utf-8");
			this.logger.debug(
				`Template loaded, length: ${template.length} characters`,
			);

			// Extract and log version tag if present
			const templateVersion = this.extractVersionTag(template);
			if (templateVersion) {
				this.logger.debug(`Label prompt template version: ${templateVersion}`);
			}

			// Determine the base branch considering parent issues
			const baseBranch = await this.determineBaseBranch(issue, repository);

			// Fetch assignee information
			let assigneeId = "";
			let assigneeName = "";
			try {
				if (issue.assigneeId) {
					assigneeId = issue.assigneeId;
					// Fetch the full assignee object to get the name
					const assignee = await issue.assignee;
					if (assignee) {
						assigneeName = assignee.displayName || assignee.name || "";
					}
				}
			} catch (error) {
				this.logger.warn(`Failed to fetch assignee details:`, error);
			}

			// Get IssueTrackerService for this repository
			const issueTracker = this.issueTrackers.get(repository.id);
			if (!issueTracker) {
				this.logger.error(
					`No IssueTrackerService found for repository ${repository.id}`,
				);
				throw new Error(
					`No IssueTrackerService found for repository ${repository.id}`,
				);
			}

			// Fetch workspace teams and labels
			let workspaceTeams = "";
			let workspaceLabels = "";
			try {
				this.logger.debug(
					`Fetching workspace teams and labels for repository ${repository.id}`,
				);

				// Fetch teams
				const teamsConnection = await issueTracker.fetchTeams();
				const teamsArray = [];
				for (const team of teamsConnection.nodes) {
					teamsArray.push({
						id: team.id,
						name: team.name,
						key: team.key,
						description: team.description || "",
						color: team.color,
					});
				}
				workspaceTeams = teamsArray
					.map(
						(team) =>
							`- ${team.name} (${team.key}): ${team.id}${team.description ? ` - ${team.description}` : ""}`,
					)
					.join("\n");

				// Fetch labels
				const labelsConnection = await issueTracker.fetchLabels();
				const labelsArray = [];
				for (const label of labelsConnection.nodes) {
					labelsArray.push({
						id: label.id,
						name: label.name,
						description: label.description || "",
						color: label.color,
					});
				}
				workspaceLabels = labelsArray
					.map(
						(label) =>
							`- ${label.name}: ${label.id}${label.description ? ` - ${label.description}` : ""}`,
					)
					.join("\n");

				this.logger.debug(
					`Fetched ${teamsArray.length} teams and ${labelsArray.length} labels`,
				);
			} catch (error) {
				this.logger.warn(`Failed to fetch workspace teams and labels:`, error);
			}

			// Generate routing context for orchestrator mode
			const routingContext = this.generateRoutingContext(repository);

			// Build the simplified prompt with only essential variables
			let prompt = template
				.replace(/{{repository_name}}/g, repository.name)
				.replace(/{{base_branch}}/g, baseBranch)
				.replace(/{{issue_id}}/g, issue.id || "")
				.replace(/{{issue_identifier}}/g, issue.identifier || "")
				.replace(/{{issue_title}}/g, issue.title || "")
				.replace(
					/{{issue_description}}/g,
					issue.description || "No description provided",
				)
				.replace(/{{issue_url}}/g, issue.url || "")
				.replace(/{{assignee_id}}/g, assigneeId)
				.replace(/{{assignee_name}}/g, assigneeName)
				.replace(/{{workspace_teams}}/g, workspaceTeams)
				.replace(/{{workspace_labels}}/g, workspaceLabels)
				// Replace routing context - if empty, also remove the preceding newlines
				.replace(
					routingContext ? /{{routing_context}}/g : /\n*{{routing_context}}/g,
					routingContext,
				);

			// Append agent guidance if present
			prompt += this.formatAgentGuidance(guidance);

			if (attachmentManifest) {
				this.logger.debug(
					`Adding attachment manifest to label-based prompt, length: ${attachmentManifest.length} characters`,
				);
				prompt = `${prompt}\n\n${attachmentManifest}`;
			}

			this.logger.debug(
				`Label-based prompt built successfully, length: ${prompt.length} characters`,
			);
			return { prompt, version: templateVersion };
		} catch (error) {
			this.logger.error(`Error building label-based prompt:`, error);
			throw error;
		}
	}

	/**
	 * Generate routing context for orchestrator mode
	 *
	 * This provides the orchestrator with information about available repositories
	 * and how to route sub-issues to them. The context includes:
	 * - List of configured repositories in the workspace
	 * - Routing rules for each repository (labels, teams, projects)
	 * - Instructions on using description tags for explicit routing
	 *
	 * @param currentRepository The repository handling the current orchestrator issue
	 * @returns XML-formatted routing context string, or empty string if no routing info available
	 */
	generateRoutingContext(currentRepository: RepositoryConfig): string {
		// Get all repositories in the same workspace
		const workspaceRepos = Array.from(this.repositories.values()).filter(
			(repo) =>
				repo.linearWorkspaceId === currentRepository.linearWorkspaceId &&
				repo.isActive !== false,
		);

		// If there's only one repository, no routing context needed
		if (workspaceRepos.length <= 1) {
			return "";
		}

		const repoDescriptions = workspaceRepos.map((repo) => {
			const routingMethods: string[] = [];

			// Description tag routing (always available)
			const repoIdentifier = repo.githubUrl
				? repo.githubUrl.replace("https://github.com/", "")
				: repo.name;
			routingMethods.push(
				`    - Description tag: Add \`[repo=${repoIdentifier}]\` to sub-issue description`,
			);

			// Label-based routing
			if (repo.routingLabels && repo.routingLabels.length > 0) {
				routingMethods.push(
					`    - Routing labels: ${repo.routingLabels.map((l: string) => `"${l}"`).join(", ")}`,
				);
			}

			// Team-based routing
			if (repo.teamKeys && repo.teamKeys.length > 0) {
				routingMethods.push(
					`    - Team keys: ${repo.teamKeys.map((t: string) => `"${t}"`).join(", ")} (create issue in this team)`,
				);
			}

			// Project-based routing
			if (repo.projectKeys && repo.projectKeys.length > 0) {
				routingMethods.push(
					`    - Project keys: ${repo.projectKeys.map((p: string) => `"${p}"`).join(", ")} (add issue to this project)`,
				);
			}

			const currentMarker =
				repo.id === currentRepository.id ? " (current)" : "";

			return `  <repository name="${repo.name}"${currentMarker}>
    <github_url>${repo.githubUrl || "N/A"}</github_url>
    <routing_methods>
${routingMethods.join("\n")}
    </routing_methods>
  </repository>`;
		});

		return `<repository_routing_context>
<description>
When creating sub-issues that should be handled in a DIFFERENT repository, use one of these routing methods.

**IMPORTANT - Routing Priority Order:**
The system evaluates routing methods in this strict priority order. The FIRST match wins:

1. **Description Tag (Priority 1 - Highest, Recommended)**: Add \`[repo=org/repo-name]\` or \`[repo=repo-name]\` to the sub-issue description. This is the most explicit and reliable method.
2. **Routing Labels (Priority 2)**: Apply a label configured to route to the target repository.
3. **Project Assignment (Priority 3)**: Add the issue to a project that routes to the target repository.
4. **Team Selection (Priority 4 - Lowest)**: Create the issue in a Linear team that routes to the target repository.

For reliable cross-repository routing, prefer Description Tags as they are explicit and unambiguous.
</description>

<available_repositories>
${repoDescriptions.join("\n")}
</available_repositories>
</repository_routing_context>`;
	}

	/**
	 * Build prompt for mention-triggered sessions
	 * @param issue Full Linear issue object
	 * @param agentSession The agent session containing the mention
	 * @param attachmentManifest Optional attachment manifest to append
	 * @param guidance Optional agent guidance rules from Linear
	 * @returns The constructed prompt and optional version tag
	 */
	async buildMentionPrompt(
		issue: Issue,
		agentSession: WebhookAgentSession,
		attachmentManifest: string = "",
		guidance?: GuidanceRule[],
	): Promise<PromptResult> {
		try {
			this.logger.debug(
				`Building mention prompt for issue ${issue.identifier}`,
			);

			// Get the mention comment metadata
			const mentionContent = agentSession.comment?.body || "";
			const authorName =
				agentSession.creator?.name || agentSession.creator?.id || "Unknown";
			const timestamp = agentSession.createdAt || new Date().toISOString();

			// Build a focused prompt with comment metadata
			let prompt = `You were mentioned in a Linear comment on this issue:

<linear_issue>
  <id>${issue.id}</id>
  <identifier>${issue.identifier}</identifier>
  <title>${issue.title}</title>
  <url>${issue.url}</url>
</linear_issue>

<mention_comment>
  <author>${authorName}</author>
  <timestamp>${timestamp}</timestamp>
  <content>
${mentionContent}
  </content>
</mention_comment>

Focus on addressing the specific request in the mention. You can use the Linear MCP tools to fetch additional context if needed.`;

			// Append agent guidance if present
			prompt += this.formatAgentGuidance(guidance);

			// Append attachment manifest if any
			if (attachmentManifest) {
				prompt = `${prompt}\n\n${attachmentManifest}`;
			}

			return { prompt };
		} catch (error) {
			this.logger.error(`Error building mention prompt:`, error);
			throw error;
		}
	}

	/**
	 * Build a prompt for Claude using the improved XML-style template
	 * @param issue Full Linear issue
	 * @param repository Repository configuration
	 * @param newComment Optional new comment to focus on (for handleNewRootComment)
	 * @param attachmentManifest Optional attachment manifest
	 * @param guidance Optional agent guidance rules from Linear
	 * @returns Formatted prompt string
	 */
	async buildIssueContextPrompt(
		issue: Issue,
		repository: RepositoryConfig,
		newComment?: WebhookComment,
		attachmentManifest: string = "",
		guidance?: GuidanceRule[],
	): Promise<PromptResult> {
		this.logger.debug(
			`buildIssueContextPrompt called for issue ${issue.identifier}${newComment ? " with new comment" : ""}`,
		);

		try {
			// Use custom template if provided (repository-specific)
			let templatePath = repository.promptTemplatePath;

			// If no custom template, use the standard issue assigned user prompt template
			if (!templatePath) {
				const __filename = fileURLToPath(import.meta.url);
				const __dirname = dirname(__filename);
				templatePath = resolve(
					__dirname,
					"../prompts/standard-issue-assigned-user-prompt.md",
				);
			}

			// Load the template
			this.logger.debug(`Loading prompt template from: ${templatePath}`);
			const template = await readFile(templatePath, "utf-8");
			this.logger.debug(
				`Template loaded, length: ${template.length} characters`,
			);

			// Extract and log version tag if present
			const templateVersion = this.extractVersionTag(template);
			if (templateVersion) {
				this.logger.debug(`Prompt template version: ${templateVersion}`);
			}

			// Get state name from Linear API
			const state = await issue.state;
			const stateName = state?.name || "Unknown";

			// Determine the base branch considering parent issues
			const baseBranch = await this.determineBaseBranch(issue, repository);

			// Get formatted comment threads
			const issueTracker = this.issueTrackers.get(repository.id);
			let commentThreads = "No comments yet.";

			if (issueTracker && issue.id) {
				try {
					this.logger.debug(`Fetching comments for issue ${issue.identifier}`);
					const comments = await issueTracker.fetchComments(issue.id);

					const commentNodes = comments.nodes;
					if (commentNodes.length > 0) {
						commentThreads = await this.formatCommentThreads(commentNodes);
						this.logger.debug(
							`Formatted ${commentNodes.length} comments into threads`,
						);
					}
				} catch (error) {
					this.logger.error("Failed to fetch comments:", error);
				}
			}

			// Build the prompt with all variables
			let prompt = template
				.replace(/{{repository_name}}/g, repository.name)
				.replace(/{{issue_id}}/g, issue.id || "")
				.replace(/{{issue_identifier}}/g, issue.identifier || "")
				.replace(/{{issue_title}}/g, issue.title || "")
				.replace(
					/{{issue_description}}/g,
					issue.description || "No description provided",
				)
				.replace(/{{issue_state}}/g, stateName)
				.replace(/{{issue_priority}}/g, issue.priority?.toString() || "None")
				.replace(/{{issue_url}}/g, issue.url || "")
				.replace(/{{comment_threads}}/g, commentThreads)
				.replace(
					/{{working_directory}}/g,
					this.config.handlers?.createWorkspace
						? "Will be created based on issue"
						: repository.repositoryPath,
				)
				.replace(/{{base_branch}}/g, baseBranch)
				.replace(
					/{{branch_name}}/g,
					this.gitService.sanitizeBranchName(issue.branchName),
				);

			// Handle the optional new comment section
			if (newComment) {
				// Replace the conditional block
				const newCommentSection = `<new_comment_to_address>
	<author>{{new_comment_author}}</author>
	<timestamp>{{new_comment_timestamp}}</timestamp>
	<content>
{{new_comment_content}}
	</content>
</new_comment_to_address>

IMPORTANT: Focus specifically on addressing the new comment above. This is a new request that requires your attention.`;

				prompt = prompt.replace(
					/{{#if new_comment}}[\s\S]*?{{\/if}}/g,
					newCommentSection,
				);

				// Now replace the new comment variables
				// We'll need to fetch the comment author
				let authorName = "Unknown";
				if (issueTracker) {
					try {
						const fullComment = await issueTracker.fetchComment(newComment.id);
						const user = await fullComment.user;
						authorName =
							user?.displayName || user?.name || user?.email || "Unknown";
					} catch (error) {
						this.logger.error("Failed to fetch comment author:", error);
					}
				}

				prompt = prompt
					.replace(/{{new_comment_author}}/g, authorName)
					.replace(/{{new_comment_timestamp}}/g, new Date().toLocaleString())
					.replace(/{{new_comment_content}}/g, newComment.body || "");
			} else {
				// Remove the new comment section entirely (including preceding newlines)
				prompt = prompt.replace(/\n*{{#if new_comment}}[\s\S]*?{{\/if}}/g, "");
			}

			// Append agent guidance if present
			prompt += this.formatAgentGuidance(guidance);

			// Append attachment manifest if provided
			if (attachmentManifest) {
				this.logger.debug(
					`Adding attachment manifest, length: ${attachmentManifest.length} characters`,
				);
				prompt = `${prompt}\n\n${attachmentManifest}`;
			}

			// Append repository-specific instruction if provided
			if (repository.appendInstruction) {
				this.logger.debug(`Adding repository-specific instruction`);
				prompt = `${prompt}\n\n<repository-specific-instruction>\n${repository.appendInstruction}\n</repository-specific-instruction>`;
			}

			this.logger.debug(`Final prompt length: ${prompt.length} characters`);
			return { prompt, version: templateVersion };
		} catch (error) {
			this.logger.error("Failed to load prompt template:", error);

			// Fallback to simple prompt
			const state = await issue.state;
			const stateName = state?.name || "Unknown";

			// Determine the base branch considering parent issues
			const baseBranch = await this.determineBaseBranch(issue, repository);

			const fallbackPrompt = `Please help me with the following Linear issue:

Repository: ${repository.name}
Issue: ${issue.identifier}
Title: ${issue.title}
Description: ${issue.description || "No description provided"}
State: ${stateName}
Priority: ${issue.priority?.toString() || "None"}
Branch: ${issue.branchName}

Working directory: ${repository.repositoryPath}
Base branch: ${baseBranch}

${newComment ? `New comment to address:\n${newComment.body}\n\n` : ""}Please analyze this issue and help implement a solution.`;

			return { prompt: fallbackPrompt, version: undefined };
		}
	}

	/**
	 * Build XML-formatted prompt for issue content updates (title/description/attachments)
	 *
	 * The prompt clearly shows what fields changed by comparing old vs new values,
	 * and includes guidance for the agent to evaluate whether these changes affect
	 * its current implementation or action plan.
	 */
	buildIssueUpdatePrompt(
		issueIdentifier: string,
		issueData: {
			title: string;
			description?: string | null;
			attachments?: unknown;
		},
		updatedFrom: {
			title?: string;
			description?: string;
			attachments?: unknown;
		},
	): string {
		const timestamp = new Date().toISOString();
		const parts: string[] = [];

		parts.push(`<issue_update>`);
		parts.push(`  <identifier>${issueIdentifier}</identifier>`);
		parts.push(`  <timestamp>${timestamp}</timestamp>`);

		// Add title change if title was updated
		if ("title" in updatedFrom) {
			parts.push(`  <title_change>`);
			parts.push(`    <old_title>${updatedFrom.title ?? ""}</old_title>`);
			parts.push(`    <new_title>${issueData.title}</new_title>`);
			parts.push(`  </title_change>`);
		}

		// Add description change if description was updated
		if ("description" in updatedFrom) {
			parts.push(`  <description_change>`);
			parts.push(
				`    <old_description>${updatedFrom.description ?? ""}</old_description>`,
			);
			parts.push(
				`    <new_description>${issueData.description ?? ""}</new_description>`,
			);
			parts.push(`  </description_change>`);
		}

		// Add attachments change if attachments were updated
		if ("attachments" in updatedFrom) {
			parts.push(`  <attachments_change>`);
			parts.push(
				`    <old_attachments>${JSON.stringify(updatedFrom.attachments ?? null)}</old_attachments>`,
			);
			parts.push(
				`    <new_attachments>${JSON.stringify(issueData.attachments ?? null)}</new_attachments>`,
			);
			parts.push(`  </attachments_change>`);
		}

		parts.push(`</issue_update>`);

		// Add guidance for the agent on how to respond to this update
		parts.push(``);
		parts.push(`<guidance>`);
		parts.push(
			`  The issue has been updated while you are working on it. Please evaluate whether these changes`,
		);
		parts.push(
			`  affect your current implementation or action plan. Consider the following:`,
		);
		parts.push(
			`  - Does the updated content change the requirements or scope of your work?`,
		);
		parts.push(
			`  - Are there new details, clarifications, or attachments that should inform your approach?`,
		);
		parts.push(
			`  - Should you adjust your implementation strategy based on this update?`,
		);
		parts.push(
			`  If the changes are relevant, incorporate them into your work. If not, you may continue as planned.`,
		);
		parts.push(`</guidance>`);

		return parts.join("\n");
	}

	// ========================================================================
	// COMMENT / GUIDANCE FORMATTING
	// ========================================================================

	/**
	 * Format Linear comments into a threaded structure that mirrors the Linear UI
	 * @param comments Array of Linear comments
	 * @returns Formatted string showing comment threads
	 */
	async formatCommentThreads(comments: Comment[]): Promise<string> {
		if (comments.length === 0) {
			return "No comments yet.";
		}

		// Group comments by thread (root comments and their replies)
		const threads = new Map<string, { root: Comment; replies: Comment[] }>();
		const rootComments: Comment[] = [];

		// First pass: identify root comments and create thread structure
		for (const comment of comments) {
			const parent = await comment.parent;
			if (!parent) {
				// This is a root comment
				rootComments.push(comment);
				threads.set(comment.id, { root: comment, replies: [] });
			}
		}

		// Second pass: assign replies to their threads
		for (const comment of comments) {
			const parent = await comment.parent;
			if (parent?.id) {
				const thread = threads.get(parent.id);
				if (thread) {
					thread.replies.push(comment);
				}
			}
		}

		// Format threads in chronological order
		const formattedThreads: string[] = [];

		for (const rootComment of rootComments) {
			const thread = threads.get(rootComment.id);
			if (!thread) continue;

			// Format root comment
			const rootUser = await rootComment.user;
			const rootAuthor =
				rootUser?.displayName || rootUser?.name || rootUser?.email || "Unknown";
			const rootTime = new Date(rootComment.createdAt).toLocaleString();

			let threadText = `<comment_thread>
	<root_comment>
		<author>@${rootAuthor}</author>
		<timestamp>${rootTime}</timestamp>
		<content>
${rootComment.body}
		</content>
	</root_comment>`;

			// Format replies if any
			if (thread.replies.length > 0) {
				threadText += "\n  <replies>";
				for (const reply of thread.replies) {
					const replyUser = await reply.user;
					const replyAuthor =
						replyUser?.displayName ||
						replyUser?.name ||
						replyUser?.email ||
						"Unknown";
					const replyTime = new Date(reply.createdAt).toLocaleString();

					threadText += `
		<reply>
			<author>@${replyAuthor}</author>
			<timestamp>${replyTime}</timestamp>
			<content>
${reply.body}
			</content>
		</reply>`;
				}
				threadText += "\n  </replies>";
			}

			threadText += "\n</comment_thread>";
			formattedThreads.push(threadText);
		}

		return formattedThreads.join("\n\n");
	}

	/**
	 * Format agent guidance rules as markdown for injection into prompts
	 * @param guidance Array of guidance rules from Linear
	 * @returns Formatted markdown string with guidance, or empty string if no guidance
	 */
	formatAgentGuidance(guidance?: GuidanceRule[]): string {
		if (!guidance || guidance.length === 0) {
			return "";
		}

		let formatted =
			"\n\n<agent_guidance>\nThe following guidance has been configured for this workspace/team in Linear. Team-specific guidance takes precedence over workspace-level guidance.\n";

		for (const rule of guidance) {
			let origin = "Global";
			if (rule.origin) {
				if (rule.origin.__typename === "TeamOriginWebhookPayload") {
					origin = `Team (${rule.origin.team.displayName})`;
				} else {
					origin = "Organization";
				}
			}
			formatted += `\n## Guidance from ${origin}\n${rule.body}\n`;
		}

		formatted += "\n</agent_guidance>";
		return formatted;
	}

	/**
	 * Extract version tag from template content
	 * @param templateContent The template content to parse
	 * @returns The version value if found, undefined otherwise
	 */
	extractVersionTag(templateContent: string): string | undefined {
		// Match the version tag pattern: <version-tag value="..." />
		const versionTagMatch = templateContent.match(
			/<version-tag\s+value="([^"]*)"\s*\/>/i,
		);
		const version = versionTagMatch ? versionTagMatch[1] : undefined;
		// Return undefined for empty strings
		return version?.trim() ? version : undefined;
	}

	// ========================================================================
	// SUBROUTINE / SHARED INSTRUCTION LOADING
	// ========================================================================

	/**
	 * Load a subroutine prompt file
	 * Extracted helper to make prompt assembly more readable
	 */
	async loadSubroutinePrompt(
		subroutine: SubroutineDefinition,
		workspaceSlug?: string,
	): Promise<string | null> {
		// Skip loading for "primary" - it's a placeholder that doesn't have a file
		if (subroutine.promptPath === "primary") {
			return null;
		}

		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const subroutinePromptPath = join(
			__dirname,
			"prompts",
			subroutine.promptPath,
		);

		try {
			let prompt = await readFile(subroutinePromptPath, "utf-8");
			this.logger.debug(
				`Loaded ${subroutine.name} subroutine prompt (${prompt.length} characters)`,
			);

			// Perform template substitution if workspace slug is provided
			if (workspaceSlug) {
				prompt = prompt.replace(
					/https:\/\/linear\.app\/linear\/profiles\//g,
					`https://linear.app/${workspaceSlug}/profiles/`,
				);
			}

			return prompt;
		} catch (error) {
			this.logger.warn(
				`Failed to load subroutine prompt from ${subroutinePromptPath}:`,
				error,
			);
			return null;
		}
	}

	/**
	 * Load shared instructions that get appended to all system prompts
	 */
	async loadSharedInstructions(): Promise<string> {
		const __filename = fileURLToPath(import.meta.url);
		const __dirname = dirname(__filename);
		const instructionsPath = join(
			__dirname,
			"..",
			"prompts",
			"todolist-system-prompt-extension.md",
		);

		try {
			const instructions = await readFile(instructionsPath, "utf-8");
			return instructions;
		} catch (error) {
			this.logger.error(
				`Failed to load shared instructions from ${instructionsPath}:`,
				error,
			);
			return ""; // Return empty string if file can't be loaded
		}
	}

	// ========================================================================
	// BRANCH / ISSUE UTILITIES
	// ========================================================================

	/**
	 * Determine the base branch for an issue, considering parent issues and blocked-by relationships
	 *
	 * Priority order:
	 * 1. If issue has graphite label AND has a "blocked by" relationship, use the blocking issue's branch
	 *    (This enables Graphite stacking where each sub-issue branches off the previous)
	 * 2. If issue has a parent, use the parent's branch
	 * 3. Fall back to repository's default base branch
	 */
	async determineBaseBranch(
		issue: Issue,
		repository: RepositoryConfig,
	): Promise<string> {
		// Start with the repository's default base branch
		let baseBranch = repository.baseBranch;

		// Check if this issue has the graphite label - if so, blocked-by relationship takes priority
		const isGraphiteIssue = await this.hasGraphiteLabel(issue, repository);

		if (isGraphiteIssue) {
			// For Graphite stacking: use the blocking issue's branch as base
			const blockingIssues = await this.fetchBlockingIssues(issue);

			if (blockingIssues.length > 0) {
				// Use the first blocking issue's branch (typically there's only one in a stack)
				const blockingIssue = blockingIssues[0]!;
				this.logger.debug(
					`Issue ${issue.identifier} has graphite label and is blocked by ${blockingIssue.identifier}`,
				);

				// Get blocking issue's branch name
				const blockingRawBranchName =
					blockingIssue.branchName ||
					`${blockingIssue.identifier}-${(blockingIssue.title ?? "")
						.toLowerCase()
						.replace(/\s+/g, "-")
						.substring(0, 30)}`;
				const blockingBranchName = this.gitService.sanitizeBranchName(
					blockingRawBranchName,
				);

				// Check if blocking issue's branch exists
				const blockingBranchExists = await this.gitService.branchExists(
					blockingBranchName,
					repository.repositoryPath,
				);

				if (blockingBranchExists) {
					baseBranch = blockingBranchName;
					this.logger.debug(
						`Using blocking issue branch '${blockingBranchName}' as base for Graphite-stacked issue ${issue.identifier}`,
					);
					return baseBranch;
				}
				this.logger.debug(
					`Blocking issue branch '${blockingBranchName}' not found, falling back to parent/default`,
				);
			}
		}

		// Check if issue has a parent (standard sub-issue behavior)
		try {
			const parent = await issue.parent;
			if (parent) {
				this.logger.debug(
					`Issue ${issue.identifier} has parent: ${parent.identifier}`,
				);

				// Get parent's branch name
				const parentRawBranchName =
					parent.branchName ||
					`${parent.identifier}-${parent.title
						?.toLowerCase()
						.replace(/\s+/g, "-")
						.substring(0, 30)}`;
				const parentBranchName =
					this.gitService.sanitizeBranchName(parentRawBranchName);

				// Check if parent branch exists
				const parentBranchExists = await this.gitService.branchExists(
					parentBranchName,
					repository.repositoryPath,
				);

				if (parentBranchExists) {
					baseBranch = parentBranchName;
					this.logger.debug(
						`Using parent issue branch '${parentBranchName}' as base for sub-issue ${issue.identifier}`,
					);
				} else {
					this.logger.debug(
						`Parent branch '${parentBranchName}' not found, using default base branch '${repository.baseBranch}'`,
					);
				}
			}
		} catch (_error) {
			// Parent field might not exist or couldn't be fetched, use default base branch
			this.logger.debug(
				`No parent issue found for ${issue.identifier}, using default base branch '${repository.baseBranch}'`,
			);
		}

		return baseBranch;
	}

	/**
	 * Check if an issue has the graphite label
	 *
	 * @param issue The issue to check
	 * @param repository The repository configuration
	 * @returns True if the issue has the graphite label
	 */
	async hasGraphiteLabel(
		issue: Issue,
		repository: RepositoryConfig,
	): Promise<boolean> {
		const graphiteConfig = repository.labelPrompts?.graphite;
		const graphiteLabels = Array.isArray(graphiteConfig)
			? graphiteConfig
			: (graphiteConfig?.labels ?? ["graphite"]);

		const issueLabels = await this.fetchIssueLabels(issue);
		return graphiteLabels.some((label: string) => issueLabels.includes(label));
	}

	/**
	 * Fetch issues that block this issue (i.e., issues this one is "blocked by")
	 * Uses the inverseRelations field with type "blocks"
	 *
	 * Linear relations work like this:
	 * - When Issue A "blocks" Issue B, a relation is created with:
	 *   - issue = A (the blocker)
	 *   - relatedIssue = B (the blocked one)
	 *   - type = "blocks"
	 *
	 * So to find "who blocks Issue B", we need inverseRelations (where B is the relatedIssue)
	 * and look for type === "blocks", then get the `issue` field (the blocker).
	 *
	 * @param issue The issue to fetch blocking issues for
	 * @returns Array of issues that block this one, or empty array if none
	 */
	async fetchBlockingIssues(issue: Issue): Promise<Issue[]> {
		try {
			// inverseRelations contains relations where THIS issue is the relatedIssue
			// When type is "blocks", it means the `issue` field blocks THIS issue
			const inverseRelations = await issue.inverseRelations();
			if (!inverseRelations?.nodes) {
				return [];
			}

			const blockingIssues: Issue[] = [];

			for (const relation of inverseRelations.nodes) {
				// "blocks" type in inverseRelations means the `issue` blocks this one
				if (relation.type === "blocks") {
					// The `issue` field is the one that blocks THIS issue
					const blockingIssue = await relation.issue;
					if (blockingIssue) {
						blockingIssues.push(blockingIssue);
					}
				}
			}

			this.logger.debug(
				`Issue ${issue.identifier} is blocked by ${blockingIssues.length} issue(s): ${blockingIssues.map((i) => i.identifier).join(", ") || "none"}`,
			);

			return blockingIssues;
		} catch (error) {
			this.logger.error(
				`Failed to fetch blocking issues for ${issue.identifier}:`,
				error,
			);
			return [];
		}
	}

	/**
	 * Convert full Linear SDK issue to CoreIssue interface for Session creation
	 */
	convertLinearIssueToCore(issue: Issue): IssueMinimal {
		return {
			id: issue.id,
			identifier: issue.identifier,
			title: issue.title || "",
			description: issue.description || undefined,
			branchName: issue.branchName, // Use the real branchName property!
		};
	}

	/**
	 * Fetch issue labels for a given issue
	 */
	async fetchIssueLabels(issue: Issue): Promise<string[]> {
		try {
			const labels = await issue.labels();
			return labels.nodes.map((label) => label.name);
		} catch (error) {
			this.logger.error(`Failed to fetch labels for issue ${issue.id}:`, error);
			return [];
		}
	}
}
