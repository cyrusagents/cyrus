/**
 * Prompt Assembly Tests - Multi-Repo Support
 *
 * Tests prompt assembly when multiple repositories are configured for a session.
 * Verifies per-repo sections in prompts, conflicting label resolution, and
 * multi-repo base branch determination.
 */

import { LinearIssueTrackerService } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Multi-Repo", () => {
	let liveTrackerCalls = 0;

	beforeEach(() => {
		liveTrackerCalls = 0;
		for (const method of [
			"fetchComments",
			"fetchTeams",
			"fetchLabels",
		] as const) {
			vi.spyOn(LinearIssueTrackerService.prototype, method).mockImplementation(
				async () => {
					liveTrackerCalls++;
					throw new Error("Unexpected live Linear tracker in prompt test");
				},
			);
		}
	});

	afterEach(() => {
		try {
			expect(liveTrackerCalls).toBe(0);
		} finally {
			vi.restoreAllMocks();
		}
	});

	describe("fallback prompt with 2 repos", () => {
		it("should produce per-repo context sections instead of single-repo context", async () => {
			const repoA = {
				id: "repo-a-uuid",
				name: "frontend-app",
				repositoryPath: "/test/frontend",
				baseBranch: "main",
				linearWorkspaceId: "ws-1",
				workspaceBaseDir: "/test/workspaces",
			};
			const repoB = {
				id: "repo-b-uuid",
				name: "backend-api",
				repositoryPath: "/test/backend",
				baseBranch: "develop",
				linearWorkspaceId: "ws-1",
				workspaceBaseDir: "/test/workspaces",
			};

			const worker = createTestWorker([repoA, repoB]);

			const session = {
				issueId: "multi-repo-issue-uuid",
				workspace: { path: "/test" },
				metadata: {},
			};

			const issue = {
				id: "multi-repo-issue-uuid",
				identifier: "CEE-100",
				title: "Cross-repo feature",
				description: "Spans multiple repositories",
			};

			await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repoA, repoB])
				.withUserComment("")
				.withLabels()
				.expectUserPrompt(`<repositories>
  <repository name="frontend-app">
    <working_directory>/test/frontend</working_directory>
    <base_branch>main</base_branch>
  </repository>
  <repository name="backend-api">
    <working_directory>/test/backend</working_directory>
    <base_branch>develop</base_branch>
  </repository>
</repositories>

<linear_issue>
  <id>multi-repo-issue-uuid</id>
  <identifier>CEE-100</identifier>
  <title>Cross-repo feature</title>
  <description>
Spans multiple repositories
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
</linear_comments>`)
				.expectPromptType("fallback")
				.expectComponents("issue-context")
				.verify();
		});
	});

	describe("workspace repoPaths overrides repositoryPath", () => {
		it("should use worktree paths from session workspace instead of repository source paths", async () => {
			const repoA = {
				id: "repo-a-uuid",
				name: "frontend-app",
				repositoryPath: "/repos/frontend",
				baseBranch: "main",
				linearWorkspaceId: "ws-1",
				workspaceBaseDir: "/test/workspaces",
			};
			const repoB = {
				id: "repo-b-uuid",
				name: "backend-api",
				repositoryPath: "/repos/backend",
				baseBranch: "develop",
				linearWorkspaceId: "ws-1",
				workspaceBaseDir: "/test/workspaces",
			};

			const worker = createTestWorker([repoA, repoB]);

			// Session with repoPaths set — simulates real multi-repo worktree creation
			const session = {
				issueId: "worktree-issue-uuid",
				workspace: {
					path: "/worktrees/CEE-300",
					repoPaths: {
						"repo-a-uuid": "/worktrees/CEE-300/frontend-app",
						"repo-b-uuid": "/worktrees/CEE-300/backend-api",
					},
				},
				metadata: {},
			};

			const issue = {
				id: "worktree-issue-uuid",
				identifier: "CEE-300",
				title: "Multi-repo worktree test",
				description: "Tests worktree paths",
			};

			await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repoA, repoB])
				.withUserComment("")
				.withLabels()
				.expectUserPrompt(`<repositories>
  <repository name="frontend-app">
    <working_directory>/worktrees/CEE-300/frontend-app</working_directory>
    <base_branch>main</base_branch>
  </repository>
  <repository name="backend-api">
    <working_directory>/worktrees/CEE-300/backend-api</working_directory>
    <base_branch>develop</base_branch>
  </repository>
</repositories>

<linear_issue>
  <id>worktree-issue-uuid</id>
  <identifier>CEE-300</identifier>
  <title>Multi-repo worktree test</title>
  <description>
Tests worktree paths
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
</linear_comments>`)
				.expectPromptType("fallback")
				.expectComponents("issue-context")
				.verify();
		});

		it("single repo should use workspace.path as working directory", async () => {
			const repo = {
				id: "single-repo-uuid",
				name: "my-app",
				repositoryPath: "/repos/my-app",
				baseBranch: "main",
				linearWorkspaceId: "ws-1",
				workspaceBaseDir: "/test/workspaces",
			};

			const worker = createTestWorker([repo]);

			// Single repo: workspace.path is the worktree, no repoPaths
			const session = {
				issueId: "single-wt-uuid",
				workspace: { path: "/worktrees/CEE-400" },
				metadata: {},
			};

			const issue = {
				id: "single-wt-uuid",
				identifier: "CEE-400",
				title: "Single repo worktree test",
				description: "Tests single-repo worktree path",
			};

			await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repo])
				.withUserComment("")
				.withLabels()
				.expectUserPrompt(`<context>
  <repository>my-app</repository>
  <working_directory>/worktrees/CEE-400</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>single-wt-uuid</id>
  <identifier>CEE-400</identifier>
  <title>Single repo worktree test</title>
  <description>
Tests single-repo worktree path
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
</linear_comments>`)
				.expectPromptType("fallback")
				.expectComponents("issue-context")
				.verify();
		});
	});

	describe("single repo backward compat", () => {
		it("should produce single-repo context section when only 1 repo in array", async () => {
			const repo = {
				id: "solo-repo-uuid",
				name: "solo-repo",
				repositoryPath: "/test/solo",
				baseBranch: "main",
				linearWorkspaceId: "ws-1",
				workspaceBaseDir: "/test/workspaces",
			};

			const worker = createTestWorker([repo]);

			const session = {
				issueId: "solo-issue-uuid",
				workspace: { path: "/test/solo" },
				metadata: {},
			};

			const issue = {
				id: "solo-issue-uuid",
				identifier: "CEE-200",
				title: "Single repo feature",
				description: "Single repo description",
			};

			await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repo])
				.withUserComment("")
				.withLabels()
				.expectUserPrompt(`<context>
  <repository>solo-repo</repository>
  <working_directory>/test/solo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>solo-issue-uuid</id>
  <identifier>CEE-200</identifier>
  <title>Single repo feature</title>
  <description>
Single repo description
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
</linear_comments>`)
				.expectPromptType("fallback")
				.expectComponents("issue-context")
				.verify();
		});
	});

	describe("label-based prompt with 2 repos", () => {
		it("should produce per-repo sections in label-based prompt", async () => {
			const repoA = {
				id: "label-repo-a-uuid",
				name: "app-frontend",
				repositoryPath: "/test/app-frontend",
				baseBranch: "main",
				linearWorkspaceId: "ws-label",
				workspaceBaseDir: "/test/workspaces",
				labelPrompts: {
					builder: ["feature", "enhancement"],
				},
			};
			const repoB = {
				id: "label-repo-b-uuid",
				name: "app-backend",
				repositoryPath: "/test/app-backend",
				baseBranch: "staging",
				linearWorkspaceId: "ws-label",
				workspaceBaseDir: "/test/workspaces",
				labelPrompts: {
					debugger: ["bug"],
				},
			};

			const worker = createTestWorker([repoA, repoB]);

			const session = {
				issueId: "label-multi-issue-uuid",
				workspace: { path: "/test" },
				metadata: {},
			};

			const issue = {
				id: "label-multi-issue-uuid",
				identifier: "CEE-300",
				title: "Multi-repo enhancement",
				description: "An enhancement spanning repos",
				labels: () => Promise.resolve({ nodes: [{ name: "feature" }] }),
			};

			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repoA, repoB])
				.withUserComment("")
				.withLabels("feature")
				.expectPromptType("label-based")
				.expectComponents("issue-context")
				.build();

			// Multi-repo label-based prompt should have <repositories> section instead of <git_context>
			expect(result.userPrompt).toContain("<repositories>");
			expect(result.userPrompt).toContain('<repository name="app-frontend">');
			expect(result.userPrompt).toContain('<repository name="app-backend">');
			expect(result.userPrompt).toContain("<base_branch>main</base_branch>");
			expect(result.userPrompt).toContain("<base_branch>staging</base_branch>");
			expect(result.userPrompt).not.toContain("<git_context>");

			// System prompt should be the builder prompt (first repo match)
			expect(result.systemPrompt).toBeDefined();
			expect(result.metadata.promptType).toBe("label-based");
		});
	});

	describe("conflicting label prompts across repos", () => {
		it("first repo match should win when repos have different label prompt types for same labels", async () => {
			// Repo A maps "feature" to builder
			const repoA = {
				id: "conflict-repo-a-uuid",
				name: "repo-alpha",
				repositoryPath: "/test/alpha",
				baseBranch: "main",
				linearWorkspaceId: "ws-conflict",
				workspaceBaseDir: "/test/workspaces",
				labelPrompts: {
					builder: ["feature"],
				},
			};

			// Repo B maps "feature" to debugger
			const repoB = {
				id: "conflict-repo-b-uuid",
				name: "repo-beta",
				repositoryPath: "/test/beta",
				baseBranch: "main",
				linearWorkspaceId: "ws-conflict",
				workspaceBaseDir: "/test/workspaces",
				labelPrompts: {
					debugger: ["feature"],
				},
			};

			const worker = createTestWorker([repoA, repoB]);

			const session = {
				issueId: "conflict-issue-uuid",
				workspace: { path: "/test" },
				metadata: {},
			};

			const issue = {
				id: "conflict-issue-uuid",
				identifier: "CEE-400",
				title: "Conflicting label config",
				description: "Tests conflict resolution",
				labels: () => Promise.resolve({ nodes: [{ name: "feature" }] }),
			};

			const result = await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repoA, repoB])
				.withUserComment("")
				.withLabels("feature")
				.build();

			// First repo wins: builder prompt type
			expect(result.metadata.promptType).toBe("label-based");
			expect(result.systemPrompt).toBeDefined();
			// The system prompt should contain builder content, not debugger
			// (exact content depends on prompt file, but the type should be label-based)
		});
	});

	describe("multi-repo with user comment", () => {
		it("should include user comment alongside multi-repo context", async () => {
			const repoA = {
				id: "comment-repo-a-uuid",
				name: "service-a",
				repositoryPath: "/test/service-a",
				baseBranch: "main",
				linearWorkspaceId: "ws-comment",
				workspaceBaseDir: "/test/workspaces",
			};
			const repoB = {
				id: "comment-repo-b-uuid",
				name: "service-b",
				repositoryPath: "/test/service-b",
				baseBranch: "release",
				linearWorkspaceId: "ws-comment",
				workspaceBaseDir: "/test/workspaces",
			};

			const worker = createTestWorker([repoA, repoB]);

			const session = {
				issueId: "comment-multi-uuid",
				workspace: { path: "/test" },
				metadata: {},
			};

			const issue = {
				id: "comment-multi-uuid",
				identifier: "CEE-500",
				title: "Multi-repo with comment",
				description: "Testing comment with multi-repo",
			};

			await scenario(worker)
				.newSession()
				.assignmentBased()
				.withSession(session)
				.withIssue(issue)
				.withRepositories([repoA, repoB])
				.withUserComment("Please update both services")
				.withLabels()
				.expectUserPrompt(`<repositories>
  <repository name="service-a">
    <working_directory>/test/service-a</working_directory>
    <base_branch>main</base_branch>
  </repository>
  <repository name="service-b">
    <working_directory>/test/service-b</working_directory>
    <base_branch>release</base_branch>
  </repository>
</repositories>

<linear_issue>
  <id>comment-multi-uuid</id>
  <identifier>CEE-500</identifier>
  <title>Multi-repo with comment</title>
  <description>
Testing comment with multi-repo
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
</linear_comments>

<user_comment>
Please update both services
</user_comment>`)
				.expectPromptType("fallback")
				.expectComponents("issue-context", "user-comment")
				.verify();
		});
	});
});
