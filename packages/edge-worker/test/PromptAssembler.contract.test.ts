/**
 * PromptAssembler contract tests.
 *
 * Constructs a PromptAssembler DIRECTLY (no EdgeWorker, no scenario DSL) with a
 * mocked IIssueTrackerService, proving the extracted seam produces the full
 * PromptAssemblyResult contract for the streaming, continuation, and
 * new-session/fallback paths.
 */

import {
	createLogger,
	type IIssueTrackerService,
	type Issue,
	LogLevel,
	type RepositoryConfig,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitHubUsernameResolver } from "../src/GitHubUsernameResolver.js";
import type { GitService } from "../src/GitService.js";
import { PromptBuilder } from "../src/PromptBuilder.js";
import { PromptAssembler } from "../src/prompt-assembly/PromptAssembler.js";
import type { PromptAssemblyInput } from "../src/prompt-assembly/types.js";
import {
	type SkillSessionContext,
	SkillsPluginResolver,
} from "../src/SkillsPluginResolver.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

const logger = createLogger({
	component: "prompt-assembler-contract-test",
	level: LogLevel.SILENT,
});

function buildAssembler(
	repositories: RepositoryConfig[] = [],
): PromptAssembler {
	const repositoriesMap = new Map<string, RepositoryConfig>();
	const issueTrackers = new Map<string, IIssueTrackerService>();
	const mockIssueTracker = {
		fetchComments: async () => ({ nodes: [] }),
		fetchComment: async () => ({ user: Promise.resolve(null), body: "" }),
		fetchTeams: async () => ({ nodes: [] }),
		fetchLabels: async () => ({ nodes: [] }),
	} as unknown as IIssueTrackerService;
	for (const repo of repositories) {
		repositoriesMap.set(repo.id, repo);
		issueTrackers.set(repo.linearWorkspaceId ?? repo.id, mockIssueTracker);
	}

	const gitService = {
		sanitizeBranchName: (name?: string) => name ?? "",
		branchExists: async () => false,
		determineBaseBranch: async (_issue: Issue, repo: RepositoryConfig) => ({
			branch: repo.baseBranch,
			source: "default" as const,
		}),
	} as unknown as GitService;

	const gitHubUsernameResolver = {
		resolve: async () => undefined,
	} as unknown as GitHubUsernameResolver;

	const promptBuilder = new PromptBuilder({
		logger,
		repositories: repositoriesMap,
		issueTrackers,
		gitService,
		gitHubUsernameResolver,
	});

	const skillsPluginResolver = new SkillsPluginResolver(
		TEST_CYRUS_HOME,
		logger,
	);

	return new PromptAssembler({
		logger,
		promptBuilder,
		skillsPluginResolver,
		buildSkillSessionContext: (repository): SkillSessionContext => ({
			repositoryId: repository.id,
			repoPaths: [],
		}),
	});
}

const EXPECTED_FALLBACK_SYSTEM_PROMPT = `<work_management>
Use TaskCreate and TaskUpdate only when substantial multi-step work benefits from
a visible checklist. Skip task bookkeeping for simple requests.

Use Agent for bounded, independent reconnaissance that would otherwise load many
files into the main conversation. Keep edits and integration decisions in the
main session.
</work_management>


## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.`;

describe("PromptAssembler contract", () => {
	let savedBot: string | undefined;

	beforeEach(() => {
		savedBot = process.env.GITHUB_BOT_USERNAME;
		delete process.env.GITHUB_BOT_USERNAME;
	});

	afterEach(() => {
		if (savedBot === undefined) {
			delete process.env.GITHUB_BOT_USERNAME;
		} else {
			process.env.GITHUB_BOT_USERNAME = savedBot;
		}
	});

	it("streaming: passes the user comment through verbatim", async () => {
		const assembler = buildAssembler();
		const input = {
			isStreaming: true,
			isNewSession: false,
			userComment: "just this",
		} as unknown as PromptAssemblyInput;

		const result = await assembler.assemble(input);

		expect(result).toEqual({
			systemPrompt: undefined,
			userPrompt: "just this",
			metadata: {
				components: ["user-comment"],
				promptType: "continuation",
				isNewSession: false,
				isStreaming: true,
			},
		});
	});

	it("continuation: wraps the comment in <new_comment> with author/timestamp", async () => {
		const assembler = buildAssembler();
		const input = {
			isStreaming: false,
			isNewSession: false,
			userComment: "follow up",
			commentAuthor: "Alice",
			commentTimestamp: "2025-01-27T12:00:00Z",
		} as unknown as PromptAssemblyInput;

		const result = await assembler.assemble(input);

		expect(result).toEqual({
			systemPrompt: undefined,
			userPrompt: `<new_comment>
  <author>Alice</author>
  <timestamp>2025-01-27T12:00:00Z</timestamp>
  <content>
follow up
  </content>
</new_comment>`,
			metadata: {
				components: ["user-comment"],
				promptType: "continuation",
				isNewSession: false,
				isStreaming: false,
			},
		});
	});

	it("new session (fallback): builds full issue context + shared/skills system prompt", async () => {
		const repository = {
			id: "contract-repo-id",
			name: "contract-repo",
			repositoryPath: "/contract/repo",
			baseBranch: "main",
			labelPrompts: {},
			linearWorkspaceId: "ws-contract",
		} as unknown as RepositoryConfig;

		const assembler = buildAssembler([repository]);

		const session = {
			issueId: "issue-1",
			workspace: { path: "/ws/path" },
			metadata: {},
		};
		const issue = {
			id: "issue-1",
			identifier: "CON-1",
			title: "Contract test",
			description: "Body",
		};

		const input = {
			session,
			fullIssue: issue,
			repositories: [repository],
			repository,
			userComment: "",
			isNewSession: true,
			isStreaming: false,
			isMentionTriggered: false,
			isLabelBasedPromptRequested: false,
			labels: [],
		} as unknown as PromptAssemblyInput;

		const result = await assembler.assemble(input);

		expect(result.userPrompt).toBe(`<context>
  <repository>contract-repo</repository>
  <working_directory>/ws/path</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>issue-1</id>
  <identifier>CON-1</identifier>
  <title>Contract test</title>
  <description>
Body
  </description>
  <state>Unknown</state>
  <priority>None</priority>
  <url></url>
  <assignee>
    <linear_display_name></linear_display_name>
    <linear_profile_url></linear_profile_url>
    <github_username></github_username>
    <github_user_id></github_user_id>
    <github_noreply_email></github_noreply_email>
  </assignee>
</linear_issue>

<linear_comments>
No comments yet.
</linear_comments>`);
		expect(result.systemPrompt).toBe(EXPECTED_FALLBACK_SYSTEM_PROMPT);
		expect(result.metadata).toEqual({
			components: ["issue-context"],
			promptType: "fallback",
			isNewSession: true,
			isStreaming: false,
		});
	});

	it("buildGitHubSystemPrompt: renders the PR comment session prompt byte-identically", () => {
		const assembler = buildAssembler();

		const result = assembler.buildGitHubSystemPrompt({
			repoFullName: "acme/widgets",
			prNumber: 42,
			prTitle: "Add widget support",
			commentAuthor: "octocat",
			commentUrl: "https://github.com/acme/widgets/pull/42#issuecomment-1",
			branchRef: "feature/widgets",
			taskInstructions: "Please fix the failing test.",
		});

		expect(result).toBe(`You are working on a GitHub Pull Request.

## Context
- **Repository**: acme/widgets
- **PR**: #42 - Add widget support
- **Branch**: feature/widgets
- **Requested by**: @octocat
- **Comment URL**: https://github.com/acme/widgets/pull/42#issuecomment-1

## Task
Please fix the failing test.

## Instructions
- You are already checked out on the PR branch \`feature/widgets\`
- Make changes directly to the code on this branch
- After making changes, commit and push them to the branch
- Be concise in your responses as they will be posted back to the GitHub PR`);
	});

	it("buildGitHubSystemPrompt: falls back to 'Untitled' when prTitle is null", () => {
		const assembler = buildAssembler();

		const result = assembler.buildGitHubSystemPrompt({
			repoFullName: "acme/widgets",
			prNumber: null,
			prTitle: null,
			commentAuthor: "octocat",
			commentUrl: "https://github.com/acme/widgets/pull/1#issuecomment-2",
			branchRef: "feature/widgets",
			taskInstructions: "Do the thing.",
		});

		expect(result).toContain("- **PR**: #null - Untitled");
	});

	it("buildGitHubChangeRequestSystemPrompt: renders the reviewer-feedback variant byte-identically", () => {
		const assembler = buildAssembler();

		const result = assembler.buildGitHubChangeRequestSystemPrompt({
			repoFullName: "acme/widgets",
			prNumber: 42,
			prTitle: "Add widget support",
			commentAuthor: "reviewer1",
			commentUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-1",
			branchRef: "feature/widgets",
			reviewBody: "Please rename this variable.",
		});

		expect(
			result,
		).toBe(`You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: acme/widgets
- **PR**: #42 - Add widget support
- **Branch**: feature/widgets
- **Reviewer**: @reviewer1
- **Review URL**: https://github.com/acme/widgets/pull/42#pullrequestreview-1

## Reviewer Feedback
Please rename this variable.

## Instructions
- Read the PR diff and the reviewer's feedback above to understand all requested changes
- You are already checked out on the PR branch \`feature/widgets\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`);
	});

	it("buildGitHubChangeRequestSystemPrompt: renders the gh-api hint variant when reviewBody is empty", () => {
		const assembler = buildAssembler();

		const result = assembler.buildGitHubChangeRequestSystemPrompt({
			repoFullName: "acme/widgets",
			prNumber: 42,
			prTitle: "Add widget support",
			commentAuthor: "reviewer1",
			commentUrl: "https://github.com/acme/widgets/pull/42#pullrequestreview-2",
			branchRef: "feature/widgets",
			reviewBody: "   ",
		});

		expect(
			result,
		).toBe(`You are working on a GitHub Pull Request that has received a change request review.

## Context
- **Repository**: acme/widgets
- **PR**: #42 - Add widget support
- **Branch**: feature/widgets
- **Reviewer**: @reviewer1
- **Review URL**: https://github.com/acme/widgets/pull/42#pullrequestreview-2

## Instructions
- The reviewer has requested changes but did not leave a summary comment
- Use \`gh api repos/acme/widgets/pulls/42/reviews\` to read the review comments and understand what changes are needed
- You are already checked out on the PR branch \`feature/widgets\`
- Address all the reviewer's feedback and make the necessary changes
- After making changes, commit and push them to the branch
- Respond with a concise summary of the changes you made`);
	});
});
