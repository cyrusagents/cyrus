import type { AskUserQuestionInput, IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AskUserQuestionHandler } from "../src/AskUserQuestionHandler.js";

/**
 * Unit tests for AskUserQuestionHandler.
 *
 * These tests verify the handler correctly:
 * - Rejects multi-question inputs (only 1 question allowed at a time)
 * - Posts elicitation activities to Linear with the select signal
 * - Tracks pending questions and resolves them on user response
 * - Handles cancellations via AbortSignal properly
 */
describe("AskUserQuestionHandler", () => {
	let handler: AskUserQuestionHandler;
	let mockIssueTracker: IIssueTrackerService;
	let mockGetIssueTracker: (orgId: string) => IIssueTrackerService | null;
	let mockCreateAgentActivity: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		// Setup mock issue tracker
		mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
		mockIssueTracker = {
			createAgentActivity: mockCreateAgentActivity,
		} as unknown as IIssueTrackerService;

		mockGetIssueTracker = vi.fn().mockReturnValue(mockIssueTracker);

		handler = new AskUserQuestionHandler({
			getIssueTracker: mockGetIssueTracker,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	describe("input validation", () => {
		it("should reject inputs with no questions", async () => {
			const input: AskUserQuestionInput = { questions: [] };
			const abortController = new AbortController();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain(
				"only one question at a time is supported",
			);
		});

		it("should reject inputs with multiple questions", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Question 1?",
						header: "Q1",
						options: [
							{ label: "A", description: "Option A" },
							{ label: "B", description: "Option B" },
						],
						multiSelect: false,
					},
					{
						question: "Question 2?",
						header: "Q2",
						options: [
							{ label: "C", description: "Option C" },
							{ label: "D", description: "Option D" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain(
				"only one question at a time is supported",
			);
			// Should not have called createAgentActivity
			expect(mockCreateAgentActivity).not.toHaveBeenCalled();
		});

		it("should reject if signal is already aborted", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Facebook's library" },
							{ label: "Vue", description: "Progressive framework" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();
			abortController.abort();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("NOT ANSWERED");
		});

		it("should reject if issue tracker is not available", async () => {
			const noTrackerHandler = new AskUserQuestionHandler({
				getIssueTracker: () => null,
			});

			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Facebook's library" },
							{ label: "Vue", description: "Progressive framework" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const result = await noTrackerHandler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("no issue tracker is available");
		});
	});

	describe("elicitation posting", () => {
		it("should post elicitation to Linear with select signal", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database should we use?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
							{ label: "MongoDB", description: "Document database" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			// Don't await - just start the promise
			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// Give it a moment to post the activity
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify the elicitation was posted
			expect(mockCreateAgentActivity).toHaveBeenCalledWith({
				agentSessionId: "session-123",
				content: {
					type: "elicitation",
					body: expect.stringContaining("Which database should we use?"),
				},
				signal: "select",
				signalMetadata: {
					options: [
						{ value: "PostgreSQL" },
						{ value: "MongoDB" },
						{ value: "Other" }, // Should include Other option
					],
				},
			});

			// Clean up by simulating response
			handler.handleUserResponse("session-123", "PostgreSQL");
			await resultPromise;
		});

		it("should include option descriptions in elicitation body", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which framework?",
						header: "Framework",
						options: [
							{ label: "React", description: "Facebook's library" },
							{ label: "Vue", description: "Progressive framework" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			const callArg = mockCreateAgentActivity.mock.calls[0][0];
			expect(callArg.content.body).toContain("React");
			expect(callArg.content.body).toContain("Facebook's library");
			expect(callArg.content.body).toContain("Vue");
			expect(callArg.content.body).toContain("Progressive framework");

			handler.handleUserResponse("session-123", "React");
			await resultPromise;
		});
	});

	describe("response handling", () => {
		it("should resolve promise when user responds", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
							{ label: "MongoDB", description: "Document database" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// Wait for the pending question to be stored
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate user response
			const handled = handler.handleUserResponse("session-123", "PostgreSQL");
			expect(handled).toBe(true);

			const result = await resultPromise;
			expect(result.answered).toBe(true);
			expect(result.answers).toEqual({
				"Which database?": "PostgreSQL",
			});
		});

		it("should not resolve for unknown session", () => {
			const handled = handler.handleUserResponse(
				"unknown-session",
				"PostgreSQL",
			);
			expect(handled).toBe(false);
		});

		it("should return false for hasPendingQuestion when no pending", () => {
			expect(handler.hasPendingQuestion("non-existent")).toBe(false);
		});

		it("should return true for hasPendingQuestion when pending", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			// Start but don't await
			const promise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(handler.hasPendingQuestion("session-123")).toBe(true);

			// Clean up
			handler.handleUserResponse("session-123", "PostgreSQL");
			await promise;
		});
	});

	describe("cancellation handling", () => {
		it("should resolve with cancellation message when aborted", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// Wait for pending question to be stored
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Abort
			abortController.abort();

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("the session was cancelled");
		});

		it("should resolve with custom message when cancelPendingQuestion is called", async () => {
			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const resultPromise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			handler.cancelPendingQuestion(
				"session-123",
				"Custom cancellation reason",
			);

			const result = await resultPromise;
			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("Custom cancellation reason");
		});
	});

	describe("cancellation is distinguishable from a decline", () => {
		const q: AskUserQuestionInput = {
			questions: [
				{
					question: "Ship it?",
					header: "Ship",
					options: [{ label: "Yes", description: "Proceed" }],
					multiSelect: false,
				},
			],
		};

		it("marks every unanswered outcome as cancelled, and says so in the message", async () => {
			const ac = new AbortController();
			const pending = handler.handleAskUserQuestion(
				q,
				"s1",
				"org-123",
				ac.signal,
			);
			await new Promise((r) => setTimeout(r, 10));
			handler.cancelPendingQuestion("s1", "the session ended");
			const result = await pending;

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			// The message is the only part the model reads, so it must rule out
			// the reading that caused this bug: silence as consent.
			expect(result.message).toContain("not approval");
			expect(result.message).toContain("the session ended");
		});

		it("does NOT mark a genuine answer as cancelled", async () => {
			const ac = new AbortController();
			const pending = handler.handleAskUserQuestion(
				q,
				"s2",
				"org-123",
				ac.signal,
			);
			await new Promise((r) => setTimeout(r, 10));
			handler.handleUserResponse("s2", "Yes");
			const result = await pending;

			expect(result.answered).toBe(true);
			// Control: if `cancelled` were set unconditionally the assertion above
			// would still pass, so an answered result must explicitly not carry it.
			expect(result.cancelled).toBeFalsy();
		});

		it("marks a replaced question as cancelled rather than declined", async () => {
			const ac = new AbortController();
			const first = handler.handleAskUserQuestion(
				q,
				"s3",
				"org-123",
				ac.signal,
			);
			await new Promise((r) => setTimeout(r, 10));
			// Deliberately not awaited: the second question stays pending by design,
			// so awaiting it would hang. It is the *first* promise under test.
			void handler.handleAskUserQuestion(q, "s3", "org-123", ac.signal);
			const result = await first;

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("replaced by a newer question");
		});

		it("marks a rejected multi-question call as cancelled", async () => {
			const ac = new AbortController();
			const result = await handler.handleAskUserQuestion(
				{ questions: [q.questions[0]!, q.questions[0]!] },
				"s4",
				"org-123",
				ac.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("not approval");
		});
	});

	describe("replacing pending questions", () => {
		it("should cancel existing pending question when new one arrives", async () => {
			const input1: AskUserQuestionInput = {
				questions: [
					{
						question: "First question?",
						header: "First",
						options: [{ label: "A", description: "Option A" }],
						multiSelect: false,
					},
				],
			};
			const input2: AskUserQuestionInput = {
				questions: [
					{
						question: "Second question?",
						header: "Second",
						options: [{ label: "B", description: "Option B" }],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			// Start first question
			const resultPromise1 = handler.handleAskUserQuestion(
				input1,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Start second question for same session
			const resultPromise2 = handler.handleAskUserQuestion(
				input2,
				"session-123",
				"org-123",
				abortController.signal,
			);

			// First should be cancelled
			const result1 = await resultPromise1;
			expect(result1.answered).toBe(false);
			expect(result1.cancelled).toBe(true);
			expect(result1.message).toContain("replaced by a newer question");

			// Clean up second
			await new Promise((resolve) => setTimeout(resolve, 10));
			handler.handleUserResponse("session-123", "B");
			const result2 = await resultPromise2;
			expect(result2.answered).toBe(true);
		});
	});

	describe("error handling", () => {
		it("should handle createAgentActivity failure", async () => {
			mockCreateAgentActivity.mockRejectedValue(new Error("API Error"));

			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const result = await handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			expect(result.answered).toBe(false);
			expect(result.cancelled).toBe(true);
			expect(result.message).toContain("could not be posted to Linear");
			expect(result.message).toContain("API Error");
		});
	});

	describe("pendingCount", () => {
		it("should track number of pending questions", async () => {
			expect(handler.pendingCount).toBe(0);

			const input: AskUserQuestionInput = {
				questions: [
					{
						question: "Which database?",
						header: "Database",
						options: [
							{ label: "PostgreSQL", description: "Open source relational DB" },
						],
						multiSelect: false,
					},
				],
			};
			const abortController = new AbortController();

			const promise = handler.handleAskUserQuestion(
				input,
				"session-123",
				"org-123",
				abortController.signal,
			);

			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(handler.pendingCount).toBe(1);

			handler.handleUserResponse("session-123", "PostgreSQL");
			await promise;

			expect(handler.pendingCount).toBe(0);
		});
	});
});
