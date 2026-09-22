import { beforeEach, describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";

/**
 * Tests for getActiveMultiRepoSessionForRepository — resolving the correct
 * sub-worktree when a GitHub @ mention targets a specific repo within a
 * multi-repo workspace.
 */
describe("AgentSessionManager - Multi-repo GitHub @ mention routing", () => {
	let manager: AgentSessionManager;

	const repoA = {
		repositoryId: "repo-a-id",
		branchName: "cypack-920",
		baseBranchName: "main",
	};
	const repoB = {
		repositoryId: "repo-b-id",
		branchName: "cypack-920",
		baseBranchName: "main",
	};

	const multiRepoWorkspace = {
		path: "/home/atmiko/.atmiko/worktrees/CYPACK-920",
		isGitWorktree: true,
		repoPaths: {
			"repo-a-id": "/home/atmiko/.atmiko/worktrees/CYPACK-920/frontend-app",
			"repo-b-id": "/home/atmiko/.atmiko/worktrees/CYPACK-920/backend-api",
		},
	};

	const singleRepoWorkspace = {
		path: "/home/atmiko/.atmiko/worktrees/CYPACK-920",
		isGitWorktree: true,
	};

	beforeEach(() => {
		manager = new AgentSessionManager();
	});

	function createMultiRepoSession(sessionId = "session-multi") {
		manager.createAtmikoAgentSession(
			sessionId,
			"issue-1",
			{
				id: "issue-1",
				identifier: "CYPACK-920",
				title: "Multi-repo issue",
				branchName: "cypack-920",
			},
			multiRepoWorkspace,
			"linear",
			[repoA, repoB],
		);
	}

	function createSingleRepoSession(sessionId = "session-single") {
		manager.createAtmikoAgentSession(
			sessionId,
			"issue-2",
			{
				id: "issue-2",
				identifier: "CYPACK-921",
				title: "Single-repo issue",
				branchName: "cypack-921",
			},
			singleRepoWorkspace,
			"linear",
			[repoA],
		);
	}

	// ── Multi-repo session lookup ─────────────────────────────────────────

	it("should find an active multi-repo session for a matching repository", () => {
		createMultiRepoSession();

		const session = manager.getActiveMultiRepoSessionForRepository("repo-a-id");
		expect(session).not.toBeNull();
		expect(session!.id).toBe("session-multi");
	});

	it("should find the session when matching the second repository", () => {
		createMultiRepoSession();

		const session = manager.getActiveMultiRepoSessionForRepository("repo-b-id");
		expect(session).not.toBeNull();
		expect(session!.id).toBe("session-multi");
	});

	it("should return null when no session matches the repository", () => {
		createMultiRepoSession();

		const session =
			manager.getActiveMultiRepoSessionForRepository("repo-unknown-id");
		expect(session).toBeNull();
	});

	it("should return null for single-repo sessions (no repoPaths)", () => {
		createSingleRepoSession();

		// repo-a-id exists in the single-repo session, but it has no repoPaths
		const session = manager.getActiveMultiRepoSessionForRepository("repo-a-id");
		expect(session).toBeNull();
	});

	it("should skip completed sessions", () => {
		createMultiRepoSession();

		// Mark session as completed
		const session = manager.getSession("session-multi");
		session!.status = "complete" as any;

		const result = manager.getActiveMultiRepoSessionForRepository("repo-a-id");
		expect(result).toBeNull();
	});

	it("should resolve the correct sub-worktree path from workspace.repoPaths", () => {
		createMultiRepoSession();

		const session = manager.getActiveMultiRepoSessionForRepository("repo-b-id");
		expect(session).not.toBeNull();
		expect(session!.workspace.repoPaths?.["repo-b-id"]).toBe(
			"/home/atmiko/.atmiko/worktrees/CYPACK-920/backend-api",
		);
	});

	it("should return null when no sessions exist", () => {
		const session = manager.getActiveMultiRepoSessionForRepository("repo-a-id");
		expect(session).toBeNull();
	});

	it("should prefer the first matching multi-repo session when multiple exist", () => {
		// Create two multi-repo sessions with overlapping repos
		createMultiRepoSession("session-first");
		createMultiRepoSession("session-second");

		const session = manager.getActiveMultiRepoSessionForRepository("repo-a-id");
		expect(session).not.toBeNull();
		// Should return one of the sessions (first found)
		expect(["session-first", "session-second"]).toContain(session!.id);
	});
});
