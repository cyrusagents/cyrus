/**
 * Prompt Assembly Tests - New Comment Metadata
 *
 * Tests that new comment metadata (author, timestamp) is properly included
 * when a new session is triggered by an agent session with a comment.
 *
 * This tests the {{new_comment_author}}, {{new_comment_timestamp}}, and
 * {{new_comment_content}} template variables in standard-issue-assigned-user-prompt.md
 */

import { describe, it } from "vitest";
import { createTestWorker, scenario } from "./prompt-assembly-utils.js";

describe("Prompt Assembly - New Comment Metadata in Agent Sessions", () => {
	it("should include comment metadata in mention-triggered new sessions", async () => {
		const worker = createTestWorker();

		// Create test data for an agent session with comment metadata
		const session = {
			issueId: "test-issue-123",
			workspace: { path: "/test" },
			metadata: {},
		};

		const issue = {
			id: "test-issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description: "Test description",
		};

		const repository = {
			id: "repo-123",
			path: "/test/repo",
		};

		const agentSession = {
			id: "agent-session-123",
			createdAt: "2025-01-27T14:30:00Z",
			updatedAt: "2025-01-27T14:30:00Z",
			archivedAt: null,
			creatorId: "user-123",
			appUserId: "app-user-123",
			commentId: "comment-123",
			issueId: "test-issue-123",
			status: "active" as const,
			startedAt: "2025-01-27T14:30:00Z",
			endedAt: null,
			type: "commentThread" as const,
			summary: null,
			sourceMetadata: null,
			organizationId: "org-123",
			creator: {
				id: "user-123",
				name: "Alice Smith",
			},
			comment: {
				id: "comment-123",
				body: "Please help with this issue",
				userId: "user-123",
				issueId: "test-issue-123",
			},
			issue: {
				id: "test-issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
			},
		};

		await scenario(worker)
			.newSession()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("Please help with this issue")
			.withCommentAuthor("Alice Smith")
			.withCommentTimestamp("2025-01-27T14:30:00Z")
			.withAgentSession(agentSession)
			.withMentionTriggered(true)
			.withLabels()
			.expectUserPrompt(
				`You were mentioned in a Linear comment on this issue:

<linear_issue>
  <id>test-issue-123</id>
  <identifier>TEST-123</identifier>
  <title>Test Issue</title>
  <url>undefined</url>
</linear_issue>

<mention_comment>
  <author>Alice Smith</author>
  <timestamp>2025-01-27T14:30:00Z</timestamp>
  <content>
Please help with this issue
  </content>
</mention_comment>

Focus on addressing the specific request in the mention. You can use the Linear MCP tools to fetch additional context if needed.`,
			)
			.expectSystemPrompt(undefined)
			.expectPromptType("mention")
			.expectComponents("issue-context")
			.verify();
	});

	it("should include author and timestamp metadata when building issue context with new comment", async () => {
		const worker = createTestWorker();

		// This test verifies the template variables are properly populated
		// when buildIssueContextPrompt is called with a newComment parameter

		const session = {
			issueId: "test-issue-456",
			workspace: { path: "/test" },
			metadata: {},
		};

		const issue = {
			id: "test-issue-456",
			identifier: "TEST-456",
			title: "Another Test Issue",
			description: "Another test description",
		};

		const repository = {
			id: "repo-456",
			path: "/test/repo",
		};

		await scenario(worker)
			.newSession()
			.assignmentBased()
			.withSession(session)
			.withIssue(issue)
			.withRepository(repository)
			.withUserComment("This is a new comment on the issue")
			.withCommentAuthor("Bob Jones")
			.withCommentTimestamp("2025-01-27T15:45:00Z")
			.withLabels()
			.expectUserPrompt(`<context>
  <repository>undefined</repository>
  <working_directory>/test/repo</working_directory>
  <base_branch>main</base_branch>
</context>

<linear_issue>
  <id>test-issue-456</id>
  <identifier>TEST-456</identifier>
  <title>Another Test Issue</title>
  <description>
Another test description
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
  <author>Bob Jones</author>
  <timestamp>2025-01-27T15:45:00Z</timestamp>
  <content>
This is a new comment on the issue
  </content>
</user_comment>`)
			.expectSystemPrompt(`<task_management_instructions>
CRITICAL: You MUST use the TodoWrite and TodoRead tools extensively:
- IMMEDIATELY create a comprehensive task list at the beginning of your work
- Break down complex tasks into smaller, actionable items
- Mark tasks as 'in_progress' when you start them
- Mark tasks as 'completed' immediately after finishing them
- Only have ONE task 'in_progress' at a time
- Add new tasks as you discover them during your work
- Your first response should focus on creating a thorough task breakdown

Remember: Your first message is internal planning. Use this time to:
1. Thoroughly analyze the issue and requirements
2. Create detailed todos using TodoWrite
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
  <github_bot_username>cyrusagent</github_bot_username>
  <gitlab_bot_username>cyrusagent</gitlab_bot_username>
</agent_context>`)
			.expectPromptType("fallback")
			.expectComponents("issue-context", "user-comment")
			.verify();
	});

	it("should handle new comment metadata for continuation sessions", async () => {
		const worker = createTestWorker();

		// Continuation sessions should wrap comments in XML with metadata
		await scenario(worker)
			.continuationSession()
			.withUserComment("Follow-up comment")
			.withCommentAuthor("Charlie Brown")
			.withCommentTimestamp("2025-01-27T16:00:00Z")
			.expectUserPrompt(
				`<new_comment>
  <author>Charlie Brown</author>
  <timestamp>2025-01-27T16:00:00Z</timestamp>
  <content>
Follow-up comment
  </content>
</new_comment>`,
			)
			.expectSystemPrompt(undefined)
			.expectPromptType("continuation")
			.expectComponents("user-comment")
			.verify();
	});
});
