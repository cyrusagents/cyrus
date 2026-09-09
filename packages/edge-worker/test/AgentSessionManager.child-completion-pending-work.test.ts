import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeMessageFormatter } from "cyrus-claude-runner";
import type { AgentPendingWork } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

/**
 * A child session's parent must only be resumed when the child is actually
 * done. When a turn ends with pending work (a scheduled wakeup or a
 * background task) the runner holds the session open and more messages,
 * ending in another result, will follow. Firing the parent callback on that
 * intermediate result hands the orchestrator a non-final result and resumes
 * it twice.
 */

const childSessionId = "child-session";
const parentSessionId = "parent-session";

const BACKGROUND_TASK_PENDING: AgentPendingWork = {
	sessionCrons: [],
	backgroundTasks: [
		{
			id: "task-1",
			type: "shell",
			status: "running",
			description: "Open PR",
			command: "gh pr create",
		},
	],
};

const CRON_PENDING: AgentPendingWork = {
	sessionCrons: [
		{
			id: "cron-1",
			schedule: "27 12 * * *",
			recurring: false,
			prompt: "WAKEUP: check CI",
		},
	],
	backgroundTasks: [],
};

describe("AgentSessionManager child completion with pending work", () => {
	let manager: AgentSessionManager;
	let resumeParentSession: ReturnType<typeof vi.fn>;

	function setup(pendingWork: AgentPendingWork | null) {
		resumeParentSession = vi.fn().mockResolvedValue(undefined);
		manager = new AgentSessionManager(
			(id) => (id === childSessionId ? parentSessionId : undefined),
			resumeParentSession,
		);

		const sink: IActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-1" }),
			createAgentSession: vi.fn().mockResolvedValue("ext-session-1"),
		};
		manager.createCyrusAgentSession(
			childSessionId,
			"child-issue",
			{
				id: "child-issue",
				identifier: "TEST-2",
				title: "Child",
				description: "",
				branchName: "test-2",
			},
			{ path: "/tmp/child", isGitWorktree: false },
		);
		manager.setActivitySink(childSessionId, sink);

		const formatter = new ClaudeMessageFormatter();
		const runnerStub = {
			getFormatter: () => formatter,
			...(pendingWork && { getPendingWork: () => pendingWork }),
			constructor: { name: "ClaudeRunner" },
		} as unknown as Parameters<typeof manager.addAgentRunner>[1];
		manager.addAgentRunner(childSessionId, runnerStub);
	}

	function result(text: string): SDKResultMessage {
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

	it("does not resume the parent while a background task keeps the child open", async () => {
		setup(BACKGROUND_TASK_PENDING);

		await manager.handleClaudeMessage(
			childSessionId,
			result("Opened the PR in the background."),
		);

		expect(resumeParentSession).not.toHaveBeenCalled();
	});

	it("does not resume the parent while a scheduled wakeup keeps the child open", async () => {
		setup(CRON_PENDING);

		await manager.handleClaudeMessage(childSessionId, result("Waiting on CI."));

		expect(resumeParentSession).not.toHaveBeenCalled();
	});

	it("resumes the parent exactly once, on the final result", async () => {
		setup(null);

		await manager.handleClaudeMessage(childSessionId, result("All done."));

		expect(resumeParentSession).toHaveBeenCalledOnce();
		expect(resumeParentSession).toHaveBeenCalledWith(
			parentSessionId,
			expect.stringContaining("All done."),
			childSessionId,
		);
	});
});
