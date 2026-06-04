import type { SDKSystemMessage } from "cyrus-claude-runner";
import { beforeEach, describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";

/**
 * The durable per-issue "last session" record lets a newly-created agent
 * session on an issue resume the prior runner conversation even after the live
 * session has been pruned (e.g. when the issue went terminal/unassigned).
 */
describe("AgentSessionManager - issueLastSession durable record", () => {
	let manager: AgentSessionManager;
	const sessionId = "session-1";
	const issueId = "issue-1";

	const systemInit: SDKSystemMessage = {
		type: "system",
		subtype: "init",
		session_id: "claude-abc",
		model: "opus",
		tools: [],
		permissionMode: "allowed_tools",
		apiKeySource: "claude_desktop",
	};

	beforeEach(() => {
		manager = new AgentSessionManager();
		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-1",
				title: "Test",
				description: "",
				branchName: "test-branch",
			},
			{ path: "/worktrees/TEST-1", isGitWorktree: true },
		);
	});

	it("records the claude session id (and workspace) for the issue on init", async () => {
		await manager.handleClaudeMessage(sessionId, systemInit);

		const record = manager.getLastSessionForIssue(issueId);
		expect(record?.claudeSessionId).toBe("claude-abc");
		expect(record?.workspacePath).toBe("/worktrees/TEST-1");
		expect(record?.updatedAt).toBeGreaterThan(0);
	});

	it("survives removeSession() so a re-delegation can still resume", async () => {
		await manager.handleClaudeMessage(sessionId, systemInit);

		manager.removeSession(sessionId);

		// Live session is gone...
		expect(manager.getSession(sessionId)).toBeUndefined();
		expect(manager.getSessionsByIssueId(issueId)).toHaveLength(0);
		// ...but the durable record remains.
		expect(manager.getLastSessionForIssue(issueId)?.claudeSessionId).toBe(
			"claude-abc",
		);
	});

	it("round-trips through serializeState()/restoreState()", async () => {
		await manager.handleClaudeMessage(sessionId, systemInit);

		const serialized = manager.serializeState();
		expect(serialized.issueLastSession[issueId]?.claudeSessionId).toBe(
			"claude-abc",
		);

		const restored = new AgentSessionManager();
		restored.restoreState(
			serialized.sessions,
			serialized.entries,
			serialized.issueLastSession,
		);
		expect(restored.getLastSessionForIssue(issueId)?.claudeSessionId).toBe(
			"claude-abc",
		);
	});

	it("returns undefined for an issue with no prior session", () => {
		expect(manager.getLastSessionForIssue("unknown-issue")).toBeUndefined();
	});
});
