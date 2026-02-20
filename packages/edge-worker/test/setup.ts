import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKMessage } from "cyrus-claude-runner";
import { vi } from "vitest";

// Keep Claude SDK debug output inside the test workspace to avoid HOME write restrictions.
const claudeConfigDir =
	process.env.CLAUDE_CONFIG_DIR ??
	join(tmpdir(), "cyrus-edge-worker-test-claude");
process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
mkdirSync(join(claudeConfigDir, "debug"), { recursive: true });

// Mock console methods to reduce noise in tests
global.console = {
	...console,
	log: vi.fn(),
	debug: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
};

// Mock webhook event helpers - updated to match native webhook format
export const mockIssueAssignedWebhook = (issue: any = {}) => ({
	type: "AppUserNotification",
	action: "issueAssignedToYou",
	createdAt: new Date().toISOString(),
	organizationId: "test-workspace",
	oauthClientId: "test-oauth-client",
	appUserId: "test-app-user",
	notification: {
		type: "issueAssignedToYou",
		id: "notification-123",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		archivedAt: null,
		actorId: "actor-123",
		externalUserActorId: null,
		userId: "user-123",
		issueId: "issue-123",
		issue: {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			teamId: "test-workspace",
			team: { id: "test-workspace", key: "TEST", name: "Test Team" },
			url: "https://linear.app/issue/TEST-123",
			...issue,
		},
		actor: {
			id: "actor-123",
			name: "Test Actor",
			email: "test@example.com",
			url: "https://linear.app/user/actor-123",
		},
	},
	webhookTimestamp: Date.now(),
	webhookId: "webhook-123",
});

export const mockCommentWebhook = (issue: any = {}, comment: any = {}) => ({
	type: "AppUserNotification",
	action: "issueNewComment",
	createdAt: new Date().toISOString(),
	organizationId: "test-workspace",
	oauthClientId: "test-oauth-client",
	appUserId: "test-app-user",
	notification: {
		type: "issueNewComment",
		id: "notification-456",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		archivedAt: null,
		actorId: "actor-456",
		externalUserActorId: null,
		userId: "user-456",
		issueId: "issue-123",
		commentId: "comment-123",
		issue: {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			teamId: "test-workspace",
			team: { id: "test-workspace", key: "TEST", name: "Test Team" },
			url: "https://linear.app/issue/TEST-123",
			...issue,
		},
		comment: {
			id: "comment-123",
			body: "Test comment",
			userId: "user-456",
			issueId: "issue-123",
			...comment,
		},
		actor: {
			id: "actor-456",
			name: "Test Commenter",
			email: "commenter@example.com",
			url: "https://linear.app/user/actor-456",
		},
	},
	webhookTimestamp: Date.now(),
	webhookId: "webhook-456",
});

export const mockUnassignedWebhook = (issue: any = {}) => ({
	type: "AppUserNotification",
	action: "issueUnassignedFromYou",
	createdAt: new Date().toISOString(),
	organizationId: "test-workspace",
	oauthClientId: "test-oauth-client",
	appUserId: "test-app-user",
	notification: {
		type: "issueUnassignedFromYou",
		id: "notification-789",
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		archivedAt: null,
		actorId: "actor-789",
		externalUserActorId: null,
		userId: "user-789",
		issueId: "issue-123",
		issue: {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			teamId: "test-workspace",
			team: { id: "test-workspace", key: "TEST", name: "Test Team" },
			url: "https://linear.app/issue/TEST-123",
			...issue,
		},
		actor: {
			id: "actor-789",
			name: "Test Unassigner",
			email: "unassigner@example.com",
			url: "https://linear.app/user/actor-789",
		},
	},
	webhookTimestamp: Date.now(),
	webhookId: "webhook-789",
});

export const mockClaudeAssistantMessage = (content: string): SDKMessage =>
	({
		type: "assistant",
		message: {
			content: [{ type: "text", text: content }],
		},
		parent_tool_use_id: null,
		session_id: "test-session",
	}) as any;

export const mockClaudeToolMessage = (
	toolName: string,
	input: any,
): SDKMessage =>
	({
		type: "assistant",
		message: {
			content: [
				{
					type: "tool_use",
					name: toolName,
					input,
					id: `tool_${toolName}_${Date.now()}`,
				},
			],
		},
		parent_tool_use_id: null,
		session_id: "test-session",
	}) as any;

export const mockClaudeResultMessage = (
	subtype: "success" | "error_max_turns" | "error_during_execution" = "success",
): SDKMessage =>
	({
		type: "result",
		subtype,
		duration_ms: 1000,
		duration_api_ms: 500,
		is_error: subtype !== "success",
		num_turns: 1,
		session_id: "test-session",
		total_cost_usd: 0.01,
		usage: {
			input_tokens: 100,
			output_tokens: 50,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		...(subtype === "success" && { result: "Task completed successfully" }),
	}) as any;

// Reset all mocks after each test
afterEach(() => {
	vi.clearAllMocks();
});
