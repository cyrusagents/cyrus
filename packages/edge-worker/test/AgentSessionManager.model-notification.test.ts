import type { SDKSystemMessage } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager - Model Notification", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-123";
	const issueId = "issue-123";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
			createAgentSession: vi.fn().mockResolvedValue("session-123"),
		};

		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");

		manager = new AgentSessionManager(mockActivitySink);

		// Create a test session
		manager.createLinearAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				branchName: "test-branch",
			},
			{
				path: "/test/workspace",
				isGitWorktree: false,
			},
		);
	});

	it("should post model notification when system init message is received", async () => {
		// Create a system init message with model information
		const systemMessage: SDKSystemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session-123",
			model: "claude-3-opus-20240229",
			tools: ["bash", "grep", "edit"],
			permissionMode: "allowed_tools",
			apiKeySource: "claude_desktop",
		};

		// Handle the system message
		await manager.handleClaudeMessage(sessionId, systemMessage);

		// Verify that postActivity was called with model notification
		// postActivity(sessionId, content, options)
		const modelNotificationCall = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1].type === "thought" && call[1].body.includes("Using model:"),
		);

		expect(modelNotificationCall).toBeTruthy();
		expect(modelNotificationCall[0]).toBe(sessionId);
		expect(modelNotificationCall[1]).toEqual({
			type: "thought",
			body: "Using model: claude-3-opus-20240229",
		});
	});

	it("should not post model notification if model is not provided", async () => {
		// Create a system init message without model information
		const systemMessage: SDKSystemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session-123",
			model: "",
			tools: ["bash", "grep", "edit"],
			permissionMode: "allowed_tools",
			apiKeySource: "claude_desktop",
		};

		// Handle the system message
		await manager.handleClaudeMessage(sessionId, systemMessage);

		// Verify that no model notification was posted
		const modelNotificationCall = postActivitySpy.mock.calls.find(
			(call: any) =>
				call[1]?.type === "thought" && call[1]?.body?.includes("Using model:"),
		);

		expect(modelNotificationCall).toBeFalsy();
	});

	it("should update session metadata with model information", async () => {
		// Create a system init message with model information
		const systemMessage: SDKSystemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session-123",
			model: "claude-3-sonnet-20240229",
			tools: ["bash", "grep", "edit"],
			permissionMode: "allowed_tools",
			apiKeySource: "claude_desktop",
		};

		// Handle the system message
		await manager.handleClaudeMessage(sessionId, systemMessage);

		// Verify session metadata was updated
		const session = manager.getSession(sessionId);
		expect(session?.metadata?.model).toBe("claude-3-sonnet-20240229");
		expect(session?.claudeSessionId).toBe("claude-session-123");
	});

	it("should handle error when posting model notification fails", async () => {
		// Mock postActivity to throw
		postActivitySpy.mockRejectedValueOnce(new Error("Failed to post"));

		// Spy on console.error
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		// Create a system init message with model information
		const systemMessage: SDKSystemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session-123",
			model: "claude-3-opus-20240229",
			tools: ["bash", "grep", "edit"],
			permissionMode: "allowed_tools",
			apiKeySource: "claude_desktop",
		};

		// Handle the system message
		await manager.handleClaudeMessage(sessionId, systemMessage);

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Error creating model notification:"),
			expect.any(Error),
		);

		// Clean up
		consoleErrorSpy.mockRestore();
	});
});
