import { CodexRunner } from "cyrus-codex-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

describe("AgentSessionManager - Codex tool activity mapping", () => {
	let manager: AgentSessionManager;
	let runner: CodexRunner;
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
		manager = new AgentSessionManager(mockActivitySink);
		runner = new CodexRunner({
			workingDirectory: "/Users/connor/code/cyrus",
		});

		manager.createLinearAgentSession(
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
		manager.addAgentRunner(sessionId, runner);

		(runner as any).sessionInfo = {
			sessionId: "codex-session-1",
			startedAt: new Date(),
			isRunning: true,
		};
	});

	it("creates Linear action entries for Codex file_change events", async () => {
		(runner as any).handleEvent({
			type: "item.completed",
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

		for (const message of runner.getMessages()) {
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
