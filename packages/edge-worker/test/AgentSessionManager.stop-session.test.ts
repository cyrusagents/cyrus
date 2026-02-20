import { AgentSessionStatus } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager stop-session behavior", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: any;
	const sessionId = "test-session-stop";
	const issueId = "issue-stop";
	let mockProcedureAnalyzer: any;

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-1"),
		};

		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");

		mockProcedureAnalyzer = {
			getNextSubroutine: vi.fn().mockReturnValue({ name: "verifications" }),
			getCurrentSubroutine: vi
				.fn()
				.mockReturnValue({ name: "coding-activity" }),
			advanceToNextSubroutine: vi.fn(),
			getLastSubroutineResult: vi
				.fn()
				.mockReturnValue("Recovered previous result"),
		};

		manager = new AgentSessionManager(
			mockActivitySink,
			undefined,
			undefined,
			mockProcedureAnalyzer,
		);

		manager.createLinearAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-STOP",
				title: "Stop Session Test",
				description: "test",
				branchName: "test-stop",
			},
			{
				path: "/tmp/workspace",
				isGitWorktree: false,
			},
		);
	});

	it("does not advance procedure when a session stop is requested", async () => {
		const subroutineCompleteSpy = vi.fn();
		manager.on("subroutineComplete", subroutineCompleteSpy);

		manager.requestSessionStop(sessionId);

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "success",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: false,
			num_turns: 1,
			result: "Stopped run should not continue",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-1",
			session_id: "sdk-session",
		} as any);

		expect(subroutineCompleteSpy).not.toHaveBeenCalled();
		expect(
			mockProcedureAnalyzer.advanceToNextSubroutine,
		).not.toHaveBeenCalled();
		expect(manager.getSession(sessionId)?.status).toBe(
			AgentSessionStatus.Error,
		);
	});

	it("does not recover-and-advance for non max-turn execution errors", async () => {
		const subroutineCompleteSpy = vi.fn();
		manager.on("subroutineComplete", subroutineCompleteSpy);

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: ["aborted by user"],
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-2",
			session_id: "sdk-session",
		} as any);

		expect(subroutineCompleteSpy).not.toHaveBeenCalled();
		expect(
			mockProcedureAnalyzer.advanceToNextSubroutine,
		).not.toHaveBeenCalled();
	});

	it("posts actual error message to Linear for usage limit errors (not generic)", async () => {
		const usageLimitError =
			"You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Feb 16th, 2026 8:09 PM.";

		await manager.completeSession(sessionId, {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: 1,
			duration_api_ms: 1,
			is_error: true,
			num_turns: 1,
			errors: [usageLimitError],
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 1,
				output_tokens: 1,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "result-3",
			session_id: "sdk-session",
		} as any);

		const postActivityCalls = postActivitySpy.mock.calls;
		const errorActivity = postActivityCalls.find(
			(call: any[]) => call[1]?.type === "error",
		);
		expect(errorActivity).toBeDefined();
		expect(errorActivity![1].body).toBe(usageLimitError);
	});
});
