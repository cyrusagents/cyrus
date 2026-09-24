/**
 * Prompt Assembly Test Utilities
 *
 * Provides a human-readable DSL for testing EdgeWorker.assemblePrompt() method.
 */

import type { RepositoryConfig } from "miko-core";
import { expect } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig } from "../src/types.js";
import { TEST_MIKO_HOME } from "./test-dirs.js";

/**
 * Expected fallback system prompt for assignment-based new sessions
 * (shared task/skills instructions + always-on agent_context authorship block).
 */
export const EXPECTED_FALLBACK_SYSTEM_PROMPT = `<task_management_instructions>
CRITICAL: You MUST use the Task tools (TaskCreate, TaskUpdate, TaskGet, TaskList) extensively:
- IMMEDIATELY create a comprehensive task list at the beginning of your work using TaskCreate
- Break down complex tasks into smaller, actionable items
- Update tasks to 'in_progress' when you start them using TaskUpdate
- Update tasks to 'completed' immediately after finishing them using TaskUpdate
- Only have ONE task 'in_progress' at a time
- Add new tasks as you discover them during your work using TaskCreate
- Your first response should focus on creating a thorough task breakdown

Remember: Your first message is internal planning. Use this time to:
1. Thoroughly analyze the issue and requirements
2. Create detailed tasks using TaskCreate
3. Plan your approach systematically
</task_management_instructions>

## Skills

You have skills available via the Skill tool: \`debug\`, \`implementation\`, \`investigate\`, \`summarize\`, \`verify-and-ship\`

Choose the appropriate skill based on the context:

- **Code changes requested** (feature, bug fix, refactor): Use \`implementation\` to write code, then \`verify-and-ship\` to run checks and create a PR, then \`summarize\` to narrate results.
- **Bug report or error**: Use \`debug\` to reproduce, root-cause, and fix, then \`verify-and-ship\`, then \`summarize\`.
- **Question or research request**: Use \`investigate\` to search the codebase and provide an answer, then \`summarize\`.
- **PR review feedback** (changes requested): Use \`implementation\` to address review comments, then \`verify-and-ship\`.

Analyze the issue description, labels, and any user comments to determine which workflow fits. Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created.

<agent_context>
  <github_commit_authorship>
    Prefer the GitHub App installation token for git fetch/push and gh when available; authorship then appears as the operator-defined App bot (<slug>[bot]), not a hard-coded product bot. Fall back to local git config + gh auth when no App token can be minted. Always append the trailer Co-authored-by: mikoagent <332957360+mikoagent@users.noreply.github.com> exactly once (preserve other co-authors; do not change git user.name/email to impersonate mikoagent).
  </github_commit_authorship>
</agent_context>`;

/** Minimal tracker responses used by prompt assembly; never calls Linear. */
function createMockIssueTracker() {
	return {
		fetchComments: async () => ({ nodes: [] }),
		fetchComment: async () => null,
		fetchTeams: async () => ({ nodes: [] }),
		fetchLabels: async () => ({ nodes: [] }),
		getClient: () => ({}),
		client: {
			rawRequest: async () => ({ data: { comment: { body: "" } } }),
		},
	};
}

/**
 * Create an EdgeWorker instance for testing
 */
export function createTestWorker(
	repositories: RepositoryConfig[] = [],
	linearWorkspaceSlug?: string,
): EdgeWorker {
	// Create mock IssueTrackerServices for each repository
	const issueTrackers = new Map();
	for (const repo of repositories) {
		const mockIssueTracker = createMockIssueTracker();
		issueTrackers.set(
			repo.linearWorkspaceId ?? repo.id,
			mockIssueTracker as any,
		);
	}

	// Auto-generate linearWorkspaces from repository configs
	const linearWorkspaces: Record<
		string,
		{ linearToken: string; linearWorkspaceSlug?: string }
	> = {};
	for (const repo of repositories) {
		if (repo.linearWorkspaceId && !linearWorkspaces[repo.linearWorkspaceId]) {
			linearWorkspaces[repo.linearWorkspaceId] = {
				linearToken: "test-token",
				...(linearWorkspaceSlug ? { linearWorkspaceSlug } : {}),
			};
		}
	}

	const config: EdgeWorkerConfig = {
		mikoHome: TEST_MIKO_HOME,
		claudeDefaultModel: "sonnet",
		repositories,
		linearWorkspaces,
		mcpServers: {},
		// Store default slug so withRepository() can inherit it for dynamically added workspaces
		_testDefaultWorkspaceSlug: linearWorkspaceSlug,
	} as EdgeWorkerConfig & { _testDefaultWorkspaceSlug?: string };
	const worker = new EdgeWorker(config);
	// The constructor creates its own trackers; issueTrackers is not a config field.
	// Mutate the shared map so PromptBuilder also receives the test doubles.
	for (const [workspaceId, tracker] of issueTrackers) {
		(worker as any).issueTrackers.set(workspaceId, tracker);
	}
	return worker;
}

/**
 * Scenario builder for test cases - provides human-readable DSL
 */
export class PromptScenario {
	private worker: EdgeWorker;
	private input: any = {};
	private expectedUserPrompt?: string;
	private expectedSystemPrompt?: string;
	private expectedComponents?: string[];
	private expectedPromptType?: string;

	constructor(worker: EdgeWorker) {
		this.worker = worker;
	}

	// ===== Input Builders =====

	streamingSession() {
		this.input.isStreaming = true;
		this.input.isNewSession = false;
		return this;
	}

	continuationSession() {
		this.input.isStreaming = false;
		this.input.isNewSession = false;
		return this;
	}

	newSession() {
		this.input.isStreaming = false;
		this.input.isNewSession = true;
		return this;
	}

	assignmentBased() {
		this.input.isMentionTriggered = false;
		this.input.isLabelBasedPromptRequested = false;
		return this;
	}

	mentionTriggered() {
		this.input.isMentionTriggered = true;
		this.input.isLabelBasedPromptRequested = false;
		return this;
	}

	labelBasedPromptCommand() {
		this.input.isMentionTriggered = true;
		this.input.isLabelBasedPromptRequested = true;
		return this;
	}

	withUserComment(comment: string) {
		this.input.userComment = comment;
		return this;
	}

	withCommentAuthor(author: string) {
		this.input.commentAuthor = author;
		return this;
	}

	withCommentTimestamp(timestamp: string) {
		this.input.commentTimestamp = timestamp;
		return this;
	}

	withAttachments(manifest: string) {
		this.input.attachmentManifest = manifest;
		return this;
	}

	withLabels(...labels: string[]) {
		this.input.labels = labels;
		return this;
	}

	withSession(session: any) {
		this.input.session = session;
		return this;
	}

	withIssue(issue: any) {
		this.input.fullIssue = issue;
		return this;
	}

	withRepository(repo: any) {
		// Ensure repo has required fields for prompt assembly (baseBranch, labelPrompts, repositoryPath)
		const fullRepo = {
			baseBranch: "main",
			labelPrompts: {},
			repositoryPath: repo.repositoryPath ?? repo.path ?? "/test/repo",
			linearWorkspaceId: repo.linearWorkspaceId ?? repo.id,
			...repo,
		};
		this.input.repository = fullRepo;
		this.input.repositories = [fullRepo];
		// Also ensure the worker has an IssueTrackerService for this repository
		this.ensureIssueTracker(fullRepo);
		return this;
	}

	withRepositories(repos: any[]) {
		const fullRepos = repos.map((repo) => ({
			baseBranch: "main",
			labelPrompts: {},
			repositoryPath: repo.repositoryPath ?? repo.path ?? "/test/repo",
			...repo,
		}));
		this.input.repositories = fullRepos;
		this.input.repository = fullRepos[0];
		for (const repo of fullRepos) {
			this.ensureIssueTracker(repo);
		}
		return this;
	}

	private ensureIssueTracker(repo: any) {
		const workspaceKey = repo.linearWorkspaceId ?? repo.id;
		if (!(this.worker as any).issueTrackers.has(workspaceKey)) {
			const mockIssueTracker = createMockIssueTracker();
			(this.worker as any).issueTrackers.set(workspaceKey, mockIssueTracker);
		}
		// Ensure the worker has a linearWorkspaces entry for this workspace
		if (!(this.worker as any).config.linearWorkspaces?.[workspaceKey]) {
			if (!(this.worker as any).config.linearWorkspaces) {
				(this.worker as any).config.linearWorkspaces = {};
			}
			const defaultSlug = (this.worker as any).config._testDefaultWorkspaceSlug;
			(this.worker as any).config.linearWorkspaces[workspaceKey] = {
				linearToken: "test-token",
				...(defaultSlug ? { linearWorkspaceSlug: defaultSlug } : {}),
			};
		}
	}

	withGuidance(guidance: any[]) {
		this.input.guidance = guidance;
		return this;
	}

	withAgentSession(agentSession: any) {
		this.input.agentSession = agentSession;
		return this;
	}

	withMentionTriggered(triggered: boolean) {
		this.input.isMentionTriggered = triggered;
		return this;
	}

	// ===== Expectation Builders =====

	expectUserPrompt(prompt: string) {
		this.expectedUserPrompt = prompt;
		return this;
	}

	expectSystemPrompt(prompt: string | undefined) {
		this.expectedSystemPrompt = prompt;
		return this;
	}

	expectComponents(...components: string[]) {
		this.expectedComponents = components;
		return this;
	}

	expectPromptType(type: string) {
		this.expectedPromptType = type;
		return this;
	}

	// ===== Execution =====

	async build() {
		return await (this.worker as any).assemblePrompt(this.input);
	}

	async verify() {
		const result = await (this.worker as any).assemblePrompt(this.input);

		if (this.expectedUserPrompt !== undefined) {
			expect(result.userPrompt).toBe(this.expectedUserPrompt);
		}

		if (this.expectedSystemPrompt !== undefined) {
			expect(result.systemPrompt).toBe(this.expectedSystemPrompt);
		}

		if (this.expectedComponents) {
			expect(result.metadata.components).toEqual(this.expectedComponents);
		}

		if (this.expectedPromptType) {
			expect(result.metadata.promptType).toBe(this.expectedPromptType);
		}

		return result;
	}
}

/**
 * Start building a test scenario
 */
export function scenario(worker: EdgeWorker): PromptScenario {
	return new PromptScenario(worker);
}
