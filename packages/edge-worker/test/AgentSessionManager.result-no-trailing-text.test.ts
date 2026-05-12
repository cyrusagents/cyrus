import type {
	SDKAssistantMessage,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Regression test for CYPACK-1177:
 * When an SDK turn ends on a tool call (ScheduleWakeup or background Bash)
 * with NO trailing assistant text, the "Finished" response activity was
 * being posted with raw tool-input JSON as its body. The fix:
 *
 *   1. Don't buffer tool-use content into lastAssistantBodyBySession — its
 *      `content` is JSON.stringify(tool input).
 *   2. If addResultEntry has no assistant text to post and the result is not
 *      an error, skip emitting the response activity entirely.
 */
describe("AgentSessionManager - result activity when turn ends on tool call (CYPACK-1177)", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-1177";
	const issueId = "issue-1177";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "CYPACK-1177",
				title: "Finished activity bug",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);

		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	});

	function buildToolUseAssistantMessage(
		uuid: string,
		toolUseId: string,
		name: string,
		input: Record<string, unknown>,
	): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid,
			message: {
				id: `msg_${toolUseId}`,
				type: "message",
				role: "assistant",
				model: "claude",
				stop_reason: "tool_use",
				stop_sequence: null,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
				content: [{ type: "tool_use", id: toolUseId, name, input }],
			},
		} as unknown as SDKAssistantMessage;
	}

	function buildSuccessResult(result = ""): SDKResultMessage {
		return {
			type: "result",
			subtype: "success",
			session_id: "claude-session",
			duration_ms: 1000,
			duration_api_ms: 800,
			is_error: false,
			num_turns: 1,
			result,
			total_cost_usd: 0,
			usage: {
				input_tokens: 0,
				output_tokens: 0,
				cache_creation_input_tokens: 0,
				cache_read_input_tokens: 0,
			},
		} as unknown as SDKResultMessage;
	}

	it("does not emit a response activity with raw tool-input JSON when turn ends on ScheduleWakeup", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUseAssistantMessage("uuid-1", "toolu_wakeup", "ScheduleWakeup", {
				delaySeconds: 270,
				reason: "Wait for full RSpec suite to finish before committing",
				prompt:
					"Continue with QC-5209 — check RSpec results and commit/push/PR",
			}),
		);
		await manager.handleClaudeMessage(sessionId, buildSuccessResult(""));

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		// Must NOT emit a response activity at all (no real text to post).
		const responses = postedContents.filter((c: any) => c?.type === "response");
		expect(responses).toEqual([]);

		// Must NOT emit a response whose body contains the tool input.
		const leakedJson = postedContents.filter(
			(c: any) =>
				typeof c?.body === "string" &&
				c.body.includes("delaySeconds") &&
				c.body.includes("270"),
		);
		expect(leakedJson).toEqual([]);
	});

	it("does not emit a response activity when turn ends on a background Bash tool call", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUseAssistantMessage("uuid-2", "toolu_bash", "Bash", {
				command: "echo 'waiting for repo...'",
				description: "idle",
			}),
		);
		await manager.handleClaudeMessage(sessionId, buildSuccessResult(""));

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		const responses = postedContents.filter((c: any) => c?.type === "response");
		expect(responses).toEqual([]);

		const leakedJson = postedContents.filter(
			(c: any) =>
				typeof c?.body === "string" &&
				c.body.includes("echo 'waiting for repo...'"),
		);
		expect(leakedJson).toEqual([]);
	});

	it("still emits a response activity when assistant text precedes the result", async () => {
		// Trailing assistant text path — should produce a real response.
		const textMsg: SDKAssistantMessage = {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: "uuid-text",
			message: {
				id: "msg_text",
				type: "message",
				role: "assistant",
				model: "claude",
				stop_reason: "end_turn",
				stop_sequence: null,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
				},
				content: [{ type: "text", text: "All done — PR created." }],
			},
		} as unknown as SDKAssistantMessage;

		await manager.handleClaudeMessage(sessionId, textMsg);
		await manager.handleClaudeMessage(sessionId, buildSuccessResult(""));

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		const responses = postedContents.filter((c: any) => c?.type === "response");
		expect(responses).toHaveLength(1);
		expect(responses[0].body).toBe("All done — PR created.");
	});
});
