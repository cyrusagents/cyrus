import { execFile } from "node:child_process";
import { readdir, readlink, realpath } from "node:fs/promises";

/**
 * Restart reconciliation for Jira task worktrees.
 *
 * A runner's model subprocess can outlive an abruptly killed Cyrus process
 * (observed: the Claude Code child kept running in its worktree after the
 * worker was SIGKILLed). Contexts interrupted by a restart are already closed
 * to new work; this additionally stops any surviving process whose working
 * directory is inside such a worktree, so an orphan does not keep editing
 * files or spending model usage. Only processes this user may signal are
 * affected, and the current process is never touched.
 */
export type ProcessCwd = { pid: number; cwd: string };

export interface OrphanReaperDeps {
	list(): Promise<ProcessCwd[]>;
	kill(pid: number, signal: NodeJS.Signals): void;
	isAlive(pid: number): boolean;
	sleep(ms: number): Promise<void>;
	graceMs: number;
}

/** Working directories of running processes (Linux /proc, else lsof). */
export async function listProcessCwds(): Promise<ProcessCwd[]> {
	if (process.platform === "linux") {
		const out: ProcessCwd[] = [];
		for (const entry of await readdir("/proc").catch(() => [] as string[])) {
			if (!/^\d+$/.test(entry)) continue;
			const cwd = await readlink(`/proc/${entry}/cwd`).catch(() => null);
			if (cwd) out.push({ pid: Number(entry), cwd });
		}
		return out;
	}
	const stdout = await new Promise<string>((resolve, reject) =>
		execFile(
			"lsof",
			["-n", "-P", "-w", "-d", "cwd", "-Fpn"],
			{ maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
			// lsof exits 1 when some processes can't be inspected; output is still valid.
			(error, out) =>
				out || !error ? resolve(String(out)) : reject(error as Error),
		),
	);
	const out: ProcessCwd[] = [];
	let pid: number | null = null;
	for (const line of stdout.split("\n")) {
		if (line.startsWith("p")) pid = Number(line.slice(1));
		else if (line.startsWith("n") && pid !== null)
			out.push({ pid, cwd: line.slice(1) });
	}
	return out;
}

const defaultDeps: OrphanReaperDeps = {
	list: listProcessCwds,
	kill: (pid, signal) => process.kill(pid, signal),
	isAlive: (pid) => {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	},
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	graceMs: 3000,
};

/**
 * SIGTERM every process whose cwd is inside one of `roots`, then SIGKILL any
 * still alive after the grace period. Returns the pids found and any that
 * could not be stopped.
 */
export async function terminateProcessesUnder(
	roots: readonly string[],
	overrides: Partial<OrphanReaperDeps> = {},
): Promise<{ found: number[]; survivors: number[] }> {
	const deps = { ...defaultDeps, ...overrides };
	const resolved = new Set<string>();
	for (const root of roots) {
		resolved.add(root.replace(/\/+$/, ""));
		const real = await realpath(root).catch(() => null);
		if (real) resolved.add(real);
	}
	if (resolved.size === 0) return { found: [], survivors: [] };
	const inside = (cwd: string) =>
		[...resolved].some((r) => cwd === r || cwd.startsWith(`${r}/`));
	const found = (await deps.list())
		.filter((p) => p.pid !== process.pid && inside(p.cwd))
		.map((p) => p.pid);
	const signal = (pid: number, sig: NodeJS.Signals) => {
		try {
			deps.kill(pid, sig);
		} catch {
			// Already gone or not ours to signal.
		}
	};
	for (const pid of found) signal(pid, "SIGTERM");
	if (found.length > 0) await deps.sleep(deps.graceMs);
	for (const pid of found) if (deps.isAlive(pid)) signal(pid, "SIGKILL");
	if (found.length > 0) await deps.sleep(200);
	return { found, survivors: found.filter((pid) => deps.isAlive(pid)) };
}
