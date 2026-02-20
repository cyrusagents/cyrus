import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	return {
		...actual,
		spawn: spawnMock,
		spawnSync: spawnSyncMock,
	};
});

import { CursorRunner } from "../src/CursorRunner.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-runner-version-check-"));
	tempDirs.push(dir);
	return dir;
}

function createMockChildProcess(): {
	stdout: Readable;
	stderr: { on: () => void };
	on: (ev: string, fn: (code?: number) => void) => unknown;
} {
	const stdout = new Readable({ read() {} });
	stdout.push(
		'{"type":"init","session_id":"test-version-check","timestamp":"2026-02-14T00:00:00Z"}\n',
	);
	stdout.push('{"type":"result","status":"success"}\n');
	stdout.push(null);

	const handlers: { close?: (code?: number) => void } = {};
	return {
		stdout,
		stderr: { on: () => {} },
		on(ev: string, fn: (code?: number) => void) {
			if (ev === "close") handlers.close = fn;
			setImmediate(() => {
				if (ev === "close" && handlers.close) handlers.close(0);
			});
			return { on: () => {} };
		},
	};
}

describe("CursorRunner version check", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		delete process.env.CYRUS_CURSOR_MOCK;
		delete process.env.CYRUS_CURSOR_AGENT_VERSION;
		spawnSyncMock.mockReset();
		spawnMock.mockReset();
	});

	it("posts error to Linear when cursor-agent version does not match tested version", async () => {
		const workspace = createTempDir();

		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: "2026.02.14-different-version",
			stderr: "",
		});

		const messages: unknown[] = [];
		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: workspace,
			cursorAgentVersion: "2026.02.13-41ac335",
			onMessage: (m) => messages.push(m),
			onError: () => {}, // prevent unhandled error emission from failing test
		});

		await runner.start("test version mismatch");

		expect(spawnSyncMock).toHaveBeenCalledWith(
			"cursor-agent",
			["--version"],
			expect.objectContaining({ encoding: "utf8" }),
		);
		expect(spawnMock).not.toHaveBeenCalled();

		const errorResult = messages.find(
			(m) =>
				typeof m === "object" &&
				m !== null &&
				"type" in m &&
				m.type === "result" &&
				"subtype" in m &&
				m.subtype === "error_during_execution",
		);
		expect(errorResult).toBeDefined();
		expect(errorResult).toMatchObject({
			type: "result",
			subtype: "error_during_execution",
			is_error: true,
		});
		const errors = (errorResult as { errors?: string[] }).errors;
		expect(errors).toBeDefined();
		expect(errors?.[0]).toContain("version mismatch");
		expect(errors?.[0]).toContain("2026.02.13-41ac335");
		expect(errors?.[0]).toContain("2026.02.14-different-version");
	});

	it("proceeds when cursor-agent version matches expected", async () => {
		const workspace = createTempDir();

		spawnSyncMock.mockImplementation((_cmd: string, args: string[]) => {
			if (args[0] === "--version") {
				return { status: 0, stdout: "2026.02.13-41ac335", stderr: "" };
			}
			if (args[1] === "list") {
				return { status: 0, stdout: "", stderr: "" };
			}
			return { status: 0, stdout: "", stderr: "" };
		});

		spawnMock.mockReturnValue(createMockChildProcess());

		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: workspace,
			cursorAgentVersion: "2026.02.13-41ac335",
		});

		await runner.start("test version match");

		expect(spawnSyncMock).toHaveBeenCalledWith(
			"cursor-agent",
			["--version"],
			expect.any(Object),
		);
		expect(spawnMock).toHaveBeenCalled();
	});

	it("skips version check when CYRUS_CURSOR_MOCK is set", async () => {
		const workspace = createTempDir();
		process.env.CYRUS_CURSOR_MOCK = "1";

		spawnSyncMock.mockReturnValue({
			status: 0,
			stdout: "  docs: loaded\n",
			stderr: "",
		});

		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: workspace,
			cursorAgentVersion: "2026.02.13-41ac335",
		});

		await runner.start("test mock");

		const versionCalls = spawnSyncMock.mock.calls.filter(
			(call) => call[1]?.[0] === "--version",
		);
		expect(versionCalls).toHaveLength(0);
	});
});
