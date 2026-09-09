/**
 * Tests for PersistenceManager migrations (v2.0 → v3.0 → v4.0)
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	PERSISTENCE_VERSION,
	PersistenceManager,
} from "../src/PersistenceManager.js";

// Mock fs modules
vi.mock("node:fs", () => ({
	existsSync: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(),
	readFile: vi.fn(),
	rename: vi.fn(),
	writeFile: vi.fn(),
}));

describe("PersistenceManager", () => {
	let persistenceManager: PersistenceManager;

	beforeEach(() => {
		vi.clearAllMocks();
		persistenceManager = new PersistenceManager("/tmp/test-cyrus");
	});

	describe("v2.0 to v4.0 Migration (via v3.0)", () => {
		const v2State = {
			version: "2.0",
			savedAt: "2025-01-15T12:00:00.000Z",
			state: {
				agentSessions: {
					"repo-1": {
						"linear-session-123": {
							linearAgentActivitySessionId: "linear-session-123",
							type: "comment-thread",
							status: "active",
							context: "comment-thread",
							createdAt: 1705320000000,
							updatedAt: 1705320000000,
							issueId: "issue-456",
							issue: {
								id: "issue-456",
								identifier: "TEST-123",
								title: "Test Issue",
								branchName: "test-branch",
							},
							workspace: {
								path: "/tmp/worktree",
								isGitWorktree: true,
							},
							claudeSessionId: "claude-789",
						},
					},
				},
				agentSessionEntries: {
					"repo-1": {
						"linear-session-123": [
							{
								type: "user",
								content: "Hello",
								metadata: { timestamp: 1705320000000 },
							},
						],
					},
				},
				childToParentAgentSession: {
					"child-session": "parent-session",
				},
				issueRepositoryCache: {
					"issue-456": "repo-1",
				},
			},
		};

		it("should migrate v2.0 state through v3.0 to v4.0 flat format", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v2State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeDefined();
			expect(result!.agentSessions).toBeDefined();

			// v4.0: sessions are flat (keyed by sessionId, not nested under repoId)
			const migratedSession = result!.agentSessions!["linear-session-123"];
			expect(migratedSession).toBeDefined();

			// Should have new id field (from v2→v3 migration)
			expect(migratedSession.id).toBe("linear-session-123");

			// Should have externalSessionId
			expect(migratedSession.externalSessionId).toBe("linear-session-123");

			// Should have issueContext
			expect(migratedSession.issueContext).toEqual({
				trackerId: "linear",
				issueId: "issue-456",
				issueIdentifier: "TEST-123",
			});

			// Should preserve issueId for backwards compatibility
			expect(migratedSession.issueId).toBe("issue-456");

			// Should preserve issue object
			expect(migratedSession.issue).toEqual({
				id: "issue-456",
				identifier: "TEST-123",
				title: "Test Issue",
				branchName: "test-branch",
			});

			// Should preserve other fields
			expect(migratedSession.claudeSessionId).toBe("claude-789");
			expect(migratedSession.workspace.path).toBe("/tmp/worktree");

			// Should have repositories populated from the repo key during v3→v4 flattening
			expect(migratedSession.repositories).toEqual([
				{ repositoryId: "repo-1" },
			]);
		});

		it("should save migrated state as v4.0", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v2State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			await persistenceManager.loadEdgeWorkerState();

			// Verify writeFile was called with v4.0 version
			expect(writeFile).toHaveBeenCalled();
			const savedData = JSON.parse(
				vi.mocked(writeFile).mock.calls[0][1] as string,
			);
			expect(savedData.version).toBe(PERSISTENCE_VERSION);
		});

		it("should flatten entries and preserve mappings during v2→v4 migration", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v2State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			const result = await persistenceManager.loadEdgeWorkerState();

			// Entries should be flattened (keyed by sessionId, not nested under repoId)
			expect(result!.agentSessionEntries!["linear-session-123"]).toEqual([
				{
					type: "user",
					content: "Hello",
					metadata: { timestamp: 1705320000000 },
				},
			]);

			// Check child-to-parent mappings are preserved
			expect(result!.childToParentAgentSession).toEqual(
				v2State.state.childToParentAgentSession,
			);

			// Check issue repository cache is migrated to string[] format
			expect(result!.issueRepositoryCache).toEqual({
				"issue-456": ["repo-1"],
			});
		});

		it("should return null for unknown version", async () => {
			const unknownVersionState = {
				version: "99.0",
				savedAt: "2025-01-15T12:00:00.000Z",
				state: {},
			};

			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(
				JSON.stringify(unknownVersionState),
			);

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeNull();
		});

		it("should return null for invalid state structure", async () => {
			const invalidState = {
				version: "2.0",
				savedAt: "2025-01-15T12:00:00.000Z",
				// Missing state property
			};

			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(invalidState));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeNull();
		});
	});

	describe("v3.0 to v4.0 Migration", () => {
		const v3State = {
			version: "3.0",
			savedAt: "2025-01-15T12:00:00.000Z",
			state: {
				agentSessions: {
					"repo-1": {
						"session-123": {
							id: "session-123",
							externalSessionId: "session-123",
							issueContext: {
								trackerId: "linear",
								issueId: "issue-456",
								issueIdentifier: "TEST-123",
							},
							issueId: "issue-456",
							workspace: { path: "/tmp/worktree", isGitWorktree: true },
						},
					},
					"repo-2": {
						"session-456": {
							id: "session-456",
							externalSessionId: "session-456",
							issueContext: {
								trackerId: "linear",
								issueId: "issue-789",
								issueIdentifier: "OTHER-1",
							},
							issueId: "issue-789",
							workspace: { path: "/tmp/worktree2", isGitWorktree: false },
						},
					},
				},
				agentSessionEntries: {
					"repo-1": {
						"session-123": [{ type: "user", content: "Hello from repo-1" }],
					},
					"repo-2": {
						"session-456": [{ type: "user", content: "Hello from repo-2" }],
					},
				},
				childToParentAgentSession: {
					"child-1": "parent-1",
				},
				issueRepositoryCache: {
					"issue-456": "repo-1",
					"issue-789": "repo-2",
				},
			},
		};

		it("should flatten nested sessions from multiple repos into a flat map", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v3State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toBeDefined();

			// Sessions should be flat (no repo nesting)
			expect(result!.agentSessions!["session-123"]).toBeDefined();
			expect(result!.agentSessions!["session-456"]).toBeDefined();

			// Verify session content
			expect(result!.agentSessions!["session-123"].issueContext).toEqual({
				trackerId: "linear",
				issueId: "issue-456",
				issueIdentifier: "TEST-123",
			});
			expect(result!.agentSessions!["session-456"].issueContext).toEqual({
				trackerId: "linear",
				issueId: "issue-789",
				issueIdentifier: "OTHER-1",
			});
		});

		it("should populate repositories from repo key during flattening", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v3State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			const result = await persistenceManager.loadEdgeWorkerState();

			// Sessions should get their repository context from the repo key they were nested under
			expect(result!.agentSessions!["session-123"].repositories).toEqual([
				{ repositoryId: "repo-1" },
			]);
			expect(result!.agentSessions!["session-456"].repositories).toEqual([
				{ repositoryId: "repo-2" },
			]);
		});

		it("should flatten nested entries from multiple repos", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v3State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			const result = await persistenceManager.loadEdgeWorkerState();

			// Entries should be flat
			expect(result!.agentSessionEntries!["session-123"]).toEqual([
				{ type: "user", content: "Hello from repo-1" },
			]);
			expect(result!.agentSessionEntries!["session-456"]).toEqual([
				{ type: "user", content: "Hello from repo-2" },
			]);
		});

		it("should preserve childToParentAgentSession and issueRepositoryCache", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v3State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result!.childToParentAgentSession).toEqual({
				"child-1": "parent-1",
			});
			// Cache migrated from old string format to string[]
			expect(result!.issueRepositoryCache).toEqual({
				"issue-456": ["repo-1"],
				"issue-789": ["repo-2"],
			});
		});

		it("should save migrated v3→v4 state with correct version", async () => {
			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v3State));
			vi.mocked(writeFile).mockResolvedValue(undefined);
			vi.mocked(mkdir).mockResolvedValue(undefined);

			await persistenceManager.loadEdgeWorkerState();

			expect(writeFile).toHaveBeenCalled();
			const savedData = JSON.parse(
				vi.mocked(writeFile).mock.calls[0][1] as string,
			);
			expect(savedData.version).toBe("4.0");
		});
	});

	describe("v4.0 state (current)", () => {
		it("should load v4.0 state without migration", async () => {
			const v4State = {
				version: "4.0",
				savedAt: "2025-01-15T12:00:00.000Z",
				state: {
					agentSessions: {
						"session-123": {
							id: "session-123",
							externalSessionId: "session-123",
							issueContext: {
								trackerId: "linear",
								issueId: "issue-456",
								issueIdentifier: "TEST-123",
							},
						},
					},
				},
			};

			vi.mocked(existsSync).mockReturnValue(true);
			vi.mocked(readFile).mockResolvedValue(JSON.stringify(v4State));

			const result = await persistenceManager.loadEdgeWorkerState();

			expect(result).toEqual(v4State.state);
			// Should not call writeFile since no migration needed
			expect(writeFile).not.toHaveBeenCalled();
		});
	});

	describe("PERSISTENCE_VERSION constant", () => {
		it("should be 4.0", () => {
			expect(PERSISTENCE_VERSION).toBe("4.0");
		});
	});
});
