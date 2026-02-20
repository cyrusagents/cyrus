/**
 * Unit tests for LinearActivitySink
 */

import {
	type AgentActivityContent,
	AgentActivitySignal,
	type IIssueTrackerService,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ActivityPostOptions } from "../src/sinks/IActivitySink.js";
import { LinearActivitySink } from "../src/sinks/LinearActivitySink.js";

describe("LinearActivitySink", () => {
	let sink: LinearActivitySink;
	let mockIssueTracker: IIssueTrackerService;

	const mockWorkspaceId = "workspace-123";
	const mockSessionId = "session-456";
	const mockIssueId = "issue-789";

	beforeEach(() => {
		// Create a minimal mock IssueTrackerService
		mockIssueTracker = {
			createAgentActivity: vi.fn(),
			createAgentSessionOnIssue: vi.fn(),
		} as unknown as IIssueTrackerService;

		sink = new LinearActivitySink(mockIssueTracker, mockWorkspaceId);
	});

	describe("Constructor", () => {
		it("should set the workspace ID as sink ID", () => {
			expect(sink.id).toBe(mockWorkspaceId);
		});

		it("should store the issue tracker reference", () => {
			// Verify the sink has the tracker by calling a method
			expect(sink).toBeDefined();
		});
	});

	describe("postActivity()", () => {
		it("should post a thought activity and return activityId", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "Analyzing the codebase...",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({ activityId: "activity-1" });
			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
			});
		});

		it("should post an action activity", async () => {
			const activity: AgentActivityContent = {
				type: "action",
				action: "read_file",
				parameter: "src/index.ts",
				result: "File contents...",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-2" }),
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({ activityId: "activity-2" });
			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
			});
		});

		it("should post a response activity", async () => {
			const activity: AgentActivityContent = {
				type: "response",
				body: "I've completed the task successfully.",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-3" }),
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({ activityId: "activity-3" });
		});

		it("should post an error activity", async () => {
			const activity: AgentActivityContent = {
				type: "error",
				body: "Failed to read file: Permission denied",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-4" }),
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({ activityId: "activity-4" });
		});

		it("should post an elicitation activity", async () => {
			const activity: AgentActivityContent = {
				type: "elicitation",
				body: "Which API endpoint should I use?",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-5" }),
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({ activityId: "activity-5" });
		});

		it("should handle activity posting errors", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "Test",
			};

			const error = new Error("Network error");
			vi.mocked(mockIssueTracker.createAgentActivity).mockRejectedValue(error);

			await expect(sink.postActivity(mockSessionId, activity)).rejects.toThrow(
				"Network error",
			);
		});

		it("should return empty result when success but no agentActivity", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "Test",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: undefined,
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({});
		});

		it("should return empty result when success is false", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "Test",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: false,
			} as any);

			const result = await sink.postActivity(mockSessionId, activity);

			expect(result).toEqual({});
		});

		it("should call createAgentActivity exactly once per post", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "Test",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			await sink.postActivity(mockSessionId, activity);

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledTimes(1);
		});

		it("should pass ephemeral option through to createAgentActivity", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "Ephemeral thought",
			};
			const options: ActivityPostOptions = { ephemeral: true };

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-eph" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, options);

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
				ephemeral: true,
			});
		});

		it("should map 'auth' signal to AgentActivitySignal.Auth", async () => {
			const activity: AgentActivityContent = {
				type: "elicitation",
				body: "Please approve",
			};
			const options: ActivityPostOptions = {
				signal: "auth",
				signalMetadata: { url: "https://example.com/approve" },
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-sig" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, options);

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
				signal: AgentActivitySignal.Auth,
				signalMetadata: { url: "https://example.com/approve" },
			});
		});

		it("should map 'select' signal to AgentActivitySignal.Select", async () => {
			const activity: AgentActivityContent = {
				type: "elicitation",
				body: "Choose a repo",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-sel" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, { signal: "select" });

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
				signal: AgentActivitySignal.Select,
			});
		});

		it("should map 'stop' signal to AgentActivitySignal.Stop", async () => {
			const activity: AgentActivityContent = {
				type: "response",
				body: "Stopping",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-stop" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, { signal: "stop" });

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
				signal: AgentActivitySignal.Stop,
			});
		});

		it("should map 'continue' signal to AgentActivitySignal.Continue", async () => {
			const activity: AgentActivityContent = {
				type: "response",
				body: "Continuing",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-cont" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, {
				signal: "continue",
			});

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
				signal: AgentActivitySignal.Continue,
			});
		});

		it("should pass signalMetadata through to createAgentActivity", async () => {
			const activity: AgentActivityContent = {
				type: "elicitation",
				body: "Select",
			};
			const metadata = { options: ["repo-a", "repo-b"], defaultIndex: 0 };

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-meta" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, {
				signal: "select",
				signalMetadata: metadata,
			});

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
				signal: AgentActivitySignal.Select,
				signalMetadata: metadata,
			});
		});

		it("should not include ephemeral when option is undefined", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "No ephemeral",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-no-eph" }),
			} as any);

			await sink.postActivity(mockSessionId, activity, {});

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
			});
		});
	});

	describe("createAgentSession()", () => {
		it("should create a session and return session ID", async () => {
			const expectedSessionId = "new-session-123";
			vi.mocked(mockIssueTracker.createAgentSessionOnIssue).mockResolvedValue({
				success: true,
				agentSession: Promise.resolve({ id: expectedSessionId }),
			} as any);

			const sessionId = await sink.createAgentSession(mockIssueId);

			expect(sessionId).toBe(expectedSessionId);
			expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledWith({
				issueId: mockIssueId,
			});
		});

		it("should throw when result.success is false", async () => {
			vi.mocked(mockIssueTracker.createAgentSessionOnIssue).mockResolvedValue({
				success: false,
				agentSession: Promise.resolve({ id: "should-not-reach" }),
			} as any);

			await expect(sink.createAgentSession(mockIssueId)).rejects.toThrow(
				"request was not successful",
			);
		});

		it("should handle session creation errors", async () => {
			const error = new Error("Failed to create session");
			vi.mocked(mockIssueTracker.createAgentSessionOnIssue).mockRejectedValue(
				error,
			);

			await expect(sink.createAgentSession(mockIssueId)).rejects.toThrow(
				"Failed to create session",
			);
		});

		it("should await agentSession promise before extracting ID", async () => {
			const expectedSessionId = "new-session-456";
			const agentSessionPromise = Promise.resolve({ id: expectedSessionId });

			vi.mocked(mockIssueTracker.createAgentSessionOnIssue).mockResolvedValue({
				success: true,
				agentSession: agentSessionPromise,
			} as any);

			const sessionId = await sink.createAgentSession(mockIssueId);

			expect(sessionId).toBe(expectedSessionId);
		});

		it("should call createAgentSessionOnIssue exactly once", async () => {
			vi.mocked(mockIssueTracker.createAgentSessionOnIssue).mockResolvedValue({
				success: true,
				agentSession: Promise.resolve({ id: "session-123" }),
			} as any);

			await sink.createAgentSession(mockIssueId);

			expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(
				1,
			);
		});
	});

	describe("Multiple Operations", () => {
		it("should handle multiple activity posts to the same session", async () => {
			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			await sink.postActivity(mockSessionId, {
				type: "thought",
				body: "First thought",
			});
			await sink.postActivity(mockSessionId, {
				type: "action",
				action: "read_file",
				parameter: "test.ts",
			});
			await sink.postActivity(mockSessionId, {
				type: "response",
				body: "Done",
			});

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledTimes(3);
		});

		it("should handle creating multiple sessions", async () => {
			vi.mocked(mockIssueTracker.createAgentSessionOnIssue).mockResolvedValue({
				success: true,
				agentSession: Promise.resolve({ id: "session-1" }),
			} as any);

			await sink.createAgentSession("issue-1");
			await sink.createAgentSession("issue-2");
			await sink.createAgentSession("issue-3");

			expect(mockIssueTracker.createAgentSessionOnIssue).toHaveBeenCalledTimes(
				3,
			);
			expect(
				mockIssueTracker.createAgentSessionOnIssue,
			).toHaveBeenNthCalledWith(1, { issueId: "issue-1" });
			expect(
				mockIssueTracker.createAgentSessionOnIssue,
			).toHaveBeenNthCalledWith(2, { issueId: "issue-2" });
			expect(
				mockIssueTracker.createAgentSessionOnIssue,
			).toHaveBeenNthCalledWith(3, { issueId: "issue-3" });
		});
	});

	describe("Workspace ID Management", () => {
		it("should create sinks with different workspace IDs", () => {
			const sink1 = new LinearActivitySink(mockIssueTracker, "workspace-1");
			const sink2 = new LinearActivitySink(mockIssueTracker, "workspace-2");

			expect(sink1.id).toBe("workspace-1");
			expect(sink2.id).toBe("workspace-2");
		});

		it("should maintain consistent ID throughout lifecycle", async () => {
			const initialId = sink.id;

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			await sink.postActivity(mockSessionId, {
				type: "thought",
				body: "Test",
			});

			expect(sink.id).toBe(initialId);
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty activity body", async () => {
			const activity: AgentActivityContent = {
				type: "thought",
				body: "",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			await sink.postActivity(mockSessionId, activity);

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
			});
		});

		it("should handle activity with minimal fields", async () => {
			const activity: AgentActivityContent = {
				type: "action",
				action: "test",
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			await sink.postActivity(mockSessionId, activity);

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
			});
		});

		it("should handle very long activity content", async () => {
			const longBody = "x".repeat(10000);
			const activity: AgentActivityContent = {
				type: "thought",
				body: longBody,
			};

			vi.mocked(mockIssueTracker.createAgentActivity).mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-1" }),
			} as any);

			await sink.postActivity(mockSessionId, activity);

			expect(mockIssueTracker.createAgentActivity).toHaveBeenCalledWith({
				agentSessionId: mockSessionId,
				content: activity,
			});
		});
	});
});
