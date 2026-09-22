/**
 * Prompt Assembly Tests - System Prompt Behavior
 *
 * Tests system prompt loading based on label configuration.
 */

import { describe, expect, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - System Prompt Behavior", () => {
	it("should return system prompt with shared instructions when no labels configured", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "d4e5f6a7-b8c9-0123-def1-234567890123",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "d4e5f6a7-b8c9-0123-def1-234567890123",
			identifier: "CEE-1000",
			title: "Task without system prompt",
			description: "Example task",
		};

		const repository = {
			id: "repo-uuid-4567-8901-23de-f12345678901",
			path: "/test/repo",
		};

		const result = await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>d4e5f6a7-b8c9-0123-def1-234567890123</id>
  <identifier>CEE-1000</identifier>
  <title>Task without system prompt</title>
  <description>
Example task
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

		// Verify system prompt contains shared instructions (but no label-based prompt)
		expect(result.systemPrompt).toBeDefined();
		expect(result.systemPrompt).toContain("<task_management_instructions>");
		expect(result.systemPrompt).toContain(
			"CRITICAL: You MUST use the Task tools",
		);
		expect(result.systemPrompt).not.toContain("builder");
		expect(result.systemPrompt).not.toContain("debugger");
	});

	it("should return label-based system prompt without shared instructions", async () => {
		// Create repository with labelPrompts configuration
		const repository = {
			id: "repo-uuid-5678-9012-34ef-123456789012",
			repositoryPath: "/test/repo",
			workspaceBaseDir: "/test/workspace",
			linearWorkspaceId: "test-workspace",
			labelPrompts: {
				builder: ["feature", "enhancement"],
				debugger: ["bug", "hotfix"],
			},
		};

		const worker = createTestWorker([repository]);

		const session = {
			issueId: "e5f6a7b8-c9d0-1234-ef12-345678901234",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "e5f6a7b8-c9d0-1234-ef12-345678901234",
			identifier: "CEE-2000",
			title: "Feature with builder prompt",
			description: "Task that should trigger builder system prompt",
		};

		const result = await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Build the payment integration")
			.withLabels("feature")
			.expectUserPrompt(`<git_context>
<repository>undefined</repository>
<base_branch>main</base_branch>
</git_context>

<linear_issue>
<id>e5f6a7b8-c9d0-1234-ef12-345678901234</id>
<identifier>CEE-2000</identifier>
<title>Feature with builder prompt</title>
<description>Task that should trigger builder system prompt</description>
<url></url>
<assignee>
<linear_id></linear_id>
<linear_display_name></linear_display_name>
<linear_profile_url></linear_profile_url>
<github_username></github_username>
<github_user_id></github_user_id>
<github_noreply_email></github_noreply_email>
</assignee>
</linear_issue>

<workspace_context>
<teams>

</teams>
<labels>

</labels>
</workspace_context>

<user_comment>
Build the payment integration
</user_comment>`)
			.expectPromptType("label-based")
			.expectComponents("issue-context", "user-comment")
			.verify();

		// Verify system prompt contains ONLY label-based content (NO shared instructions)
		expect(result.systemPrompt).toBeDefined();
		expect(typeof result.systemPrompt).toBe("string");
		expect(result.systemPrompt?.length).toBeGreaterThan(0);

		// Check for label-based (builder) prompt content
		expect(result.systemPrompt).toContain("builder");
		expect(result.systemPrompt).toContain("Task tool");
		expect(result.systemPrompt).toContain("<builder_specific_instructions>");

		// Verify todolist-system-prompt-extension instructions are NOT included in label-based prompts
		// Check for unique content from todolist-system-prompt-extension that won't be in builder prompt
		expect(result.systemPrompt).not.toContain(
			"CRITICAL: You MUST use the Task tools tool extensively",
		);
		expect(result.systemPrompt).not.toContain("YOU ARE IN 1 OF 2 SITUATIONS");
		expect(result.systemPrompt).not.toContain("**Situation 1 - Execute**");
		expect(result.systemPrompt).not.toContain("**Situation 2 - Clarify**");
	});

	it("should load orchestrator system prompt even without labelPrompts configured (hardcoded rule)", async () => {
		// Repository WITHOUT labelPrompts configured - simulates the CYHOST-501 scenario
		// where the 'Orchestrator' label is present but no labelPrompts config exists
		const repository = {
			id: "repo-uuid-6789-0123-45ab-cdef12345678",
			repositoryPath: "/test/repo",
			workspaceBaseDir: "/test/workspace",
			linearWorkspaceId: "test-workspace",
			// Note: NO labelPrompts configured!
		};

		const worker = createTestWorker([repository]);

		const session = {
			issueId: "f6a7b8c9-d0e1-2345-f012-345678901234",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "f6a7b8c9-d0e1-2345-f012-345678901234",
			identifier: "CEE-3000",
			title: "Orchestrator task without labelPrompts config",
			description:
				"Task that should use orchestrator system prompt via hardcoded rule",
		};

		const result = await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Orchestrate this task")
			.withLabels("Orchestrator") // Hardcoded orchestrator label (case-insensitive)
			.expectUserPrompt(`<git_context>
<repository>undefined</repository>
<base_branch>main</base_branch>
</git_context>

<linear_issue>
<id>f6a7b8c9-d0e1-2345-f012-345678901234</id>
<identifier>CEE-3000</identifier>
<title>Orchestrator task without labelPrompts config</title>
<description>Task that should use orchestrator system prompt via hardcoded rule</description>
<url></url>
<assignee>
<linear_id></linear_id>
<linear_display_name></linear_display_name>
<linear_profile_url></linear_profile_url>
<github_username></github_username>
<github_user_id></github_user_id>
<github_noreply_email></github_noreply_email>
</assignee>
</linear_issue>

<workspace_context>
<teams>

</teams>
<labels>

</labels>
</workspace_context>

<user_comment>
Orchestrate this task
</user_comment>`)
			.expectPromptType("label-based")
			.expectComponents("issue-context", "user-comment")
			.verify();

		// Verify the orchestrator system prompt is loaded via hardcoded rule
		expect(result.systemPrompt).toBeDefined();
		expect(typeof result.systemPrompt).toBe("string");
		expect(result.systemPrompt?.length).toBeGreaterThan(0);

		// Check for orchestrator prompt content
		expect(result.systemPrompt).toContain("orchestrator");
		expect(result.systemPrompt).toContain("sub-issue");

		// Verify shared instructions are NOT included in label-based prompts
		expect(result.systemPrompt).not.toContain(
			"CRITICAL: You MUST use the Task tools tool extensively",
		);
	});

	it("should load orchestrator system prompt when labelPrompts exists but without orchestrator entry (hardcoded rule)", async () => {
		// Repository WITH labelPrompts configured but WITHOUT orchestrator - simulates atmiko-hosted scenario
		// where labelPrompts has builder/debugger/scoper but NOT orchestrator
		const repository = {
			id: "repo-uuid-7890-1234-56cd-ef0123456789",
			repositoryPath: "/test/repo",
			workspaceBaseDir: "/test/workspace",
			linearWorkspaceId: "test-workspace",
			labelPrompts: {
				// Has other entries but NOT orchestrator
				debugger: ["Bug"],
				builder: ["Feature"],
				scoper: ["PRD"],
			},
		};

		const worker = createTestWorker([repository]);

		const session = {
			issueId: "a7b8c9d0-e1f2-3456-0123-456789abcdef",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "a7b8c9d0-e1f2-3456-0123-456789abcdef",
			identifier: "CEE-4000",
			title: "Orchestrator task with partial labelPrompts config",
			description:
				"Task that should use orchestrator system prompt even though orchestrator is not in labelPrompts",
		};

		const result = await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Orchestrate this task")
			.withLabels("Orchestrator") // Hardcoded orchestrator label
			.expectUserPrompt(`<git_context>
<repository>undefined</repository>
<base_branch>main</base_branch>
</git_context>

<linear_issue>
<id>a7b8c9d0-e1f2-3456-0123-456789abcdef</id>
<identifier>CEE-4000</identifier>
<title>Orchestrator task with partial labelPrompts config</title>
<description>Task that should use orchestrator system prompt even though orchestrator is not in labelPrompts</description>
<url></url>
<assignee>
<linear_id></linear_id>
<linear_display_name></linear_display_name>
<linear_profile_url></linear_profile_url>
<github_username></github_username>
<github_user_id></github_user_id>
<github_noreply_email></github_noreply_email>
</assignee>
</linear_issue>

<workspace_context>
<teams>

</teams>
<labels>

</labels>
</workspace_context>

<user_comment>
Orchestrate this task
</user_comment>`)
			.expectPromptType("label-based")
			.expectComponents("issue-context", "user-comment")
			.verify();

		// Verify the orchestrator system prompt is loaded via hardcoded rule
		expect(result.systemPrompt).toBeDefined();
		expect(typeof result.systemPrompt).toBe("string");
		expect(result.systemPrompt?.length).toBeGreaterThan(0);

		// Check for orchestrator prompt content
		expect(result.systemPrompt).toContain("orchestrator");
		expect(result.systemPrompt).toContain("sub-issue");

		// Verify shared instructions are NOT included in label-based prompts
		expect(result.systemPrompt).not.toContain(
			"CRITICAL: You MUST use the Task tools tool extensively",
		);
	});
});
