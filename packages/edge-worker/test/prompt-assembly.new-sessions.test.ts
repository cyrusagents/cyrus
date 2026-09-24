/**
 * Prompt Assembly Tests - New Sessions
 *
 * Tests prompt assembly for new (initial) sessions with full issue context.
 */

import { describe, it } from "vitest";
import {
	createTestWorker,
	EXPECTED_FALLBACK_SYSTEM_PROMPT,
	scenario,
} from "./prompt-assembly-utils.js";

describe("Prompt Assembly - New Sessions", () => {
	it("assignment-based (no labels) - should have system prompt with shared instructions", async () => {
		const worker = createTestWorker();

		// Create minimal test data
		const session = {
			issueId: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
			identifier: "CEE-123",
			title: "Fix authentication bug",
			description: "Users cannot log in",
		};

		const repository = {
			id: "repo-uuid-1234-5678-90ab-cdef12345678",
			path: "/test/repo",
		};

		await scenario(worker)
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
  <id>a1b2c3d4-e5f6-7890-abcd-ef1234567890</id>
  <identifier>CEE-123</identifier>
  <title>Fix authentication bug</title>
  <description>
Users cannot log in
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
			.expectSystemPrompt(EXPECTED_FALLBACK_SYSTEM_PROMPT)
			.expectPromptType("fallback")
			.expectComponents("issue-context")
			.verify();
	});

	it("assignment-based (with user comment) - should include user comment in XML wrapper", async () => {
		const worker = createTestWorker();

		// Create minimal test data
		const session = {
			issueId: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "b2c3d4e5-f6a7-8901-bcde-f12345678901",
			identifier: "CEE-456",
			title: "Implement new feature",
			description: "Add payment processing",
		};

		const repository = {
			id: "repo-uuid-2345-6789-01bc-def123456789",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Please add Stripe integration")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>b2c3d4e5-f6a7-8901-bcde-f12345678901</id>
  <identifier>CEE-456</identifier>
  <title>Implement new feature</title>
  <description>
Add payment processing
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
Please add Stripe integration
</user_comment>`)
			.expectSystemPrompt(EXPECTED_FALLBACK_SYSTEM_PROMPT)
			.expectPromptType("fallback")
			.expectComponents("issue-context", "user-comment")
			.verify();
	});
});
