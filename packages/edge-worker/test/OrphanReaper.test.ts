import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findOwnedProcesses,
	inspectOwnedProcesses,
	type ProcessProbe,
} from "../src/jira-agent/OrphanReaper.js";

const dirs: string[] = [];
const pids: number[] = [];
afterEach(async () => {
	for (const pid of pids.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
	}
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A process NOT descended from this test: `sh` backgrounds it and exits. */
function spawnUnowned(cwd: string): Promise<number> {
	return new Promise((resolve) => {
		const sh = spawn("sh", ["-c", "sleep 300 >/dev/null 2>&1 & echo $!"], {
			cwd,
		});
		let out = "";
		sh.stdout.on("data", (d) => {
			out += d;
		});
		sh.on("exit", () => resolve(Number(out.trim())));
	});
}

describe("ownership-scoped restart inspection (report only)", () => {
	it("records only this runtime's own process in the worktree and reports it WITHOUT signalling (real processes)", async () => {
		const root = await mkdtemp(join(tmpdir(), "jira-orphan-"));
		dirs.push(root);
		const worktree = join(root, "worktrees", "jira-ctx");
		const elsewhere = join(root, "elsewhere");
		await mkdir(join(worktree, "src"), { recursive: true });
		await mkdir(elsewhere, { recursive: true });
		const owned = spawn("sleep", ["300"], {
			cwd: join(worktree, "src"),
			stdio: "ignore",
		});
		const ownedElsewhere = spawn("sleep", ["300"], {
			cwd: elsewhere,
			stdio: "ignore",
		});
		pids.push(owned.pid!, ownedElsewhere.pid!);
		const unowned = await spawnUnowned(worktree); // e.g. a user's shell job
		pids.push(unowned);
		await delay(300);

		const recorded = await findOwnedProcesses(process.pid, worktree);
		expect(recorded.map((r) => r.pid)).toEqual([owned.pid]);

		const result = await inspectOwnedProcesses(recorded);
		expect(result.possiblyRunning.map((r) => r.pid)).toEqual([owned.pid]);
		expect(result.gone).toEqual([]);
		expect(result.unknown).toEqual([]);
		// Nothing was signalled.
		await delay(200);
		expect(alive(owned.pid!)).toBe(true);
		expect(alive(unowned)).toBe(true);
		expect(alive(ownedElsewhere.pid!)).toBe(true);

		// Once the recorded process really exits it is reported gone.
		process.kill(owned.pid!, "SIGKILL");
		await delay(300);
		expect(
			(await inspectOwnedProcesses(recorded)).gone.map((r) => r.pid),
		).toEqual([owned.pid]);
	}, 30_000);

	it("identity changing between inspection steps (review-3 probe) is never signalled and a reused pid is gone", async () => {
		// Same shape as orphan-review3-repro.mts probe 1: the pid is reused by an
		// unrelated process. The API has no kill path at all.
		let started = "old-start";
		const probe: ProcessProbe = {
			table: async () => {
				const row = { pid: 424242, ppid: 1, started };
				started = "new-unrelated-process-start";
				return [row];
			},
			cwd: async () => "/fixture/worktree",
		};
		const first = await inspectOwnedProcesses(
			[{ pid: 424242, started: "old-start" }],
			probe,
		);
		expect(first.possiblyRunning.map((r) => r.pid)).toEqual([424242]);
		const second = await inspectOwnedProcesses(
			[{ pid: 424242, started: "old-start" }],
			probe,
		);
		expect(second.gone.map((r) => r.pid)).toEqual([424242]);
	});

	it("a matching process that changed directory is still possibly running, not stopped (review-3 probe 2)", async () => {
		const probe: ProcessProbe = {
			table: async () => [{ pid: 424243, ppid: 1, started: "same-start" }],
			cwd: async () => "/elsewhere",
		};
		const result = await inspectOwnedProcesses(
			[{ pid: 424243, started: "same-start" }],
			probe,
		);
		expect(result.possiblyRunning.map((r) => r.pid)).toEqual([424243]);
		expect(result.gone).toEqual([]);
	});

	it("an inspection failure is reported as unknown, never as stopped", async () => {
		const probe: ProcessProbe = {
			table: async () => {
				throw new Error("ps unavailable");
			},
			cwd: async () => null,
		};
		const result = await inspectOwnedProcesses(
			[{ pid: 7, started: "T" }],
			probe,
		);
		expect(result).toEqual({
			possiblyRunning: [],
			gone: [],
			unknown: [{ pid: 7, started: "T" }],
		});
	});
});
