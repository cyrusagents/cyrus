import type {
	SDKAssistantMessage,
	SDKStatusMessage,
	SDKSystemMessage,
} from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Tests that GitHub (non-Linear) sessions skip all Linear activity posting.
 *
 * When `platform: "github"` is passed to createLinearAgentSession, the session
 * has no externalSessionId, so all postActivity calls should be skipped.
 */
describe("AgentSessionManager - GitHub Session", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "github-session-123";
	const issueId = "issue-456";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
			createAgentSession: vi.fn().mockResolvedValue("session-123"),
		};

		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager(mockActivitySink);
	});

	function createGitHubSession() {
		manager.createLinearAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "GH-42",
				title: "GitHub Issue",
				description: "A GitHub issue",
				branchName: "fix/gh-42",
			},
			{ path: "/test/workspace", isGitWorktree: false },
			"github",
		);
	}

	function createLinearSession() {
		manager.createLinearAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "LIN-99",
				title: "Linear Issue",
				description: "A Linear issue",
				branchName: "fix/lin-99",
			},
			{ path: "/test/workspace", isGitWorktree: false },
			"linear",
		);
	}

	// ── GitHub session tests ──────────────────────────────────────────────

	it("should skip postActivity for assistant messages in GitHub sessions", async () => {
		createGitHubSession();

		const assistantMessage: SDKAssistantMessage = {
			type: "assistant",
			message: {
				id: "msg-1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Here is my response." }],
				model: "claude-sonnet-4-5-20250514",
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 20 },
			} as any,
			parent_tool_use_id: null,
			uuid: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
			session_id: "claude-session-1",
		};

		await manager.handleClaudeMessage(sessionId, assistantMessage);

		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	it("should skip model notification for GitHub sessions", async () => {
		createGitHubSession();

		const systemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session-1",
			model: "claude-sonnet-4-5-20250514",
			tools: ["bash", "grep", "edit"],
			permissionMode: "default",
			apiKeySource: "user",
		} as SDKSystemMessage;

		await manager.handleClaudeMessage(sessionId, systemMessage);

		const modelNotificationCall = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" && call[1]?.body?.includes("Using model:"),
		);

		expect(modelNotificationCall).toBeFalsy();
	});

	it("should skip status messages for GitHub sessions", async () => {
		createGitHubSession();

		const statusMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			uuid: "00000000-0000-0000-0000-000000000002" as `${string}-${string}-${string}-${string}-${string}`,
			session_id: "claude-session-1",
		};

		await manager.handleClaudeMessage(sessionId, statusMessage);

		expect(postActivitySpy).not.toHaveBeenCalled();
	});

	// ── Linear session regression tests ───────────────────────────────────

	it("should still sync assistant messages for Linear sessions", async () => {
		createLinearSession();

		const assistantMessage: SDKAssistantMessage = {
			type: "assistant",
			message: {
				id: "msg-1",
				type: "message",
				role: "assistant",
				content: [{ type: "text", text: "Here is my response." }],
				model: "claude-sonnet-4-5-20250514",
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: { input_tokens: 10, output_tokens: 20 },
			} as any,
			parent_tool_use_id: null,
			uuid: "00000000-0000-0000-0000-000000000001" as `${string}-${string}-${string}-${string}-${string}`,
			session_id: "claude-session-1",
		};

		await manager.handleClaudeMessage(sessionId, assistantMessage);

		expect(postActivitySpy).toHaveBeenCalled();
	});

	it("should still post model notifications for Linear sessions", async () => {
		createLinearSession();

		const systemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session-1",
			model: "claude-sonnet-4-5-20250514",
			tools: ["bash", "grep", "edit"],
			permissionMode: "default",
			apiKeySource: "user",
		} as SDKSystemMessage;

		await manager.handleClaudeMessage(sessionId, systemMessage);

		const modelNotificationCall = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" && call[1]?.body?.includes("Using model:"),
		);

		expect(modelNotificationCall).toBeTruthy();
		expect(modelNotificationCall![0]).toBe(sessionId);
		expect(modelNotificationCall![1]).toEqual({
			type: "thought",
			body: "Using model: claude-sonnet-4-5-20250514",
		});
	});
});
