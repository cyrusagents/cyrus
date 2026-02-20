import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async () => {
	const actual =
		await vi.importActual<typeof import("node:child_process")>(
			"node:child_process",
		);
	return {
		...actual,
		spawnSync: spawnSyncMock,
	};
});

import { CursorRunner } from "../src/CursorRunner.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-runner-mcp-enable-"));
	tempDirs.push(dir);
	return dir;
}

describe("CursorRunner MCP enable preflight", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		delete process.env.CYRUS_CURSOR_MOCK;
		delete process.env.CURSOR_MCP_COMMAND;
		spawnSyncMock.mockReset();
	});

	it("enables servers from both mcp list output and inline mcpConfig", async () => {
		const workspace = createTempDir();
		process.env.CYRUS_CURSOR_MOCK = "1";

		spawnSyncMock.mockImplementation((_command: string, args: string[]) => {
			if (args[1] === "list") {
				return {
					status: 0,
					stdout:
						"  trigger: not loaded (needs approval)\n  docs: loaded\n  ignored line\n",
					stderr: "",
				};
			}

			return {
				status: 0,
				stdout: "",
				stderr: "",
			};
		});

		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: workspace,
			mcpConfig: {
				linear: { command: "npx", args: ["-y", "@linear/mcp-server"] },
			},
		});

		await runner.start("test mcp preflight");

		expect(spawnSyncMock).toHaveBeenCalledWith(
			"agent",
			["mcp", "list"],
			expect.objectContaining({ cwd: workspace, encoding: "utf8" }),
		);

		const enabledServers = spawnSyncMock.mock.calls
			.filter((call) => call[1]?.[1] === "enable")
			.map((call) => call[1]?.[2])
			.filter((value): value is string => typeof value === "string")
			.sort();

		expect(enabledServers).toEqual(["docs", "linear", "trigger"]);
	});

	it("does not attempt enable calls when agent command is unavailable", async () => {
		const workspace = createTempDir();
		process.env.CYRUS_CURSOR_MOCK = "1";

		spawnSyncMock.mockReturnValue({
			status: null,
			stdout: "",
			stderr: "",
			error: Object.assign(new Error("spawnSync agent ENOENT"), {
				code: "ENOENT",
			}),
		});

		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: workspace,
			mcpConfig: {
				trigger: { command: "npx", args: ["-y", "@trigger/mcp"] },
			},
		});

		await runner.start("test missing agent");

		expect(spawnSyncMock).toHaveBeenCalledTimes(1);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"agent",
			["mcp", "list"],
			expect.objectContaining({ cwd: workspace, encoding: "utf8" }),
		);
	});
});
