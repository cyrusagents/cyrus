import type {
	SDKAssistantMessage,
	SDKSystemMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "atmiko-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Regression test for CYPACK-1112 / CYPACK-978 follow-up:
 * When Claude emits an assistant turn whose only text block is empty (or
 * whitespace), we previously buffered it and later posted it to Linear as a
 * blank `thought` activity. That blank thought rendered as an extra empty
 * line between the "Using model: ..." notification and the first real tool
 * activity — visible as gratuitous whitespace in CYPACK-978's activity log.
 *
 * The fix skips empty/whitespace-only text turns at buffer time (and
 * defensively inside flushBufferedAssistant).
 */
describe("AgentSessionManager - empty assistant thought suppression", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-empty-thought";
	const issueId = "issue-empty-thought";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		manager.createAtmikoAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "CYPACK-978",
				title: "Empty thought regression",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);

		// Register a minimal IAgentRunner stub so tool-use messages can be
		// formatted (formatter is required by the action path).
		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	});

	function buildEmptyTextAssistantMessage(uuid: string): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid,
			message: {
				id: "msg_empty",
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
				content: [{ type: "text", text: "" }],
			},
		} as unknown as SDKAssistantMessage;
	}

	function buildWhitespaceTextAssistantMessage(
		uuid: string,
	): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid,
			message: {
				id: "msg_ws",
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
				content: [{ type: "text", text: "\n \n\t" }],
			},
		} as unknown as SDKAssistantMessage;
	}

	function buildToolUseAssistantMessage(
		uuid: string,
		toolUseId: string,
	): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid,
			message: {
				id: "msg_tool",
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
						id: toolUseId,
						name: "Bash",
						input: { command: "ls", description: "List files" },
					},
				],
			},
		} as unknown as SDKAssistantMessage;
	}

	it("does not post a blank thought when an assistant message has empty text", async () => {
		// Simulate the real sequence seen in CYPACK-978:
		//   system init (posts "Using model: ...")
		//   assistant [text=""]   <-- should NOT produce a blank thought
		//   assistant [tool_use Bash]
		const systemInit: SDKSystemMessage = {
			type: "system",
			subtype: "init",
			session_id: "claude-session",
			model: "claude-opus-4-6",
			tools: ["Bash"],
			permissionMode: "allowed_tools",
			apiKeySource: "claude_desktop",
		} as unknown as SDKSystemMessage;

		await manager.handleClaudeMessage(sessionId, systemInit);
		await manager.handleClaudeMessage(
			sessionId,
			buildEmptyTextAssistantMessage("uuid-empty"),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUseAssistantMessage("uuid-tool", "toolu_1"),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		// "Using model: ..." should be posted.
		expect(
			postedContents.some(
				(c: any) =>
					c?.type === "thought" &&
					typeof c.body === "string" &&
					c.body.startsWith("Using model:"),
			),
		).toBe(true);

		// Tool-use action should be posted.
		expect(
			postedContents.some(
				(c: any) => c?.type === "action" && c.action === "Bash",
			),
		).toBe(true);

		// No blank thought should ever be posted.
		const blankThoughts = postedContents.filter(
			(c: any) =>
				c?.type === "thought" &&
				(c.body === undefined ||
					c.body === null ||
					(typeof c.body === "string" && c.body.trim() === "")),
		);
		expect(blankThoughts).toEqual([]);
	});

	it("does not post a blank thought for whitespace-only text", async () => {
		await manager.handleClaudeMessage(
			sessionId,
			buildWhitespaceTextAssistantMessage("uuid-ws"),
		);
		await manager.handleClaudeMessage(
			sessionId,
			buildToolUseAssistantMessage("uuid-tool", "toolu_2"),
		);

		const postedContents = postActivitySpy.mock.calls.map(
			([, content]) => content,
		);

		const blankThoughts = postedContents.filter(
			(c: any) =>
				c?.type === "thought" &&
				(c.body === undefined ||
					c.body === null ||
					(typeof c.body === "string" && c.body.trim() === "")),
		);
		expect(blankThoughts).toEqual([]);
	});
});
