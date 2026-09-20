import {
	CodexEventMapper,
	CodexRunner,
	type MapperContext,
} from "cyrus-codex-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager - Codex tool activity mapping", () => {
	let manager: AgentSessionManager;
	let mapper: CodexEventMapper;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-codex";
	const issueId = "issue-codex";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
			createAgentSession: vi.fn().mockResolvedValue("session-123"),
		};

		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");
		manager = new AgentSessionManager();

		// A CodexRunner supplies the Codex message formatter the manager uses to
		// render tool activities; the event→message mapping itself is driven
		// directly through CodexEventMapper.
		const runner = new CodexRunner({
			workingDirectory: "/Users/connor/code/cyrus",
		});

		const ctx: MapperContext = {
			workingDirectory: "/Users/connor/code/cyrus",
			model: "gpt-5.5",
			getSessionId: () => "codex-session-1",
			getStagedSkillNames: () => [],
			emitMessage: () => {},
			onThreadStarted: () => {},
		};
		mapper = new CodexEventMapper(ctx);
		mapper.reset();

		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-100",
				title: "Codex activity test",
				description: "",
				branchName: "test-branch",
			},
			{
				path: "/Users/connor/code/cyrus",
				isGitWorktree: false,
			},
		);
		manager.setActivitySink(sessionId, mockActivitySink);
		manager.addAgentRunner(sessionId, runner);
	});

	it.each([
		"xhigh",
		null,
		undefined,
	])("records effective Codex effort %s without guessing defaults", async (reasoningEffort) => {
		mapper.handle({
			kind: "thread-started",
			threadId: "codex-session-1",
			model: "gpt-6-astra",
			reasoningEffort,
		});
		for (const message of mapper.getMessages())
			await manager.handleClaudeMessage(sessionId, message);
		expect(manager.getAllSessions()[0]?.metadata).toMatchObject({
			model: "gpt-6-astra",
			reasoningEffort: reasoningEffort ?? undefined,
		});
	});

	it.each([
		true,
		false,
		undefined,
	])("retains Fast mode %s in session metadata", async (fastMode) => {
		mapper.handle({ kind: "thread-started", threadId: "codex-session-1" });
		for (const message of mapper.getMessages())
			await manager.handleClaudeMessage(
				sessionId,
				Object.assign(message, { fastMode }),
			);
		expect(manager.getAllSessions()[0]?.metadata?.fastMode).toBe(fastMode);
	});

	it("creates Linear action entries for Codex file_change events", async () => {
		mapper.handle({
			kind: "item-completed",
			item: {
				id: "patch_1",
				type: "file_change",
				changes: [
					{
						path: "/Users/connor/code/cyrus/packages/core/src/index.ts",
						kind: "update",
					},
				],
				status: "completed",
			},
		});

		for (const message of mapper.getMessages()) {
			await manager.handleClaudeMessage(sessionId, message);
		}

		const calls = postActivitySpy.mock.calls;
		expect(calls).toHaveLength(2);

		const actionWithParameter = calls.find(
			(call: any[]) =>
				call[1]?.type === "action" &&
				call[1]?.action === "Edit" &&
				typeof call[1]?.parameter === "string",
		);
		expect(actionWithParameter).toBeDefined();
		expect(actionWithParameter![1]?.parameter).toContain(
			"packages/core/src/index.ts",
		);

		const actionWithResult = calls.find(
			(call: any[]) =>
				call[1]?.type === "action" &&
				call[1]?.action === "Edit" &&
				typeof call[1]?.result === "string",
		);
		expect(actionWithResult).toBeDefined();
		expect(actionWithResult![1]?.result).toContain(
			"update packages/core/src/index.ts",
		);
	});
});
