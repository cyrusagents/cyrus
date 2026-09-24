import type {
	SDKAssistantMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "miko-claude-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * Regression test for CYPACK-1115: deferred-tool messages (ToolSearch and
 * friends) arrive back-to-back, which previously caused tool_result handlers
 * to race ahead of their matching tool_use handler, producing bogus
 * `action="Tool"` activities with raw tool-name results in Linear.
 *
 * The fix serializes per-session handleClaudeMessage calls via a promise queue
 * so that tool_use always registers in toolCallsByToolUseId before the
 * corresponding tool_result is processed.
 */
describe("AgentSessionManager - concurrent message handling", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-concurrent";
	const issueId = "issue-concurrent";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		postActivitySpy = mockActivitySink.postActivity as ReturnType<typeof vi.fn>;

		manager = new AgentSessionManager();
		// Platform defaults to "linear", which auto-assigns externalSessionId = sessionId
		// so activities can be posted to the sink.
		manager.createMikoAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "CYPACK-1115",
				title: "ToolSearch concurrent test",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/tmp/workspace", isGitWorktree: false },
		);
		manager.setActivitySink(sessionId, mockActivitySink);

		// Minimal IAgentRunner stub that only exposes a real formatter (the
		// concurrency code path only uses this to format tool parameter/result).
		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(sessionId, runnerStub);
	});

	function buildToolUse(id: string, query: string): SDKAssistantMessage {
		return {
			type: "assistant",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: `uuid-${id}`,
			message: {
				id: "msg_1",
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
						id,
						name: "ToolSearch",
						input: { query, max_results: 3 },
					},
				],
			},
		} as unknown as SDKAssistantMessage;
	}

	function buildToolResult(id: string, toolNames: string[]): SDKUserMessage {
		return {
			type: "user",
			session_id: "claude-session",
			parent_tool_use_id: null,
			uuid: `uuid-result-${id}`,
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: id,
						content: toolNames.map((tool_name) => ({
							type: "tool_reference",
							tool_name,
						})),
					},
				],
			},
		} as unknown as SDKUserMessage;
	}

	it("keeps action=ToolSearch when tool_use and tool_result arrive back-to-back without awaits", async () => {
		// Simulate the real EdgeWorker onMessage callback: fire-and-forget the
		// async handleClaudeMessage calls. Without per-session serialization,
		// the tool_result handler would run its map lookup before tool_use is
		// registered, producing action="Tool".
		const firingPromises: Promise<void>[] = [];

		const fire = (message: SDKAssistantMessage | SDKUserMessage) => {
			firingPromises.push(manager.handleClaudeMessage(sessionId, message));
		};

		// Two parallel ToolSearch calls, interleaved result/use ordering as
		// observed in CYPACK-1115 production logs:
		//   tool_use A  -> tool_result A -> tool_use B -> tool_result B
		const idA = "toolu_A";
		const idB = "toolu_B";
		fire(buildToolUse(idA, "linear issue comment"));
		fire(buildToolResult(idA, ["mcp__linear__save_comment"]));
		fire(buildToolUse(idB, "digitalocean droplet create"));
		fire(
			buildToolResult(idB, [
				"mcp__digitalocean-droplets__droplet-create",
				"mcp__digitalocean-droplets__image-create",
				"mcp__digitalocean-droplets__change-kernel-droplet",
			]),
		);

		await Promise.all(firingPromises);

		const actionCalls = postActivitySpy.mock.calls
			.map(([, content]) => content)
			.filter((content: any) => content?.type === "action");

		// Every action activity should have action="ToolSearch".
		for (const content of actionCalls) {
			expect(content.action).toBe("ToolSearch");
		}

		// And the tool_result call for B (digitalocean) must carry the formatted
		// "Loaded tools: ..." result, not a raw code-fenced tool-name dump.
		const doResult = actionCalls.find(
			(content: any) =>
				typeof content.parameter === "string" &&
				content.parameter.includes("digitalocean droplet create") &&
				typeof content.result === "string",
		);
		expect(doResult).toBeDefined();
		expect(doResult!.result).toBe(
			"Loaded tools: `mcp__digitalocean-droplets__droplet-create`, `mcp__digitalocean-droplets__image-create`, `mcp__digitalocean-droplets__change-kernel-droplet`",
		);
		expect(doResult!.result).not.toContain("```");
	});
});
