import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	findOwnedProcesses,
	type ProcessProbe,
	terminateOwnedProcesses,
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

describe("ownership-scoped orphan cleanup (real processes)", () => {
	it("records and stops only this runtime's own process inside the worktree", async () => {
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

		const result = await terminateOwnedProcesses(recorded, worktree, {
			graceMs: 300,
		});
		expect(result).toEqual({ matched: [owned.pid], survivors: [] });
		expect(alive(owned.pid!)).toBe(false);
		expect(alive(unowned)).toBe(true);
		expect(alive(ownedElsewhere.pid!)).toBe(true);
	}, 30_000);

	it("never signals a recycled pid (different start time) or a process that left the worktree", async () => {
		const signals: string[] = [];
		const probe: ProcessProbe = {
			table: async () => [
				{ pid: 101, ppid: 1, started: "Fri Oct 30 10:00:01 2026" },
				{ pid: 102, ppid: 1, started: "Fri Oct 30 10:00:02 2026" },
			],
			cwd: async (pid) => (pid === 101 ? "/w/jira-a/pkg" : "/somewhere/else"),
		};
		const result = await terminateOwnedProcesses(
			[
				{ pid: 101, started: "Fri Oct 30 09:59:59 2026" }, // pid reused by another process
				{ pid: 102, started: "Fri Oct 30 10:00:02 2026" }, // no longer in the worktree
			],
			"/w/jira-a",
			{
				probe,
				kill: (pid, sig) => signals.push(`${pid}:${sig}`),
				sleep: async () => {},
				graceMs: 0,
			},
		);
		expect(signals).toEqual([]);
		expect(result).toEqual({ matched: [], survivors: [] });
	});

	it("escalates to SIGKILL and reports a survivor that ignores signals", async () => {
		const signals: string[] = [];
		const probe: ProcessProbe = {
			table: async () => [{ pid: 101, ppid: 1, started: "T" }],
			cwd: async () => "/w/jira-a",
		};
		const result = await terminateOwnedProcesses(
			[{ pid: 101, started: "T" }],
			"/w/jira-a",
			{
				probe,
				kill: (pid, sig) => signals.push(`${pid}:${sig}`),
				sleep: async () => {},
				graceMs: 0,
			},
		);
		expect(signals).toEqual(["101:SIGTERM", "101:SIGKILL"]);
		expect(result).toEqual({ matched: [101], survivors: [101] });
	});
});
