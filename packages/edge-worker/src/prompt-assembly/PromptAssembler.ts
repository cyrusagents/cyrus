import type {
	BaseBranchResolution,
	CyrusAgentSession,
	GuidanceRule,
	ILogger,
	Issue,
	RepositoryConfig,
	WebhookAgentSession,
} from "cyrus-core";
import type { PromptBuilder } from "../PromptBuilder.js";
import type {
	SkillSessionContext,
	SkillsPluginResolver,
} from "../SkillsPluginResolver.js";
import type {
	GitHubChangeRequestSystemPromptInput,
	GitHubSystemPromptInput,
	IssueContextResult,
	PromptAssemblyInput,
	PromptAssemblyResult,
	PromptComponent,
	PromptType,
} from "./types.js";

/**
 * Dependencies required by the PromptAssembler.
 *
 * All Linear-touching component building is delegated to the injected
 * PromptBuilder (prompt text stays Linear-aware). Skill-scope infrastructure is
 * injected as `buildSkillSessionContext` so PromptAssembler need not own it —
 * EdgeWorker keeps that method (it is used by several other call sites).
 */
export interface PromptAssemblerDeps {
	logger: ILogger;
	promptBuilder: PromptBuilder;
	skillsPluginResolver: SkillsPluginResolver;
	buildSkillSessionContext: (
		repository: RepositoryConfig,
		fullIssue?: Issue,
		session?: CyrusAgentSession,
	) => SkillSessionContext;
}

/**
 * The one owner of "the prompt".
 *
 * Folds in EdgeWorker's former private assemblePrompt / buildStreamingPrompt /
 * buildNewSessionPrompt / buildContinuationPrompt / determinePromptType /
 * buildIssueContextForPromptAssembly / buildAgentContextBlock helpers. Its
 * public `assemble()` surface IS the tested PromptAssemblyResult contract.
 */
export class PromptAssembler {
	private readonly promptBuilder: PromptBuilder;
	private readonly skillsPluginResolver: SkillsPluginResolver;
	private readonly buildSkillSessionContext: (
		repository: RepositoryConfig,
		fullIssue?: Issue,
		session?: CyrusAgentSession,
	) => SkillSessionContext;

	constructor(deps: PromptAssemblerDeps) {
		this.promptBuilder = deps.promptBuilder;
		this.skillsPluginResolver = deps.skillsPluginResolver;
		this.buildSkillSessionContext = deps.buildSkillSessionContext;
	}

	/**
	 * Assemble a complete prompt - unified entry point for all prompt building.
	 * This method contains all prompt assembly logic in one place.
	 */
	async assemble(input: PromptAssemblyInput): Promise<PromptAssemblyResult> {
		// If actively streaming, just pass through the comment
		if (input.isStreaming) {
			return this.buildStreamingPrompt(input);
		}

		// If new session, build full prompt with all components
		if (input.isNewSession) {
			return this.buildNewSessionPrompt(input);
		}

		// Existing session continuation - just user comment + attachments
		return this.buildContinuationPrompt(input);
	}

	/**
	 * Build prompt for actively streaming session - pass through user comment as-is
	 */
	private buildStreamingPrompt(
		input: PromptAssemblyInput,
	): PromptAssemblyResult {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		const parts: string[] = [input.userComment];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: true,
			},
		};
	}

	/**
	 * Build prompt for new session - includes issue context and user comment
	 */
	private async buildNewSessionPrompt(
		input: PromptAssemblyInput,
	): Promise<PromptAssemblyResult> {
		const components: PromptComponent[] = [];
		const parts: string[] = [];

		// 1. Determine system prompt from labels
		// Only for delegation (not mentions) or when /label-based-prompt is requested
		const repositories = input.repositories ?? [input.repository];
		let labelBasedSystemPrompt: string | undefined;
		if (!input.isMentionTriggered || input.isLabelBasedPromptRequested) {
			const result = await this.promptBuilder.determineSystemPromptFromLabels(
				input.labels || [],
				repositories,
			);
			labelBasedSystemPrompt = result?.prompt;
		}

		// 2. Determine system prompt based on prompt type
		// Label-based: Use only the label-based system prompt
		// Fallback: Use scenarios system prompt (shared instructions)
		let systemPrompt: string;
		if (labelBasedSystemPrompt) {
			// Use label-based system prompt as-is (no shared instructions)
			systemPrompt = labelBasedSystemPrompt;
		} else {
			// Use scenarios system prompt for fallback cases
			const sharedInstructions =
				await this.promptBuilder.loadSharedInstructions();
			systemPrompt = sharedInstructions;
		}

		// 3. Append skills guidance — instruct the agent to use skills based on context.
		// Skills hidden by per-skill scope (repo / Linear team / Linear label) are
		// omitted from the guidance so the model doesn't reference skills it
		// cannot invoke.
		const skillsContext = this.buildSkillSessionContext(
			repositories[0]!,
			input.fullIssue,
			input.session,
		);
		systemPrompt += await this.skillsPluginResolver.buildSkillsGuidance(
			undefined,
			skillsContext,
		);

		// 4. Append agent context — dynamic values for skills to reference
		systemPrompt += this.buildAgentContextBlock();

		// 5. Build issue context using appropriate builder
		// Use label-based prompt ONLY if we have a label-based system prompt
		const promptType = this.determinePromptType(
			input,
			!!labelBasedSystemPrompt,
		);
		// Build workspace repo paths map for prompt context.
		// For multi-repo sessions, workspace.repoPaths maps each repo ID to its worktree.
		// For single-repo sessions, use workspace.path as the worktree for the primary repo.
		const workspaceRepoPaths =
			input.session.workspace.repoPaths ??
			(repositories.length === 1
				? { [repositories[0]!.id]: input.session.workspace.path }
				: undefined);
		const issueContext = await this.buildIssueContextForPromptAssembly(
			input.fullIssue,
			repositories,
			promptType,
			input.attachmentManifest,
			input.guidance,
			input.agentSession,
			input.resolvedBaseBranches,
			workspaceRepoPaths,
		);

		parts.push(issueContext.prompt);
		components.push("issue-context");

		// 4. Add user comment (if present)
		// Skip for mention-triggered prompts since the comment is already in the mention block
		if (input.userComment.trim() && !input.isMentionTriggered) {
			// If we have author/timestamp metadata, include it for multi-player context
			if (input.commentAuthor || input.commentTimestamp) {
				const author = input.commentAuthor || "Unknown";
				// Use the event's own timestamp; omit the line when no source
				// timestamp exists so the prompt stays reproducible.
				const timestampLine = input.commentTimestamp
					? `\n  <timestamp>${input.commentTimestamp}</timestamp>`
					: "";
				parts.push(`<user_comment>
  <author>${author}</author>${timestampLine}
  <content>
${input.userComment}
  </content>
</user_comment>`);
			} else {
				// Legacy format without metadata
				parts.push(`<user_comment>\n${input.userComment}\n</user_comment>`);
			}
			components.push("user-comment");
		}

		// 6. Add guidance rules (if present)
		if (input.guidance && input.guidance.length > 0) {
			components.push("guidance-rules");
		}

		return {
			systemPrompt,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType,
				isNewSession: true,
				isStreaming: false,
			},
		};
	}

	/**
	 * Build an <agent_context> block with dynamic values that skills can reference.
	 *
	 * Provides bot usernames so skills (e.g. verify-and-ship) can refer to the
	 * correct bot account without hardcoding.
	 */
	private buildAgentContextBlock(): string {
		const githubBot = process.env.GITHUB_BOT_USERNAME || "";

		if (!githubBot) {
			return "";
		}

		const lines: string[] = ["\n\n<agent_context>"];
		lines.push(`  <github_bot_username>${githubBot}</github_bot_username>`);
		lines.push("</agent_context>");

		return lines.join("\n");
	}

	/**
	 * Build prompt for existing session continuation - user comment and attachments only
	 */
	private buildContinuationPrompt(
		input: PromptAssemblyInput,
	): PromptAssemblyResult {
		const components: PromptComponent[] = ["user-comment"];
		if (input.attachmentManifest) {
			components.push("attachment-manifest");
		}

		// Wrap comment in XML with author and timestamp for multi-player context.
		// Use the event's own timestamp; omit the line when no source timestamp
		// exists so the prompt stays reproducible across re-assembly.
		const author = input.commentAuthor || "Unknown";
		const timestampLine = input.commentTimestamp
			? `\n  <timestamp>${input.commentTimestamp}</timestamp>`
			: "";

		const commentXml = `<new_comment>
  <author>${author}</author>${timestampLine}
  <content>
${input.userComment}
  </content>
</new_comment>`;

		const parts: string[] = [commentXml];
		if (input.attachmentManifest) {
			parts.push(input.attachmentManifest);
		}

		return {
			systemPrompt: undefined,
			userPrompt: parts.join("\n\n"),
			metadata: {
				components,
				promptType: "continuation",
				isNewSession: false,
				isStreaming: false,
			},
		};
	}

	/**
	 * Determine the prompt type based on input flags and system prompt availability
	 */
	private determinePromptType(
		input: PromptAssemblyInput,
		hasSystemPrompt: boolean,
	): PromptType {
		if (input.isMentionTriggered && input.isLabelBasedPromptRequested) {
			return "label-based-prompt-command";
		}
		if (input.isMentionTriggered) {
			return "mention";
		}
		if (hasSystemPrompt) {
			return "label-based";
		}
		return "fallback";
	}

	/**
	 * Adapter method for prompt assembly - routes to appropriate issue context builder
	 */
	private async buildIssueContextForPromptAssembly(
		issue: Issue,
		repositories: RepositoryConfig[],
		promptType: PromptType,
		attachmentManifest?: string,
		guidance?: GuidanceRule[],
		agentSession?: WebhookAgentSession,
		resolvedBaseBranches?: Record<string, BaseBranchResolution>,
		workspaceRepoPaths?: Record<string, string>,
	): Promise<IssueContextResult> {
		// Delegate to appropriate builder based on promptType
		if (promptType === "mention") {
			if (!agentSession) {
				throw new Error(
					"agentSession is required for mention-triggered prompts",
				);
			}
			return this.promptBuilder.buildMentionPrompt(
				issue,
				agentSession,
				attachmentManifest,
				guidance,
			);
		}
		if (
			promptType === "label-based" ||
			promptType === "label-based-prompt-command"
		) {
			return this.promptBuilder.buildLabelBasedPrompt(
				issue,
				repositories,
				attachmentManifest,
				guidance,
				resolvedBaseBranches,
			);
		}
		// Fallback to standard issue context
		return this.promptBuilder.buildIssueContextPrompt(
			issue,
			repositories,
			undefined, // No new comment for initial prompt assembly
			attachmentManifest,
			guidance,
			resolvedBaseBranches,
			workspaceRepoPaths,
			agentSession?.comment?.id,
		);
	}

	/**
	 * Build a system prompt for a GitHub PR comment session.
	 */
	buildGitHubSystemPrompt(input: GitHubSystemPromptInput): string {
		const {
			repoFullName,
			prNumber,
			prTitle,
			commentAuthor,
			commentUrl,
			branchRef,
			taskInstructions,
		} = input;

		return `You are working on a GitHub Pull Request.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Requested by**: @${commentAuthor}
- **Comment URL**: ${commentUrl}

## Task
${taskInstructions}

## Instructions
- You are already checked out on the PR branch \`${branchRef}\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Be concise in your responses as they will be posted back to the GitHub PR`;
	}

	/**
	 * Build a system prompt for a GitHub PR change request review session.
	 */
	buildGitHubChangeRequestSystemPrompt(
		input: GitHubChangeRequestSystemPromptInput,
	): string {
		const {
			repoFullName,
			prNumber,
			prTitle,
			commentAuthor,
			commentUrl,
			branchRef,
			reviewBody,
		} = input;

		const hasReviewBody = reviewBody.trim().length > 0;

		const taskSection = hasReviewBody
			? `## Reviewer Feedback
${reviewBody}

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`
			: `## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`gh api repos/${repoFullName}/pulls/${prNumber}/reviews\` to read the review comments and understand what changes are needed
- You are already checked out on the PR branch \`${branchRef}\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`;

		return `You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: ${repoFullName}
- **PR**: #${prNumber} - ${prTitle || "Untitled"}
- **Branch**: ${branchRef}
- **Reviewer**: @${commentAuthor}
- **Review URL**: ${commentUrl}

${taskSection}`;
	}
}
