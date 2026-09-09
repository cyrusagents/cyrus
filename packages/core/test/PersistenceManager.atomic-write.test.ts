/**
 * Tests for atomic EdgeWorker state persistence.
 *
 * The state file is rewritten in full on every save. A plain writeFile can be
 * interrupted (SIGKILL, OOM kill, power loss) leaving a truncated file, which
 * the next boot fails to parse — orphaning every in-flight session. Saves must
 * therefore go through a temp file + rename, and loads must tolerate the
 * artifacts of past crashes.
 *
 * These tests use the real filesystem (a fresh temp dir per test), unlike the
 * migration tests which mock node:fs.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ILogger } from "../src/logging/index.js";
import {
	PERSISTENCE_VERSION,
	PersistenceManager,
	type SerializableEdgeWorkerState,
} from "../src/PersistenceManager.js";

const sampleState: SerializableEdgeWorkerState = {
	agentSessions: {
		"session-1": {
			id: "session-1",
		} as never,
	},
	agentSessionEntries: { "session-1": [] },
	childToParentAgentSession: {},
	issueRepositoryCache: { "issue-1": ["repo-1"] },
};

function stubLogger(): ILogger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		child: vi.fn().mockReturnThis(),
	} as unknown as ILogger;
}

describe("PersistenceManager atomic writes", () => {
	let dir: string;
	let logger: ILogger;
	let manager: PersistenceManager;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "cyrus-persistence-test-"));
		logger = stubLogger();
		manager = new PersistenceManager(dir, logger);
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("round-trips state through save and load", async () => {
		await manager.saveEdgeWorkerState(sampleState);
		const loaded = await manager.loadEdgeWorkerState();
		expect(loaded).toEqual(sampleState);
	});

	it("leaves no temp file behind after a save", async () => {
		await manager.saveEdgeWorkerState(sampleState);
		await manager.saveEdgeWorkerState(sampleState);
		const files = await readdir(dir);
		expect(files).toEqual(["edge-worker-state.json"]);
	});

	it("persists complete, parseable JSON", async () => {
		await manager.saveEdgeWorkerState(sampleState);
		const raw = await readFile(join(dir, "edge-worker-state.json"), "utf8");
		const parsed = JSON.parse(raw);
		expect(parsed.version).toBe(PERSISTENCE_VERSION);
		expect(parsed.state).toEqual(sampleState);
	});

	it("treats an intentionally cleared state file as no state, not an error", async () => {
		await manager.saveEdgeWorkerState(sampleState);
		await manager.deleteStateFile();

		const loaded = await manager.loadEdgeWorkerState();

		expect(loaded).toBeNull();
		expect(logger.error).not.toHaveBeenCalled();
	});

	it("returns null (without throwing) for a truncated state file", async () => {
		// The artifact the atomic write prevents going forward; loads must still
		// recover from one produced by an older version.
		await writeFile(
			join(dir, "edge-worker-state.json"),
			'{"version":"4.0","savedAt":"2026-01-01T00:00:00.000Z","state":{"agentSess',
			"utf8",
		);
		const loaded = await manager.loadEdgeWorkerState();
		expect(loaded).toBeNull();
	});

	it("ignores a stale temp file from a previous crashed save", async () => {
		await manager.saveEdgeWorkerState(sampleState);
		// A save killed between writeFile(tmp) and rename leaves this behind.
		await writeFile(
			join(dir, "edge-worker-state.json.tmp"),
			'{"version":"4.0","sav',
			"utf8",
		);

		const loaded = await manager.loadEdgeWorkerState();

		expect(loaded).toEqual(sampleState);
		// The next save must overwrite the stale temp file, not trip over it.
		await manager.saveEdgeWorkerState(sampleState);
		expect(existsSync(join(dir, "edge-worker-state.json.tmp"))).toBe(false);
	});
});
