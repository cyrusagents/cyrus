/**
 * Prompt Assembly Tests - Component Order
 *
 * Tests that prompt components are assembled in the correct order.
 */

import { describe, it } from "vitest";
import {
	createTestWorker,
	EXPECTED_FALLBACK_SYSTEM_PROMPT,
	scenario,
} from "./prompt-assembly-utils.js";

describe("Prompt Assembly - Component Order", () => {
	it("should assemble components in correct order: issue context, user comment", async () => {
		const worker = createTestWorker();

		const session = {
			issueId: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			workspace: { path: "/test/repo" },
			metadata: {},
		};

		const issue = {
			id: "c3d4e5f6-a7b8-9012-cdef-123456789012",
			identifier: "CEE-789",
			title: "Build new feature",
		};

		const repository = {
			id: "repo-uuid-3456-7890-12cd-ef1234567890",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Add user authentication")
			.withLabels()
			.expectPromptType("fallback")
			.expectComponents("issue-context", "user-comment")
			.expectSystemPrompt(EXPECTED_FALLBACK_SYSTEM_PROMPT)
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>c3d4e5f6-a7b8-9012-cdef-123456789012</id>
  <identifier>CEE-789</identifier>
  <title>Build new feature</title>
  <description>
No description provided
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
Add user authentication
</user_comment>`)
			.verify();
	});
});
