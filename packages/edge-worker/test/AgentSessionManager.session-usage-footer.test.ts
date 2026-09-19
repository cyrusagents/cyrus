import type { SDKResultMessage } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager - session usage footer", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "session-usage";
	const issueId = "issue-usage";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("session-usage"),
		};
		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "CYPACK-1293",
				title: "Show session usage in final message",
				description: "",
				branchName: "cypack-1293",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	function buildResultMessage(
		overrides: Partial<SDKResultMessage> = {},
	): SDKResultMessage {
		return {
			type: "result",
			subtype: "success",
			duration_ms: 1000,
			duration_api_ms: 900,
			is_error: false,
			num_turns: 1,
			result: "Done.",
			stop_reason: null,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
				cache_creation: null,
			},
			modelUsage: {},
			permission_denials: [],
			uuid: "00000000-0000-0000-0000-000000000001",
			session_id: "runner-session",
			...overrides,
		} as SDKResultMessage;
	}

	it("appends API cost and token counts to the final response", async () => {
		await manager.completeSession(
			sessionId,
			buildResultMessage({
				total_cost_usd: 0.012345,
				usage: {
					input_tokens: 1234,
					output_tokens: 567,
					cache_creation_input_tokens: 89,
					cache_read_input_tokens: 10,
					cache_creation: null,
				},
			}),
		);

		expect(postActivitySpy).toHaveBeenCalledTimes(1);
		expect(postActivitySpy.mock.calls[0]![1]).toEqual({
			type: "response",
			body: [
				"Done.",
				"",
				"---",
				"**Session usage**: ~$0.0123 API cost",
				"**Tokens**: 1,234 input, 567 output, 89 cache write, 10 cache read",
			].join("\n"),
		});
	});

	it("shows token usage when the runner does not provide a cost", async () => {
		await manager.completeSession(
			sessionId,
			buildResultMessage({
				total_cost_usd: 0,
				usage: {
					input_tokens: 100,
					output_tokens: 50,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 25,
					cache_creation: null,
				},
			}),
		);

		expect(postActivitySpy).toHaveBeenCalledTimes(1);
		expect(postActivitySpy.mock.calls[0]![1]).toEqual({
			type: "response",
			body: [
				"Done.",
				"",
				"---",
				"**Session usage**: API cost unavailable from runner",
				"**Tokens**: 100 input, 50 output, 25 cache read",
			].join("\n"),
		});
	});

	it("keeps the final response unchanged when no usage is available", async () => {
		await manager.completeSession(sessionId, buildResultMessage());

		expect(postActivitySpy).toHaveBeenCalledTimes(1);
		expect(postActivitySpy.mock.calls[0]![1]).toEqual({
			type: "response",
			body: "Done.",
		});
	});
});
