import type { CyrusAgentSession } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import { ProcedureAnalyzer } from "../src/procedures/ProcedureAnalyzer";
import { PROCEDURES } from "../src/procedures/registry";

/**
 * Integration tests for procedure routing as used by EdgeWorker and AgentSessionManager
 * These tests verify the actual flow of procedure routing in production
 */

describe("EdgeWorker - Procedure Routing Integration", () => {
	let procedureAnalyzer: ProcedureAnalyzer;
	let agentSessionManager: AgentSessionManager;
	let mockLinearClient: any;

	beforeEach(() => {
		// Create ProcedureAnalyzer
		procedureAnalyzer = new ProcedureAnalyzer({
			cyrusHome: "/test/.cyrus",
		});

		// Create minimal mock Linear client
		mockLinearClient = {
			createAgentActivity: vi.fn().mockResolvedValue({
				success: true,
				agentActivity: Promise.resolve({ id: "activity-123" }),
			}),
		};

		// Create AgentSessionManager with procedure router
		agentSessionManager = new AgentSessionManager(
			mockLinearClient,
			undefined, // getParentSessionId
			undefined, // resumeParentSession
			procedureAnalyzer,
		);
	});

	describe("Full Workflow: Procedure Execution → Completion", () => {
		it("should handle full-development procedure end-to-end", async () => {
			// Step 1: Use full-development procedure directly (skip AI classification for deterministic tests)
			const fullDevProcedure = PROCEDURES["full-development"];

			// Step 2: EdgeWorker creates session and initializes procedure metadata
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-123",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-123",
				issue: {
					id: "issue-123",
					identifier: "TEST-1",
					title: "Test Issue",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-123",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, fullDevProcedure);

			// Verify initial state
			expect(session.metadata.procedure).toBeDefined();
			expect(session.metadata.procedure?.procedureName).toBe(
				"full-development",
			);
			expect(session.metadata.procedure?.currentSubroutineIndex).toBe(0);

			// Step 3: Execute coding-activity subroutine (manually simulated completion)
			let currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("coding-activity");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 4: coding-activity completes, AgentSessionManager checks for next subroutine
			let nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine).toBeDefined();
			expect(nextSubroutine?.name).toBe("verifications");

			// Step 5: AgentSessionManager advances to next subroutine
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123");
			expect(session.metadata.procedure?.currentSubroutineIndex).toBe(1);

			// Step 6: Execute verifications subroutine
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("verifications");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 7: Verifications completes, advance to changelog-update
			// full-development: coding-activity → verifications → changelog-update → git-commit → gh-pr → concise-summary
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("changelog-update");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123");

			// Step 8: Execute changelog-update subroutine
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("changelog-update");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 9: changelog-update completes, advance to git-commit
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("git-commit");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123");

			// Step 10: Execute git-commit subroutine
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("git-commit");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 11: git-commit completes, advance to gh-pr
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("gh-pr");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123");

			// Step 12: Execute gh-pr subroutine
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("gh-pr");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 13: gh-pr completes, advance to concise-summary (last subroutine)
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("concise-summary");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123");

			// Step 14: Execute concise-summary (with thought suppression!)
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("concise-summary");
			expect(currentSubroutine?.suppressThoughtPosting).toBe(true); // Suppression active!

			// Step 15: Check that we're at the last subroutine
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine).toBeNull(); // No more subroutines
			expect(procedureAnalyzer.isProcedureComplete(session)).toBe(true);

			// Verify subroutine history (only 5 recorded because we're still AT concise-summary)
			// History only records completed subroutines when advancing AWAY from them
			expect(session.metadata.procedure?.subroutineHistory).toHaveLength(5);
			expect(session.metadata.procedure?.subroutineHistory[0].subroutine).toBe(
				"coding-activity",
			);
			expect(session.metadata.procedure?.subroutineHistory[1].subroutine).toBe(
				"verifications",
			);
			expect(session.metadata.procedure?.subroutineHistory[2].subroutine).toBe(
				"changelog-update",
			);
			expect(session.metadata.procedure?.subroutineHistory[3].subroutine).toBe(
				"git-commit",
			);
			expect(session.metadata.procedure?.subroutineHistory[4].subroutine).toBe(
				"gh-pr",
			);
			// concise-summary is NOT yet in history because we haven't advanced away from it
		});

		it("should handle documentation-edit procedure with correct suppressions", async () => {
			// Step 1: Use documentation-edit procedure directly (skip AI classification)
			const docEditProcedure = PROCEDURES["documentation-edit"];

			// Step 2: Create and initialize session
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-456",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-456",
				issue: {
					id: "issue-456",
					identifier: "TEST-2",
					title: "Update README",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-456",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, docEditProcedure);

			// Step 3: Execute primary (no suppression)
			let currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("primary");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 4: Advance to git-commit (no suppression)
			let nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("git-commit");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-456");

			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("git-commit");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 5: Advance to gh-pr (no suppression)
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("gh-pr");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-456");

			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("gh-pr");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 6: Advance to concise-summary (WITH suppression)
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("concise-summary");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-456");

			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("concise-summary");
			expect(currentSubroutine?.suppressThoughtPosting).toBe(true); // Suppression!

			// Step 7: Procedure complete
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine).toBeNull();
			expect(procedureAnalyzer.isProcedureComplete(session)).toBe(true);
		});

		it("should handle simple-question procedure with minimal workflow", async () => {
			// Step 1: Use simple-question procedure directly (skip AI classification)
			const simpleQuestionProcedure = PROCEDURES["simple-question"];

			// Step 2: Create and initialize session
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-789",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-789",
				issue: {
					id: "issue-789",
					identifier: "TEST-3",
					title: "Test Coverage Question",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-789",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(
				session,
				simpleQuestionProcedure,
			);

			// Step 3: Execute question-investigation (no suppression)
			let currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("question-investigation");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();

			// Step 4: Advance to question-answer (WITH suppression)
			let nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine?.name).toBe("question-answer");
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-789");

			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("question-answer");
			expect(currentSubroutine?.suppressThoughtPosting).toBe(true);

			// Step 5: Procedure complete
			nextSubroutine = procedureAnalyzer.getNextSubroutine(session);
			expect(nextSubroutine).toBeNull();
			expect(procedureAnalyzer.isProcedureComplete(session)).toBe(true);
		});
	});

	describe("Thought/Action Suppression in AgentSessionManager", () => {
		it("should suppress thoughts during question-answer subroutine", async () => {
			// Create a session already at question-answer
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-suppress-1",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-suppress-1",
				issue: {
					id: "issue-suppress-1",
					identifier: "TEST-SUPPRESS-1",
					title: "Test Suppression",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-suppress-1",
				metadata: {
					procedure: {
						procedureName: "simple-question",
						currentSubroutineIndex: 1, // question-answer
						subroutineHistory: [],
					},
				},
			};

			// Register session with AgentSessionManager
			agentSessionManager.sessions.set("session-suppress-1", session as any);

			// Verify suppression is active
			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("question-answer");
			expect(currentSubroutine?.suppressThoughtPosting).toBe(true);

			// The AgentSessionManager.syncEntryToLinear method checks this flag
			// and skips posting thoughts/actions when suppressThoughtPosting is true
		});

		it("should NOT suppress thoughts during coding-activity subroutine", async () => {
			// Create a session at coding-activity
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-no-suppress",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-no-suppress",
				issue: {
					id: "issue-no-suppress",
					identifier: "TEST-NO-SUPPRESS",
					title: "Test No Suppression",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-no-suppress",
				metadata: {
					procedure: {
						procedureName: "full-development",
						currentSubroutineIndex: 0, // coding-activity
						subroutineHistory: [],
					},
				},
			};

			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("coding-activity");
			expect(currentSubroutine?.suppressThoughtPosting).toBeUndefined();
		});
	});

	describe("Procedure State Reset for New Issues", () => {
		it("should initialize fresh procedure metadata for each new session", async () => {
			// First session
			const session1: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-1",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-1",
				issue: {
					id: "issue-1",
					identifier: "TEST-1",
					title: "First Issue",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-1",
				metadata: {},
			};

			const procedure1 = PROCEDURES["full-development"];
			procedureAnalyzer.initializeProcedureMetadata(session1, procedure1);

			// Advance through some subroutines
			procedureAnalyzer.advanceToNextSubroutine(session1, "claude-1");
			procedureAnalyzer.advanceToNextSubroutine(session1, "claude-1");

			expect(session1.metadata.procedure?.currentSubroutineIndex).toBe(2);
			expect(session1.metadata.procedure?.subroutineHistory).toHaveLength(2);

			// Second session (simulating new issue/comment)
			const session2: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-2",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-2",
				issue: {
					id: "issue-2",
					identifier: "TEST-2",
					title: "Second Issue",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-2",
				metadata: {},
			};

			const procedure2 = PROCEDURES["simple-question"];
			procedureAnalyzer.initializeProcedureMetadata(session2, procedure2);

			// Verify session2 has fresh state
			expect(session2.metadata.procedure?.procedureName).toBe(
				"simple-question",
			);
			expect(session2.metadata.procedure?.currentSubroutineIndex).toBe(0);
			expect(session2.metadata.procedure?.subroutineHistory).toHaveLength(0);

			// Verify session1 state is unchanged
			expect(session1.metadata.procedure?.currentSubroutineIndex).toBe(2);
			expect(session1.metadata.procedure?.subroutineHistory).toHaveLength(2);
		});
	});

	describe("Procedure Routing on New Comments", () => {
		it("should route fresh procedure for each new comment in same session", async () => {
			// Simulate an existing session that has a procedure already running
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-routing-test",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-routing",
				issue: {
					id: "issue-routing",
					identifier: "TEST-ROUTING",
					title: "Test Routing",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-routing",
				metadata: {
					procedure: {
						procedureName: "full-development",
						currentSubroutineIndex: 2, // Mid-procedure
						subroutineHistory: [
							{
								subroutine: "primary",
								completedAt: Date.now(),
								claudeSessionId: "claude-routing",
							},
							{
								subroutine: "verifications",
								completedAt: Date.now(),
								claudeSessionId: "claude-routing",
							},
						],
					},
				},
			};

			// Verify initial state
			expect(session.metadata.procedure?.procedureName).toBe(
				"full-development",
			);
			expect(session.metadata.procedure?.currentSubroutineIndex).toBe(2);
			expect(session.metadata.procedure?.subroutineHistory).toHaveLength(2);

			// Now simulate a new comment arriving (EdgeWorker would route this)
			// In the new behavior, initializeProcedureMetadata is called again
			const newProcedure = PROCEDURES["simple-question"];
			procedureAnalyzer.initializeProcedureMetadata(session, newProcedure);

			// Verify procedure was reset to the new one
			expect(session.metadata.procedure?.procedureName).toBe("simple-question");
			expect(session.metadata.procedure?.currentSubroutineIndex).toBe(0);
			expect(session.metadata.procedure?.subroutineHistory).toHaveLength(0);

			// This demonstrates that each new comment gets fresh procedure routing
			// rather than continuing the old procedure
		});
	});

	describe("Subroutine Result Storage", () => {
		it("should store result text in subroutineHistory when advancing", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-result-1",
				externalSessionId: "session-result-1",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-result-1",
					issueIdentifier: "TEST-RESULT-1",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-result-1",
				issue: {
					id: "issue-result-1",
					identifier: "TEST-RESULT-1",
					title: "Test Result Storage",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-result-1",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// Advance with a result
			procedureAnalyzer.advanceToNextSubroutine(
				session,
				"claude-result-1",
				"Here is the coding result",
			);

			expect(session.metadata.procedure?.subroutineHistory).toHaveLength(1);
			expect(session.metadata.procedure?.subroutineHistory[0].result).toBe(
				"Here is the coding result",
			);

			// Advance again with a different result
			procedureAnalyzer.advanceToNextSubroutine(
				session,
				"claude-result-1",
				"Verifications passed",
			);

			expect(session.metadata.procedure?.subroutineHistory).toHaveLength(2);
			expect(session.metadata.procedure?.subroutineHistory[1].result).toBe(
				"Verifications passed",
			);
		});

		it("should not include result in history when no result is provided", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-no-result",
				externalSessionId: "session-no-result",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-no-result",
					issueIdentifier: "TEST-NO-RESULT",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-no-result",
				issue: {
					id: "issue-no-result",
					identifier: "TEST-NO-RESULT",
					title: "Test No Result",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-no-result",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// Advance without a result (existing behavior)
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-no-result");

			expect(session.metadata.procedure?.subroutineHistory).toHaveLength(1);
			expect(
				session.metadata.procedure?.subroutineHistory[0].result,
			).toBeUndefined();
		});
	});

	describe("getLastSubroutineResult", () => {
		it("should return the result from the last completed subroutine", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-last-result",
				externalSessionId: "session-last-result",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-last-result",
					issueIdentifier: "TEST-LAST-RESULT",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-last-result",
				issue: {
					id: "issue-last-result",
					identifier: "TEST-LAST-RESULT",
					title: "Test Last Result",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-last-result",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// Advance with results
			procedureAnalyzer.advanceToNextSubroutine(
				session,
				"claude-last-result",
				"First result",
			);
			procedureAnalyzer.advanceToNextSubroutine(
				session,
				"claude-last-result",
				"Second result",
			);

			const lastResult = procedureAnalyzer.getLastSubroutineResult(session);
			expect(lastResult).toBe("Second result");
		});

		it("should return null when no subroutines have been completed", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-empty-result",
				externalSessionId: "session-empty-result",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-empty-result",
					issueIdentifier: "TEST-EMPTY-RESULT",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-empty-result",
				issue: {
					id: "issue-empty-result",
					identifier: "TEST-EMPTY-RESULT",
					title: "Test Empty Result",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-empty-result",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			const lastResult = procedureAnalyzer.getLastSubroutineResult(session);
			expect(lastResult).toBeNull();
		});

		it("should return null when session has no procedure metadata", () => {
			const session: CyrusAgentSession = {
				id: "session-no-procedure",
				externalSessionId: "session-no-procedure",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-no-procedure",
					issueIdentifier: "TEST-NO-PROCEDURE",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-no-procedure",
				issue: {
					id: "issue-no-procedure",
					identifier: "TEST-NO-PROCEDURE",
					title: "Test No Procedure",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-no-procedure",
				metadata: {},
			};

			const lastResult = procedureAnalyzer.getLastSubroutineResult(session);
			expect(lastResult).toBeNull();
		});

		it("should return null when last subroutine has no result stored", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-no-stored-result",
				externalSessionId: "session-no-stored-result",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-no-stored-result",
					issueIdentifier: "TEST-NO-STORED",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-no-stored-result",
				issue: {
					id: "issue-no-stored-result",
					identifier: "TEST-NO-STORED",
					title: "Test No Stored Result",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-no-stored-result",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// Advance without providing a result
			procedureAnalyzer.advanceToNextSubroutine(
				session,
				"claude-no-stored-result",
			);

			const lastResult = procedureAnalyzer.getLastSubroutineResult(session);
			expect(lastResult).toBeNull();
		});
	});

	describe("Error Handling", () => {
		it("should handle errors during procedure execution gracefully", () => {
			const session: CyrusAgentSession = {
				linearAgentActivitySessionId: "session-error",
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-error",
				issue: {
					id: "issue-error",
					identifier: "TEST-ERROR",
					title: "Error Test",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-error",
				metadata: {},
			};

			// Attempting to get current subroutine without initialization should return null
			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine).toBeNull();

			// Attempting to advance without initialization should throw
			expect(() => {
				procedureAnalyzer.advanceToNextSubroutine(session, "claude-error");
			}).toThrow("Cannot advance: session has no procedure metadata");
		});
	});
});
