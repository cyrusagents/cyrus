import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { HandoffService } from "../src/HandoffService.js";

vi.mock("../src/SharedApplicationServer.js");

function makeRunner(running: boolean) {
	return {
		isRunning: vi.fn().mockReturnValue(running),
		stop: vi.fn(),
		constructor: { name: "ClaudeRunner" },
	};
}

function makeRepo() {
	return {
		id: "r1",
		name: "r1",
		repositoryPath: "/repo",
		workspaceBaseDir: "/ws",
		baseBranch: "main",
		linearWorkspaceId: "w1",
		isActive: true,
	} as any;
}

function makeWebhook() {
	return {
		organizationId: "w1",
		agentSession: { id: "sess-1", issue: { id: "issue-1" } },
		agentActivity: { content: { body: "/handoff codex" } },
	} as any;
}

// Build a partially-real EdgeWorker: bypass the constructor and attach only the
// collaborators handleHandoffCommand touches.
function makeEdgeWorker(session: any) {
	const ew: any = Object.create(EdgeWorker.prototype);
	const reader = {
		getCurrentBranch: () => "CYR-1",
		getStatus: () => " M a.ts",
		getRecentCommits: () => "abc c1",
		getDiffSummary: () => " a.ts | 1 +",
		getOpenPrUrl: () => undefined,
	};
	ew.handoffService = new HandoffService(reader);
	ew.logger = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		withContext: vi.fn().mockReturnThis(),
	};
	ew.agentSessionManager = {
		getSession: vi.fn().mockReturnValue(session),
		getLastAssistantBody: vi.fn().mockReturnValue("prev summary"),
		clearRunnerSessionBindings: vi.fn(),
		requestSessionStop: vi.fn(),
		createResponseActivity: vi.fn().mockResolvedValue(undefined),
	};
	ew.resumeAgentSession = vi.fn().mockResolvedValue(undefined);
	return ew;
}

describe("EdgeWorker.handleHandoffCommand", () => {
	it("stops the active claude runner and starts codex in the same worktree", async () => {
		const runner = makeRunner(false); // already stopped after stop()
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-x",
			agentRunner: runner,
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "keep going",
		});

		// Source stopped
		expect(ew.agentSessionManager.requestSessionStop).toHaveBeenCalledWith(
			"sess-1",
		);
		expect(runner.stop).toHaveBeenCalled();
		// Bindings cleared so future routing follows codex
		expect(
			ew.agentSessionManager.clearRunnerSessionBindings,
		).toHaveBeenCalledWith("sess-1");
		// Target started via resume with the override + same worktree session
		expect(ew.resumeAgentSession).toHaveBeenCalledTimes(1);
		const callArgs = ew.resumeAgentSession.mock.calls[0];
		expect(callArgs[0]).toBe(session); // same session => same worktree
		expect(callArgs[callArgs.length - 1]).toBe("codex"); // runnerTypeOverride
		const promptArg = callArgs[4];
		expect(promptArg).toContain("<handoff_context>");
		expect(promptArg).toContain("keep going");
	});

	it("blocks handoff when the active runner never stops", async () => {
		const runner = makeRunner(true); // stays running forever
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-x",
			agentRunner: runner,
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);
		// Make the poll resolve instantly and time out quickly.
		ew.handoffService.waitForStopped = vi.fn().mockResolvedValue(false);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "",
		});

		expect(ew.agentSessionManager.createResponseActivity).toHaveBeenCalledWith(
			"sess-1",
			expect.stringContaining("blocked"),
		);
		expect(ew.resumeAgentSession).not.toHaveBeenCalled();
	});

	it("rejects an unknown target with an error comment", async () => {
		const session = {
			id: "sess-1",
			claudeSessionId: "claude-x",
			agentRunner: makeRunner(false),
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: null,
			rawTarget: "gemini",
			remainder: "",
		});

		expect(ew.agentSessionManager.createResponseActivity).toHaveBeenCalledWith(
			"sess-1",
			expect.stringContaining("gemini"),
		);
		expect(ew.resumeAgentSession).not.toHaveBeenCalled();
	});

	it("no-ops when the target equals the current runner", async () => {
		const session = {
			id: "sess-1",
			codexSessionId: "codex-x",
			agentRunner: makeRunner(false),
			workspace: { path: "/ws/CYR-1" },
		};
		const ew = makeEdgeWorker(session);

		await ew.handleHandoffCommand(makeWebhook(), [makeRepo()], {
			targetRunner: "codex",
			rawTarget: "codex",
			remainder: "",
		});

		expect(ew.resumeAgentSession).not.toHaveBeenCalled();
		expect(ew.agentSessionManager.createResponseActivity).toHaveBeenCalledWith(
			"sess-1",
			expect.stringContaining("Already running"),
		);
	});
});
