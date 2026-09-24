import type {
	SDKAssistantMessage,
	SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "miko-claude-runner";
import type { AgentPendingWork } from "miko-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import {
	formatPendingWorkThought,
	formatScheduleWakeupResponse,
	tryParseScheduleWakeupInput,
} from "../src/PendingWorkFormatter";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * CYPACK-1310: when a turn ends with a scheduled wakeup pending, the Linear
 * activity stream must (1) render the final response readably even when the
 * last assistant message was a bare ScheduleWakeup tool call (whose buffered
 * body is raw tool-input JSON), and (2) post a `thought` AFTER the response
 * so Linear's agent panel returns to a working state and declares what the
 * session is waiting on.
 */

const WAKEUP_INPUT = {
	delaySeconds: 300,
	reason: "Waiting for CI to finish",
	prompt: "WAKEUP: check the CI run and report status.",
};

const PENDING_WORK: AgentPendingWork = {
	sessionCrons: [
		{
			id: "cron-1",
			schedule: "27 12 * * *",
			recurring: false,
			prompt: "WAKEUP: check the CI run and report status.",
		},
	],
	backgroundTasks: [],
};

describe("PendingWorkFormatter", () => {
	it("parses a raw ScheduleWakeup tool-input JSON", () => {
		expect(
			tryParseScheduleWakeupInput(JSON.stringify(WAKEUP_INPUT, null, 2)),
		).toEqual(WAKEUP_INPUT);
	});

	it("rejects non-wakeup content", () => {
		expect(tryParseScheduleWakeupInput("All done, PR is up!")).toBeNull();
		expect(tryParseScheduleWakeupInput('{"file_path": "/tmp/x"}')).toBeNull();
		expect(tryParseScheduleWakeupInput("{not json")).toBeNull();
	});

	it("formats the wakeup response with duration and reason", () => {
		const body = formatScheduleWakeupResponse(WAKEUP_INPUT);
		expect(body).toContain("Wakeup scheduled");
		expect(body).toContain("~5m");
		expect(body).toContain("Waiting for CI to finish");
	});

	it("formats one-shot crons with a clock time and prompts", () => {
		const body = formatPendingWorkThought(PENDING_WORK);
		expect(body).toContain("Standing by");
		expect(body).toContain("at 12:27");
		expect(body).toContain("WAKEUP: check the CI run");
	});

	it("formats recurring crons and background tasks", () => {
		const body = formatPendingWorkThought({
			sessionCrons: [
				{
					id: "cron-2",
					schedule: "0 9 * * 1-5",
					recurring: true,
					prompt: "daily standup",
				},
			],
			backgroundTasks: [
				{
					id: "task-1",
					type: "shell",
					status: "running",
					description: "Dev server",
					command: "pnpm dev",
				},
			],
		});
		expect(body).toContain("Recurring wakeup on schedule `0 9 * * 1-5`");
		expect(body).toContain("Background command (running)");
		expect(body).toContain("pnpm dev");
	});

	it("returns null when nothing is pending", () => {
		expect(
			formatPendingWorkThought({ sessionCrons: [], backgroundTasks: [] }),
		).toBeNull();
	});
});

describe("AgentSessionManager pending-work activities", () => {
	let manager: AgentSessionManager;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "session-pending-work";
	const issueId = "issue-pending-work";

	function setup(pendingWork: AgentPendingWork | null) {
		const mockActivitySink: IActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		manager.createMikoAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "CYPACK-1310",
				title: "ScheduleWakeup pending work",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);

		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			...(pendingWork && { getPendingWork: () => pendingWork }),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	}

	function buildScheduleWakeupToolUseMessage(): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: "uuid-wakeup-tool",
			message: {
				id: "msg_wakeup",
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
				content: [
					{
						type: "tool_use",
						id: "toolu_wakeup",
						name: "ScheduleWakeup",
						input: WAKEUP_INPUT,
					},
				],
			},
		} as unknown as SDKAssistantMessage;
	}

	function buildSuccessResult(text: string): SDKResultMessage {
		return {
			type: "result",
			subtype: "success",
			is_error: false,
			result: text,
			session_id: "claude-session",
			duration_ms: 1000,
			num_turns: 2,
		} as unknown as SDKResultMessage;
	}

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("formats a wakeup-JSON response and posts a standing-by thought after it", async () => {
		setup(PENDING_WORK);

		// Final assistant message before result is the bare ScheduleWakeup
		// tool call — its buffered body is the raw tool-input JSON.
		await manager.handleClaudeMessage(
			sessionId,
			buildScheduleWakeupToolUseMessage(),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult("ScheduleWakeup result: Success."),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		// The response is friendly prose, not raw JSON.
		const response = postedContents.find((c: any) => c?.type === "response");
		expect(response).toBeDefined();
		expect(response.body).toContain("Wakeup scheduled");
		expect(response.body).toContain("Waiting for CI to finish");
		expect(response.body).not.toContain("delaySeconds");

		// A standing-by thought is posted AFTER the response.
		const responseIndex = postedContents.indexOf(response);
		const thoughtAfter = postedContents
			.slice(responseIndex + 1)
			.find(
				(c: any) => c?.type === "thought" && c.body.includes("Standing by"),
			);
		expect(thoughtAfter).toBeDefined();
		expect(thoughtAfter.body).toContain("at 12:27");
	});

	it("leaves prose responses untouched and posts no thought when nothing is pending", async () => {
		setup(null);

		await manager.handleClaudeMessage(
			sessionId,
			buildScheduleWakeupToolUseMessage(),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult("All done."),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		// Without pending work it is not formatted as a wakeup, and — crucially —
		// the raw tool-input JSON is NOT posted as the response (CYPACK-1177).
		// The SDK result text is used instead; no standing-by thought appears.
		const response = postedContents.find((c: any) => c?.type === "response");
		expect(response).toBeDefined();
		expect(response.body).toBe("All done.");
		expect(response.body).not.toContain("Wakeup scheduled");
		expect(response.body).not.toContain("delaySeconds");
		expect(
			postedContents.some(
				(c: any) => c?.type === "thought" && c.body?.includes("Standing by"),
			),
		).toBe(false);
	});

	it("never posts raw tool-input JSON when a turn ends on a background Bash with no text (CYPACK-1177/CYHOST-905)", async () => {
		// The original user bug: a turn ending on a background `Bash` tool call
		// with no trailing assistant text posted a "Finished" entry whose body
		// was the raw Bash input JSON. With no SDK result text either, the
		// response activity must be skipped entirely rather than dumping JSON.
		setup(null);

		const bashToolUse = {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: "uuid-bash-tool",
			message: {
				id: "msg_bash",
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
				content: [
					{
						type: "tool_use",
						id: "toolu_bash",
						name: "Bash",
						input: {
							command: "echo 'waiting for repo...'",
							description: "idle",
						},
					},
				],
			},
		} as unknown as SDKAssistantMessage;

		await manager.handleClaudeMessage(sessionId, bashToolUse);
		// Result with empty result text (turn ended on the tool call).
		await manager.handleClaudeMessage(sessionId, buildSuccessResult(""));

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		// No response activity at all — and certainly no raw JSON.
		const response = postedContents.find((c: any) => c?.type === "response");
		expect(response).toBeUndefined();
		expect(
			postedContents.some(
				(c: any) =>
					typeof c?.body === "string" && c.body.includes("waiting for repo"),
			),
		).toBe(false);
	});

	it("posts the standing-by thought even when the agent ends with prose", async () => {
		setup(PENDING_WORK);

		await manager.handleClaudeMessage(
			sessionId,
			buildSuccessResult("Scheduled a wakeup; see you in five."),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		const response = postedContents.find((c: any) => c?.type === "response");
		expect(response).toBeDefined();
		// Prose passes through untouched.
		expect(response.body).toBe("Scheduled a wakeup; see you in five.");

		const thought = postedContents.find(
			(c: any) => c?.type === "thought" && c.body.includes("Standing by"),
		);
		expect(thought).toBeDefined();
	});
});
