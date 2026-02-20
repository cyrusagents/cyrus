/**
 * Unit tests for GlobalSessionRegistry
 */

import type { CyrusAgentSession, CyrusAgentSessionEntry } from "@cyrus/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GlobalSessionRegistry } from "../src/GlobalSessionRegistry.js";

describe("GlobalSessionRegistry", () => {
	let registry: GlobalSessionRegistry;

	// Helper to create a mock session
	const createMockSession = (
		sessionId: string,
		overrides?: Partial<CyrusAgentSession>,
	): CyrusAgentSession => ({
		id: sessionId,
		externalSessionId: sessionId,
		type: "comment-thread" as const,
		status: "active",
		context: "comment-thread" as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		issueContext: {
			trackerId: "linear",
			issueId: `issue-${sessionId}`,
			issueIdentifier: `TEST-${sessionId}`,
		},
		issueId: `issue-${sessionId}`,
		issue: {
			id: `issue-${sessionId}`,
			identifier: `TEST-${sessionId}`,
			title: `Test Issue ${sessionId}`,
			branchName: `test-${sessionId}`,
		},
		workspace: {
			path: `/tmp/test-${sessionId}`,
			isGitWorktree: true,
		},
		...overrides,
	});

	// Helper to create a mock entry
	const createMockEntry = (
		type: "user" | "assistant" | "system" | "result",
		content: string,
	): CyrusAgentSessionEntry => ({
		type,
		content,
		metadata: {
			timestamp: Date.now(),
		},
	});

	beforeEach(() => {
		registry = new GlobalSessionRegistry();
	});

	describe("Session CRUD Operations", () => {
		it("should create a new session", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const retrieved = registry.getSession("session-1");
			expect(retrieved).toEqual(session);
		});

		it("should throw error when creating duplicate session", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			expect(() => registry.createSession(session)).toThrow(
				"Session with ID session-1 already exists",
			);
		});

		it("should emit sessionCreated event", () => {
			const session = createMockSession("session-1");
			const listener = vi.fn();
			registry.on("sessionCreated", listener);

			registry.createSession(session);

			expect(listener).toHaveBeenCalledWith(session);
		});

		it("should get session by ID", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			expect(registry.getSession("session-1")).toEqual(session);
		});

		it("should return undefined for non-existent session", () => {
			expect(registry.getSession("non-existent")).toBeUndefined();
		});

		it("should update session", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const updates = { status: "complete" as const };
			registry.updateSession("session-1", updates);

			const updated = registry.getSession("session-1");
			expect(updated?.status).toBe("complete");
			expect(updated?.updatedAt).toBeGreaterThanOrEqual(session.updatedAt);
		});

		it("should throw error when updating non-existent session", () => {
			expect(() =>
				registry.updateSession("non-existent", { status: "complete" }),
			).toThrow("Session with ID non-existent not found");
		});

		it("should emit sessionUpdated event", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const listener = vi.fn();
			registry.on("sessionUpdated", listener);

			const updates = { status: "complete" as const };
			registry.updateSession("session-1", updates);

			expect(listener).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({ status: "complete" }),
				updates,
			);
		});

		it("should emit sessionCompleted event when status changes to complete", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const listener = vi.fn();
			registry.on("sessionCompleted", listener);

			registry.updateSession("session-1", { status: "complete" });

			expect(listener).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({ status: "complete" }),
			);
		});

		it("should emit sessionCompleted event when status changes to error", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const listener = vi.fn();
			registry.on("sessionCompleted", listener);

			registry.updateSession("session-1", { status: "error" });

			expect(listener).toHaveBeenCalledWith(
				"session-1",
				expect.objectContaining({ status: "error" }),
			);
		});

		it("should not emit sessionCompleted event for non-terminal status", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const listener = vi.fn();
			registry.on("sessionCompleted", listener);

			registry.updateSession("session-1", { status: "paused" });

			expect(listener).not.toHaveBeenCalled();
		});

		it("should delete session", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);
			registry.addEntry("session-1", createMockEntry("user", "Hello"));

			registry.deleteSession("session-1");

			expect(registry.getSession("session-1")).toBeUndefined();
			expect(registry.getEntries("session-1")).toEqual([]);
		});

		it("should clean up parent-child mappings when deleting parent", () => {
			const parent = createMockSession("parent-1");
			const child = createMockSession("child-1");
			registry.createSession(parent);
			registry.createSession(child);
			registry.setParentSession("child-1", "parent-1");

			registry.deleteSession("parent-1");

			expect(registry.getParentSessionId("child-1")).toBeUndefined();
		});

		it("should clean up parent-child mappings when deleting child", () => {
			const parent = createMockSession("parent-1");
			const child = createMockSession("child-1");
			registry.createSession(parent);
			registry.createSession(child);
			registry.setParentSession("child-1", "parent-1");

			registry.deleteSession("child-1");

			expect(registry.getChildSessionIds("parent-1")).toEqual([]);
		});

		it("should get all sessions", () => {
			const session1 = createMockSession("session-1");
			const session2 = createMockSession("session-2");
			registry.createSession(session1);
			registry.createSession(session2);

			const allSessions = registry.getAllSessions();
			expect(allSessions).toHaveLength(2);
			expect(allSessions).toContainEqual(session1);
			expect(allSessions).toContainEqual(session2);
		});
	});

	describe("Entry Management", () => {
		beforeEach(() => {
			const session = createMockSession("session-1");
			registry.createSession(session);
		});

		it("should add entry to session", () => {
			const entry = createMockEntry("user", "Hello");
			registry.addEntry("session-1", entry);

			const entries = registry.getEntries("session-1");
			expect(entries).toHaveLength(1);
			expect(entries[0]).toEqual(entry);
		});

		it("should throw error when adding entry to non-existent session", () => {
			const entry = createMockEntry("user", "Hello");
			expect(() => registry.addEntry("non-existent", entry)).toThrow(
				"Session with ID non-existent not found",
			);
		});

		it("should update session updatedAt when adding entry", () => {
			const session = registry.getSession("session-1");
			const originalUpdatedAt = session!.updatedAt;

			// Wait a bit to ensure timestamp difference
			vi.useFakeTimers();
			vi.advanceTimersByTime(100);

			const entry = createMockEntry("user", "Hello");
			registry.addEntry("session-1", entry);

			const updated = registry.getSession("session-1");
			expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);

			vi.useRealTimers();
		});

		it("should get entries for session", () => {
			const entry1 = createMockEntry("user", "Hello");
			const entry2 = createMockEntry("assistant", "Hi there");
			registry.addEntry("session-1", entry1);
			registry.addEntry("session-1", entry2);

			const entries = registry.getEntries("session-1");
			expect(entries).toHaveLength(2);
			expect(entries[0]).toEqual(entry1);
			expect(entries[1]).toEqual(entry2);
		});

		it("should return empty array for session with no entries", () => {
			expect(registry.getEntries("session-1")).toEqual([]);
		});

		it("should return empty array for non-existent session", () => {
			expect(registry.getEntries("non-existent")).toEqual([]);
		});

		it("should update entry", () => {
			const entry = createMockEntry("user", "Hello");
			registry.addEntry("session-1", entry);

			const updates = { linearAgentActivityId: "activity-123" };
			registry.updateEntry("session-1", 0, updates);

			const entries = registry.getEntries("session-1");
			expect(entries[0].linearAgentActivityId).toBe("activity-123");
		});

		it("should throw error when updating entry in non-existent session", () => {
			expect(() =>
				registry.updateEntry("non-existent", 0, { content: "Updated" }),
			).toThrow("Session with ID non-existent not found");
		});

		it("should throw error when entry index out of bounds", () => {
			const entry = createMockEntry("user", "Hello");
			registry.addEntry("session-1", entry);

			expect(() =>
				registry.updateEntry("session-1", 5, { content: "Updated" }),
			).toThrow(
				"Entry index 5 out of bounds for session session-1 (length: 1)",
			);
		});

		it("should update session updatedAt when updating entry", () => {
			const entry = createMockEntry("user", "Hello");
			registry.addEntry("session-1", entry);

			const session = registry.getSession("session-1");
			const originalUpdatedAt = session!.updatedAt;

			vi.useFakeTimers();
			vi.advanceTimersByTime(100);

			registry.updateEntry("session-1", 0, { content: "Updated" });

			const updated = registry.getSession("session-1");
			expect(updated!.updatedAt).toBeGreaterThan(originalUpdatedAt);

			vi.useRealTimers();
		});
	});

	describe("Parent-Child Mapping", () => {
		beforeEach(() => {
			const parent = createMockSession("parent-1");
			const child = createMockSession("child-1");
			registry.createSession(parent);
			registry.createSession(child);
		});

		it("should set parent session", () => {
			registry.setParentSession("child-1", "parent-1");
			expect(registry.getParentSessionId("child-1")).toBe("parent-1");
		});

		it("should get parent session ID", () => {
			registry.setParentSession("child-1", "parent-1");
			expect(registry.getParentSessionId("child-1")).toBe("parent-1");
		});

		it("should return undefined for child with no parent", () => {
			expect(registry.getParentSessionId("child-1")).toBeUndefined();
		});

		it("should get child session IDs", () => {
			const child2 = createMockSession("child-2");
			registry.createSession(child2);

			registry.setParentSession("child-1", "parent-1");
			registry.setParentSession("child-2", "parent-1");

			const childIds = registry.getChildSessionIds("parent-1");
			expect(childIds).toHaveLength(2);
			expect(childIds).toContain("child-1");
			expect(childIds).toContain("child-2");
		});

		it("should return empty array for parent with no children", () => {
			expect(registry.getChildSessionIds("parent-1")).toEqual([]);
		});

		it("should handle multiple parent-child relationships", () => {
			const parent2 = createMockSession("parent-2");
			const child2 = createMockSession("child-2");
			registry.createSession(parent2);
			registry.createSession(child2);

			registry.setParentSession("child-1", "parent-1");
			registry.setParentSession("child-2", "parent-2");

			expect(registry.getParentSessionId("child-1")).toBe("parent-1");
			expect(registry.getParentSessionId("child-2")).toBe("parent-2");
			expect(registry.getChildSessionIds("parent-1")).toEqual(["child-1"]);
			expect(registry.getChildSessionIds("parent-2")).toEqual(["child-2"]);
		});
	});

	describe("Serialization", () => {
		it("should serialize state", () => {
			const session = createMockSession("session-1", {
				claudeSessionId: "claude-123",
			});
			registry.createSession(session);
			registry.addEntry("session-1", createMockEntry("user", "Hello"));
			registry.setParentSession("session-1", "parent-1");

			const serialized = registry.serializeState();

			expect(serialized.version).toBe("3.0");
			expect(serialized.sessions["session-1"]).toMatchObject({
				id: "session-1",
				claudeSessionId: "claude-123",
			});
			expect(serialized.entries["session-1"]).toHaveLength(1);
			expect(serialized.childToParentMap["session-1"]).toBe("parent-1");
		});

		it("should exclude non-serializable agentRunner", () => {
			const mockRunner = {
				execute: vi.fn(),
				stop: vi.fn(),
			};
			const session = createMockSession("session-1", {
				agentRunner: mockRunner as any,
			});
			registry.createSession(session);

			const serialized = registry.serializeState();

			expect(serialized.sessions["session-1"]).not.toHaveProperty(
				"agentRunner",
			);
		});

		it("should restore state", () => {
			const serialized = {
				version: "3.0" as const,
				sessions: {
					"session-1": createMockSession("session-1"),
				},
				entries: {
					"session-1": [createMockEntry("user", "Hello")],
				},
				childToParentMap: {
					"session-1": "parent-1",
				},
			};

			registry.restoreState(serialized);

			expect(registry.getSession("session-1")).toMatchObject({
				id: "session-1",
			});
			expect(registry.getEntries("session-1")).toHaveLength(1);
			expect(registry.getParentSessionId("session-1")).toBe("parent-1");
		});

		it("should clear existing state before restoring", () => {
			// Create initial state
			const session1 = createMockSession("session-1");
			registry.createSession(session1);
			registry.addEntry("session-1", createMockEntry("user", "Hello"));

			// Restore different state
			const serialized = {
				version: "3.0" as const,
				sessions: {
					"session-2": createMockSession("session-2"),
				},
				entries: {
					"session-2": [createMockEntry("user", "Hi")],
				},
				childToParentMap: {},
			};

			registry.restoreState(serialized);

			expect(registry.getSession("session-1")).toBeUndefined();
			expect(registry.getSession("session-2")).toBeDefined();
		});

		it("should serialize and restore round-trip", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);
			registry.addEntry("session-1", createMockEntry("user", "Hello"));
			registry.setParentSession("session-1", "parent-1");

			const serialized = registry.serializeState();
			const newRegistry = new GlobalSessionRegistry();
			newRegistry.restoreState(serialized);

			expect(newRegistry.getSession("session-1")).toMatchObject({
				id: "session-1",
			});
			expect(newRegistry.getEntries("session-1")).toHaveLength(1);
			expect(newRegistry.getParentSessionId("session-1")).toBe("parent-1");
		});
	});

	describe("Cleanup", () => {
		it("should remove old sessions", () => {
			vi.useFakeTimers();
			const now = Date.now();

			// Create old session
			vi.setSystemTime(now - 2 * 60 * 60 * 1000); // 2 hours ago
			const oldSession = createMockSession("old-session");
			registry.createSession(oldSession);

			// Create recent session
			vi.setSystemTime(now);
			const recentSession = createMockSession("recent-session");
			registry.createSession(recentSession);

			// Cleanup sessions older than 1 hour
			const removed = registry.cleanup(60 * 60 * 1000);

			expect(removed).toBe(1);
			expect(registry.getSession("old-session")).toBeUndefined();
			expect(registry.getSession("recent-session")).toBeDefined();

			vi.useRealTimers();
		});

		it("should remove entries when cleaning up sessions", () => {
			vi.useFakeTimers();
			const now = Date.now();

			vi.setSystemTime(now - 2 * 60 * 60 * 1000);
			const oldSession = createMockSession("old-session");
			registry.createSession(oldSession);
			registry.addEntry("old-session", createMockEntry("user", "Hello"));

			vi.setSystemTime(now);
			registry.cleanup(60 * 60 * 1000);

			expect(registry.getEntries("old-session")).toEqual([]);

			vi.useRealTimers();
		});

		it("should clean up parent-child mappings", () => {
			vi.useFakeTimers();
			const now = Date.now();

			vi.setSystemTime(now - 2 * 60 * 60 * 1000);
			const oldParent = createMockSession("old-parent");
			const oldChild = createMockSession("old-child");
			registry.createSession(oldParent);
			registry.createSession(oldChild);
			registry.setParentSession("old-child", "old-parent");

			vi.setSystemTime(now);
			registry.cleanup(60 * 60 * 1000);

			expect(registry.getParentSessionId("old-child")).toBeUndefined();
			expect(registry.getChildSessionIds("old-parent")).toEqual([]);

			vi.useRealTimers();
		});

		it("should return count of removed sessions", () => {
			vi.useFakeTimers();
			const now = Date.now();

			vi.setSystemTime(now - 2 * 60 * 60 * 1000);
			registry.createSession(createMockSession("old-1"));
			registry.createSession(createMockSession("old-2"));
			registry.createSession(createMockSession("old-3"));

			vi.setSystemTime(now);
			const removed = registry.cleanup(60 * 60 * 1000);

			expect(removed).toBe(3);

			vi.useRealTimers();
		});

		it("should not remove sessions within max age", () => {
			vi.useFakeTimers();
			const now = Date.now();

			vi.setSystemTime(now - 30 * 60 * 1000); // 30 minutes ago
			const session = createMockSession("session-1");
			registry.createSession(session);

			vi.setSystemTime(now);
			const removed = registry.cleanup(60 * 60 * 1000); // 1 hour

			expect(removed).toBe(0);
			expect(registry.getSession("session-1")).toBeDefined();

			vi.useRealTimers();
		});
	});

	describe("Edge Cases", () => {
		it("should handle empty registry", () => {
			expect(registry.getAllSessions()).toEqual([]);
			expect(registry.getEntries("non-existent")).toEqual([]);
			expect(registry.getParentSessionId("non-existent")).toBeUndefined();
			expect(registry.getChildSessionIds("non-existent")).toEqual([]);
		});

		it("should handle session with metadata", () => {
			const session = createMockSession("session-1", {
				metadata: {
					model: "claude-3-5-sonnet-20241022",
					tools: ["bash", "read"],
					totalCostUsd: 0.05,
				},
			});
			registry.createSession(session);

			const retrieved = registry.getSession("session-1");
			expect(retrieved?.metadata?.model).toBe("claude-3-5-sonnet-20241022");
			expect(retrieved?.metadata?.tools).toEqual(["bash", "read"]);
		});

		it("should handle entry with complex metadata", () => {
			const session = createMockSession("session-1");
			registry.createSession(session);

			const entry = createMockEntry("result", "Tool output");
			entry.metadata = {
				...entry.metadata,
				toolUseId: "tool-123",
				toolName: "bash",
				toolInput: { command: "ls" },
				toolResultError: false,
			};
			registry.addEntry("session-1", entry);

			const entries = registry.getEntries("session-1");
			expect(entries[0].metadata?.toolName).toBe("bash");
			expect(entries[0].metadata?.toolInput).toEqual({ command: "ls" });
		});

		it("should handle multiple event listeners", () => {
			const listener1 = vi.fn();
			const listener2 = vi.fn();
			registry.on("sessionCreated", listener1);
			registry.on("sessionCreated", listener2);

			const session = createMockSession("session-1");
			registry.createSession(session);

			expect(listener1).toHaveBeenCalledWith(session);
			expect(listener2).toHaveBeenCalledWith(session);
		});
	});
});
