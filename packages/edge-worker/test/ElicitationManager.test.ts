import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IIssueTrackerService } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ElicitationManager,
	type ElicitationOption,
} from "../src/ElicitationManager.js";

/**
 * Unit tests for ElicitationManager.
 *
 * These tests verify the manager correctly:
 * - Posts elicitation activities to Linear with select signal and options
 * - Tracks pending elicitations and resolves them on user response
 * - Handles timeouts (30 minute default)
 * - Persists and loads state from disk for restart survival
 * - Handles cancellation and cleanup
 */
describe("ElicitationManager", () => {
	let manager: ElicitationManager;
	let mockIssueTracker: IIssueTrackerService;
	let mockCreateAgentActivity: ReturnType<typeof vi.fn>;
	let persistencePath: string;

	beforeEach(() => {
		vi.useFakeTimers();

		mockCreateAgentActivity = vi.fn().mockResolvedValue({ success: true });
		mockIssueTracker = {
			createAgentActivity: mockCreateAgentActivity,
		} as unknown as IIssueTrackerService;

		persistencePath = join(
			tmpdir(),
			`elicitation-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
		);

		manager = new ElicitationManager(
			{
				getIssueTracker: () => mockIssueTracker,
			},
			{
				persistencePath,
				timeoutMs: 5000, // Short timeout for tests
			},
		);
	});

	afterEach(() => {
		manager.dispose();
		vi.useRealTimers();
		vi.clearAllMocks();

		// Clean up persistence file
		try {
			if (existsSync(persistencePath)) {
				unlinkSync(persistencePath);
			}
		} catch {
			// Ignore cleanup errors
		}
	});

	describe("emitElicitation", () => {
		it("should post elicitation to Linear with select signal and options", async () => {
			const options: ElicitationOption[] = [
				{ value: "Fix the failing test" },
				{ value: "Skip tests and open PR anyway" },
				{ value: "Abort and report the error" },
			];

			// Start elicitation (don't await - it waits for response)
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Tests failed. How to proceed?",
				options,
				"test-failure",
			);

			// Let the async post complete
			await vi.advanceTimersByTimeAsync(10);

			// Verify the elicitation was posted to Linear
			expect(mockCreateAgentActivity).toHaveBeenCalledWith({
				agentSessionId: "session-123",
				content: {
					type: "elicitation",
					body: "Tests failed. How to proceed?",
				},
				signal: "select",
				signalMetadata: {
					options: [
						{ value: "Fix the failing test" },
						{ value: "Skip tests and open PR anyway" },
						{ value: "Abort and report the error" },
					],
				},
			});

			// Verify pending state
			expect(manager.hasPendingElicitation("session-123")).toBe(true);
			expect(manager.pendingCount).toBe(1);

			// Resolve by simulating user response
			manager.handleUserResponse("session-123", "Fix the failing test");
			const result = await resultPromise;

			expect(result.responded).toBe(true);
			expect(result.selectedValue).toBe("Fix the failing test");
		});

		it("should return error when issue tracker is not available", async () => {
			const noTrackerManager = new ElicitationManager(
				{ getIssueTracker: () => null },
				{ persistencePath, timeoutMs: 5000 },
			);

			const result = await noTrackerManager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);

			expect(result.responded).toBe(false);
			expect(result.reason).toBe("Issue tracker not available");
			noTrackerManager.dispose();
		});

		it("should return error when Linear API call fails", async () => {
			mockCreateAgentActivity.mockRejectedValueOnce(
				new Error("API rate limited"),
			);

			const result = await manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);

			expect(result.responded).toBe(false);
			expect(result.reason).toContain("Failed to present choices");
			expect(result.reason).toContain("API rate limited");
		});

		it("should replace existing pending elicitation for same session", async () => {
			const options: ElicitationOption[] = [{ value: "A" }, { value: "B" }];

			// First elicitation
			const firstPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"First question?",
				options,
				"test-1",
			);
			await vi.advanceTimersByTimeAsync(10);

			// Second elicitation (replaces first)
			const secondPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Second question?",
				options,
				"test-2",
			);
			await vi.advanceTimersByTimeAsync(10);

			// First should have been cancelled
			const firstResult = await firstPromise;
			expect(firstResult.responded).toBe(false);
			expect(firstResult.reason).toBe("Replaced by new elicitation");

			// Second should still be pending
			expect(manager.hasPendingElicitation("session-123")).toBe(true);
			expect(manager.getPendingElicitationType("session-123")).toBe("test-2");

			// Resolve second
			manager.handleUserResponse("session-123", "B");
			const secondResult = await secondPromise;
			expect(secondResult.responded).toBe(true);
			expect(secondResult.selectedValue).toBe("B");
		});
	});

	describe("timeout", () => {
		it("should timeout after configured duration", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			expect(manager.hasPendingElicitation("session-123")).toBe(true);

			// Advance past timeout
			await vi.advanceTimersByTimeAsync(5000);

			const result = await resultPromise;
			expect(result.responded).toBe(false);
			expect(result.reason).toContain("No response received");
			expect(manager.hasPendingElicitation("session-123")).toBe(false);
		});

		it("should clear pending state on timeout", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			expect(manager.pendingCount).toBe(1);

			await vi.advanceTimersByTimeAsync(5000);
			await resultPromise;

			expect(manager.pendingCount).toBe(0);
		});
	});

	describe("handleUserResponse", () => {
		it("should resolve pending elicitation with selected value", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }, { value: "B" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			const handled = manager.handleUserResponse("session-123", "B");
			expect(handled).toBe(true);

			const result = await resultPromise;
			expect(result.responded).toBe(true);
			expect(result.selectedValue).toBe("B");
		});

		it("should return false when no pending elicitation exists", () => {
			const handled = manager.handleUserResponse("nonexistent-session", "A");
			expect(handled).toBe(false);
		});

		it("should clear pending state after response", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			expect(manager.hasPendingElicitation("session-123")).toBe(true);

			manager.handleUserResponse("session-123", "A");
			await resultPromise;

			expect(manager.hasPendingElicitation("session-123")).toBe(false);
			expect(manager.pendingCount).toBe(0);
		});
	});

	describe("cancelPendingElicitation", () => {
		it("should resolve with cancellation reason", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			manager.cancelPendingElicitation("session-123", "Session stopped");

			const result = await resultPromise;
			expect(result.responded).toBe(false);
			expect(result.reason).toBe("Session stopped");
		});
	});

	describe("getPendingElicitationType", () => {
		it("should return the type of pending elicitation", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test-failure",
			);
			await vi.advanceTimersByTimeAsync(10);

			expect(manager.getPendingElicitationType("session-123")).toBe(
				"test-failure",
			);

			manager.handleUserResponse("session-123", "A");
			await resultPromise;
		});

		it("should return undefined for nonexistent session", () => {
			expect(manager.getPendingElicitationType("nonexistent")).toBeUndefined();
		});
	});

	describe("file persistence", () => {
		it("should persist state to disk when elicitation is emitted", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Test failure question",
				[{ value: "Fix" }, { value: "Skip" }],
				"test-failure",
			);
			await vi.advanceTimersByTimeAsync(10);

			// Check persistence file exists
			expect(existsSync(persistencePath)).toBe(true);

			const persisted = JSON.parse(readFileSync(persistencePath, "utf-8"));
			expect(persisted).toHaveLength(1);
			expect(persisted[0].sessionId).toBe("session-123");
			expect(persisted[0].organizationId).toBe("org-456");
			expect(persisted[0].type).toBe("test-failure");
			expect(persisted[0].options).toEqual([
				{ value: "Fix" },
				{ value: "Skip" },
			]);

			// Clean up
			manager.handleUserResponse("session-123", "Fix");
			await resultPromise;
		});

		it("should clear persistence file when elicitation resolves", async () => {
			const resultPromise = manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			manager.handleUserResponse("session-123", "A");
			await resultPromise;

			const persisted = JSON.parse(readFileSync(persistencePath, "utf-8"));
			expect(persisted).toHaveLength(0);
		});

		it("should load persisted state on startup", async () => {
			// Create a persisted state file
			const now = Date.now();
			const persistedData = [
				{
					sessionId: "session-restored",
					organizationId: "org-456",
					body: "Restored question",
					options: [{ value: "A" }, { value: "B" }],
					type: "test-failure",
					createdAt: now,
					timeoutAt: now + 60000, // 1 minute from now
				},
			];
			const { writeFileSync: writeSyncFn } = await import("node:fs");
			writeSyncFn(persistencePath, JSON.stringify(persistedData));

			// Create new manager that should load the state
			const restoredManager = new ElicitationManager(
				{ getIssueTracker: () => mockIssueTracker },
				{ persistencePath, timeoutMs: 5000 },
			);

			expect(restoredManager.hasPendingElicitation("session-restored")).toBe(
				true,
			);
			expect(
				restoredManager.getPendingElicitationType("session-restored"),
			).toBe("test-failure");

			restoredManager.dispose();
		});

		it("should discard expired persisted elicitations", async () => {
			// Create an expired persisted state
			const now = Date.now();
			const persistedData = [
				{
					sessionId: "session-expired",
					organizationId: "org-456",
					body: "Old question",
					options: [{ value: "A" }],
					type: "test-failure",
					createdAt: now - 60000,
					timeoutAt: now - 1000, // Already expired
				},
			];
			const { writeFileSync: writeSyncFn } = await import("node:fs");
			writeSyncFn(persistencePath, JSON.stringify(persistedData));

			const restoredManager = new ElicitationManager(
				{ getIssueTracker: () => mockIssueTracker },
				{ persistencePath, timeoutMs: 5000 },
			);

			expect(restoredManager.hasPendingElicitation("session-expired")).toBe(
				false,
			);
			expect(restoredManager.pendingCount).toBe(0);

			restoredManager.dispose();
		});
	});

	describe("dispose", () => {
		it("should clear all pending elicitations", async () => {
			// Fire-and-forget — we only care about the side effects on pendingCount
			void manager.emitElicitation(
				"session-123",
				"org-456",
				"Question?",
				[{ value: "A" }],
				"test",
			);
			await vi.advanceTimersByTimeAsync(10);

			expect(manager.pendingCount).toBe(1);

			manager.dispose();

			expect(manager.pendingCount).toBe(0);

			// Advance timers to ensure no leftover timers
			await vi.advanceTimersByTimeAsync(10000);
		});
	});
});
