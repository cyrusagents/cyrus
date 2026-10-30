import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { terminateProcessesUnder } from "../src/jira-agent/OrphanReaper.js";

const dirs: string[] = [];
afterEach(async () => {
	for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

describe("terminateProcessesUnder", () => {
	it("stops a REAL process whose cwd is inside a closed worktree and leaves others alone", async () => {
		const root = await mkdtemp(join(tmpdir(), "jira-orphan-"));
		dirs.push(root);
		const worktree = join(root, "worktrees", "jira-ctx");
		const other = join(root, "elsewhere");
		await mkdir(join(worktree, "src"), { recursive: true });
		await mkdir(other, { recursive: true });
		// An "orphan" in a subdirectory of the worktree, and a bystander outside it.
		const orphan = spawn("sleep", ["300"], {
			cwd: join(worktree, "src"),
			stdio: "ignore",
		});
		const bystander = spawn("sleep", ["300"], { cwd: other, stdio: "ignore" });
		const alive = (pid: number) => {
			try {
				process.kill(pid, 0);
				return true;
			} catch {
				return false;
			}
		};
		try {
			await new Promise((r) => setTimeout(r, 300));
			const result = await terminateProcessesUnder([worktree], {
				graceMs: 500,
			});
			expect(result.found).toEqual([orphan.pid]);
			expect(result.survivors).toEqual([]);
			expect(alive(orphan.pid!)).toBe(false);
			expect(alive(bystander.pid!)).toBe(true);
		} finally {
			orphan.kill("SIGKILL");
			bystander.kill("SIGKILL");
		}
	}, 30_000);

	it("escalates to SIGKILL when SIGTERM is ignored and reports survivors", async () => {
		const signals: string[] = [];
		let alive = true;
		const result = await terminateProcessesUnder(["/w/jira-a"], {
			list: async () => [
				{ pid: 101, cwd: "/w/jira-a/pkg" },
				{ pid: 102, cwd: "/w/jira-ab" },
				{ pid: process.pid, cwd: "/w/jira-a" },
			],
			kill: (pid, sig) => {
				signals.push(`${pid}:${sig}`);
			},
			isAlive: () => alive,
			sleep: async () => {},
			graceMs: 0,
		});
		expect(signals).toEqual(["101:SIGTERM", "101:SIGKILL"]);
		expect(result).toEqual({ found: [101], survivors: [101] });
		alive = false;
	});

	it("does nothing without closed worktrees", async () => {
		expect(await terminateProcessesUnder([])).toEqual({
			found: [],
			survivors: [],
		});
	});
});
