/**
 * Tests for subroutine-level tool disabling functionality
 *
 * Verifies that summary subroutines (concise-summary, verbose-summary,
 * question-answer, plan-summary, etc.) properly disable all tools
 * to prevent the agent from appearing to "hang" in Linear.
 */

import type { CyrusAgentSession } from "cyrus-core";
import { beforeEach, describe, expect, it } from "vitest";
import { ProcedureAnalyzer } from "../src/procedures/ProcedureAnalyzer";
import { PROCEDURES, SUBROUTINES } from "../src/procedures/registry";

describe("EdgeWorker - Subroutine Tool Disabling", () => {
	let procedureAnalyzer: ProcedureAnalyzer;

	beforeEach(() => {
		procedureAnalyzer = new ProcedureAnalyzer({
			cyrusHome: "/test/.cyrus",
		});
	});

	describe("Summary Subroutines Configuration", () => {
		it("should have disallowAllTools: true configured for concise-summary", () => {
			const subroutine = SUBROUTINES.conciseSummary;
			expect(subroutine.disallowAllTools).toBe(true);
			expect(subroutine.singleTurn).toBe(true);
			expect(subroutine.suppressThoughtPosting).toBe(true);
		});

		it("should have disallowAllTools: true configured for verbose-summary", () => {
			const subroutine = SUBROUTINES.verboseSummary;
			expect(subroutine.disallowAllTools).toBe(true);
			expect(subroutine.singleTurn).toBe(true);
			expect(subroutine.suppressThoughtPosting).toBe(true);
		});

		it("should have disallowAllTools: true configured for question-answer", () => {
			const subroutine = SUBROUTINES.questionAnswer;
			expect(subroutine.disallowAllTools).toBe(true);
			expect(subroutine.singleTurn).toBe(true);
			expect(subroutine.suppressThoughtPosting).toBe(true);
		});

		it("should have disallowAllTools: true configured for plan-summary", () => {
			const subroutine = SUBROUTINES.planSummary;
			expect(subroutine.disallowAllTools).toBe(true);
			expect(subroutine.singleTurn).toBe(true);
			expect(subroutine.suppressThoughtPosting).toBe(true);
		});

		it("should have disallowAllTools: true configured for user-testing-summary", () => {
			const subroutine = SUBROUTINES.userTestingSummary;
			expect(subroutine.disallowAllTools).toBe(true);
			expect(subroutine.singleTurn).toBe(true);
			expect(subroutine.suppressThoughtPosting).toBe(true);
		});

		it("should have disallowAllTools: true configured for release-summary", () => {
			const subroutine = SUBROUTINES.releaseSummary;
			expect(subroutine.disallowAllTools).toBe(true);
			expect(subroutine.singleTurn).toBe(true);
			expect(subroutine.suppressThoughtPosting).toBe(true);
		});

		it("should NOT have disallowAllTools for non-summary subroutines", () => {
			// Verify that regular subroutines don't have disallowAllTools
			expect(SUBROUTINES.primary.disallowAllTools).toBeUndefined();
			expect(SUBROUTINES.codingActivity.disallowAllTools).toBeUndefined();
			expect(SUBROUTINES.verifications.disallowAllTools).toBeUndefined();
			expect(SUBROUTINES.gitCommit.disallowAllTools).toBeUndefined();
			expect(SUBROUTINES.ghPr.disallowAllTools).toBeUndefined();
			expect(SUBROUTINES.changelogUpdate.disallowAllTools).toBeUndefined();
			expect(
				SUBROUTINES.questionInvestigation.disallowAllTools,
			).toBeUndefined();
			expect(SUBROUTINES.preparation.disallowAllTools).toBeUndefined();
		});
	});

	describe("Procedure Integration", () => {
		it("should expose disallowAllTools when at concise-summary subroutine in full-development procedure", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-123",
				externalSessionId: "session-123",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-1",
				},
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
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-123",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// Advance to concise-summary (last subroutine)
			// full-development: coding-activity → verifications → changelog-update → git-commit → gh-pr → concise-summary
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123"); // Move to verifications
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123"); // Move to changelog-update
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123"); // Move to git-commit
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123"); // Move to gh-pr
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-123"); // Move to concise-summary

			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("concise-summary");
			expect(currentSubroutine?.disallowAllTools).toBe(true);
		});

		it("should expose disallowAllTools when at verbose-summary subroutine", () => {
			// Create a custom procedure with verbose-summary for testing
			const session: CyrusAgentSession = {
				id: "session-456",
				externalSessionId: "session-456",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-456",
					issueIdentifier: "TEST-2",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-456",
				issue: {
					id: "issue-456",
					identifier: "TEST-2",
					title: "Test Issue",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-456",
				metadata: {
					procedure: {
						procedureName: "test-verbose",
						currentSubroutineIndex: 0,
						subroutineHistory: [],
					},
				},
			};

			// Manually register a procedure with verbose-summary
			procedureAnalyzer.registerProcedure({
				name: "test-verbose",
				description: "Test procedure with verbose summary",
				subroutines: [SUBROUTINES.verboseSummary],
			});

			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("verbose-summary");
			expect(currentSubroutine?.disallowAllTools).toBe(true);
		});

		it("should expose disallowAllTools for question-answer in simple-question procedure", () => {
			const procedure = PROCEDURES["simple-question"];
			const session: CyrusAgentSession = {
				id: "session-789",
				externalSessionId: "session-789",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-789",
					issueIdentifier: "TEST-3",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-789",
				issue: {
					id: "issue-789",
					identifier: "TEST-3",
					title: "Test Question",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-789",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// simple-question: question-investigation → question-answer
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-789"); // Move to question-answer

			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("question-answer");
			expect(currentSubroutine?.disallowAllTools).toBe(true);
		});

		it("should expose disallowAllTools for plan-summary in plan-mode procedure", () => {
			const procedure = PROCEDURES["plan-mode"];
			const session: CyrusAgentSession = {
				id: "session-101",
				externalSessionId: "session-101",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-101",
					issueIdentifier: "TEST-4",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-101",
				issue: {
					id: "issue-101",
					identifier: "TEST-4",
					title: "Test Planning",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-101",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// plan-mode: preparation → plan-summary
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-101"); // Move to plan-summary

			const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("plan-summary");
			expect(currentSubroutine?.disallowAllTools).toBe(true);
		});

		it("should NOT expose disallowAllTools for non-summary subroutines", () => {
			const procedure = PROCEDURES["full-development"];
			const session: CyrusAgentSession = {
				id: "session-202",
				externalSessionId: "session-202",
				issueContext: {
					trackerId: "linear",
					issueId: "issue-202",
					issueIdentifier: "TEST-5",
				},
				type: "comment_thread" as const,
				status: "active" as const,
				context: "comment_thread" as const,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueId: "issue-202",
				issue: {
					id: "issue-202",
					identifier: "TEST-5",
					title: "Test Issue",
					branchName: "test-branch",
				},
				workspace: { path: "/test/workspace", isGitWorktree: false },
				claudeSessionId: "claude-202",
				metadata: {},
			};

			procedureAnalyzer.initializeProcedureMetadata(session, procedure);

			// full-development: coding-activity → verifications → changelog-update → git-commit → gh-pr → concise-summary

			// Check coding-activity (first subroutine)
			let currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("coding-activity");
			expect(currentSubroutine?.disallowAllTools).toBeUndefined();

			// Advance to verifications
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-202");
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("verifications");
			expect(currentSubroutine?.disallowAllTools).toBeUndefined();

			// Advance to changelog-update
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-202");
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("changelog-update");
			expect(currentSubroutine?.disallowAllTools).toBeUndefined();

			// Advance to git-commit
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-202");
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("git-commit");
			expect(currentSubroutine?.disallowAllTools).toBeUndefined();

			// Advance to gh-pr
			procedureAnalyzer.advanceToNextSubroutine(session, "claude-202");
			currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
			expect(currentSubroutine?.name).toBe("gh-pr");
			expect(currentSubroutine?.disallowAllTools).toBeUndefined();
		});
	});

	describe("Type Definitions", () => {
		it("should support disallowAllTools in SubroutineDefinition type", () => {
			// This is a compile-time test - if this compiles, the type supports disallowAllTools
			const testSubroutine: typeof SUBROUTINES.conciseSummary = {
				name: "test-subroutine",
				promptPath: "test/path.md",
				singleTurn: true,
				description: "Test subroutine",
				suppressThoughtPosting: true,
				disallowAllTools: true,
			};

			expect(testSubroutine.disallowAllTools).toBe(true);
		});
	});
});
