import type { SDKStatusMessage } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager - Status Messages", () => {
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

	it("should post ephemeral activity when compacting status is received", async () => {
		// Create a status message with compacting status
		const statusMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "claude-session-123",
		};

		// Handle the status message
		await manager.handleClaudeMessage(sessionId, statusMessage);

		// Verify that postActivity was called with ephemeral thought
		// postActivity(sessionId, content, options)
		expect(postActivitySpy).toHaveBeenCalledWith(
			sessionId,
			{
				type: "thought",
				body: "Compacting conversation history…",
			},
			{ ephemeral: true },
		);
	});

	it("should post non-ephemeral activity when status is cleared (null)", async () => {
		// First, send a compacting status
		const compactingMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "claude-session-123",
		};
		await manager.handleClaudeMessage(sessionId, compactingMessage);

		// Clear the mock calls
		postActivitySpy.mockClear();

		// Now send a status clear message
		const statusClearMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: null,
			session_id: "claude-session-123",
		};

		// Handle the status clear message
		await manager.handleClaudeMessage(sessionId, statusClearMessage);

		// Verify that postActivity was called with non-ephemeral thought
		expect(postActivitySpy).toHaveBeenCalledWith(
			sessionId,
			{
				type: "thought",
				body: "Conversation history compacted",
			},
			{ ephemeral: false },
		);
	});

	it("should handle compacting status followed by clear status", async () => {
		// Send compacting status
		const compactingMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "claude-session-123",
		};
		await manager.handleClaudeMessage(sessionId, compactingMessage);

		// Verify ephemeral activity was created
		expect(postActivitySpy).toHaveBeenCalledWith(
			sessionId,
			{
				type: "thought",
				body: "Compacting conversation history…",
			},
			{ ephemeral: true },
		);

		// Clear the mock calls
		postActivitySpy.mockClear();

		// Send status clear
		const statusClearMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: null,
			session_id: "claude-session-123",
		};
		await manager.handleClaudeMessage(sessionId, statusClearMessage);

		// Verify non-ephemeral activity was created
		expect(postActivitySpy).toHaveBeenCalledWith(
			sessionId,
			{
				type: "thought",
				body: "Conversation history compacted",
			},
			{ ephemeral: false },
		);
	});

	it("should handle error when posting compacting status fails", async () => {
		// Mock postActivity to throw
		postActivitySpy.mockRejectedValueOnce(new Error("Failed to post"));

		// Spy on console.error
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		// Create a status message with compacting status
		const statusMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "claude-session-123",
		};

		// Handle the status message
		await manager.handleClaudeMessage(sessionId, statusMessage);

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Error creating compacting status:"),
			expect.any(Error),
		);

		// Clean up
		consoleErrorSpy.mockRestore();
	});

	it("should handle error when posting status clear fails", async () => {
		// First send compacting status successfully
		const compactingMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "claude-session-123",
		};
		await manager.handleClaudeMessage(sessionId, compactingMessage);

		// Mock postActivity to throw for the next call
		postActivitySpy.mockRejectedValueOnce(new Error("Failed to post"));

		// Spy on console.error
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});

		// Send status clear
		const statusClearMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: null,
			session_id: "claude-session-123",
		};

		// Handle the status clear message
		await manager.handleClaudeMessage(sessionId, statusClearMessage);

		// Verify error was logged
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Error creating status clear:"),
			expect.any(Error),
		);

		// Clean up
		consoleErrorSpy.mockRestore();
	});

	it("should not crash if session is not found", async () => {
		// Create a status message for a non-existent session
		const statusMessage: SDKStatusMessage = {
			type: "system",
			subtype: "status",
			status: "compacting",
			session_id: "claude-session-123",
		};

		// Handle the status message for a non-existent session — should not throw
		await manager.handleClaudeMessage("non-existent-session", statusMessage);

		// Verify postActivity was not called
		expect(postActivitySpy).not.toHaveBeenCalled();
	});
});
