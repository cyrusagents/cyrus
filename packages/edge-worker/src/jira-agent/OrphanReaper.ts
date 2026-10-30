import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";

/**
 * Restart reconciliation for Jira task worktrees, limited to processes this
 * runtime provably started.
 *
 * A runner's model subprocess can outlive an abruptly killed Cyrus process
 * (observed: the Claude Code child kept running in its worktree after the
 * worker was SIGKILLed). While a Jira task runs, the runtime records its OWN
 * descendant processes whose working directory is inside the task worktree
 * as (pid, start time). After a restart, only a process matching a recorded
 * pid AND the same start time AND still working inside that worktree is
 * signalled. Anything else — a user's shell or editor in the worktree, a
 * recycled pid, a shared runtime — is never touched. (A process environment
 * marker was considered, but macOS does not expose other processes'
 * environments, so it could not identify ownership there.)
 */
export interface OwnedProcess {
	pid: number;
	/** Process start time as reported by `ps -o lstart=` (second precision). */
	started: string;
}

export interface ProcessRow {
	pid: number;
	ppid: number;
	started: string;
}

export interface ProcessProbe {
	table(): Promise<ProcessRow[]>;
	cwd(pid: number): Promise<string | null>;
}

function run(cmd: string, args: string[]): Promise<string> {
	return new Promise((resolve, reject) =>
		execFile(
			cmd,
			args,
			{ maxBuffer: 16 * 1024 * 1024, timeout: 15_000 },
			// lsof exits 1 when a process can't be inspected; output still valid.
			(error, out) =>
				out || !error ? resolve(String(out)) : reject(error as Error),
		),
	);
}

export const systemProcessProbe: ProcessProbe = {
	async table() {
		const out = await run("ps", ["-A", "-o", "pid=,ppid=,lstart="]);
		const rows: ProcessRow[] = [];
		for (const line of out.split("\n")) {
			const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
			if (m)
				rows.push({ pid: Number(m[1]), ppid: Number(m[2]), started: m[3]! });
		}
		return rows;
	},
	async cwd(pid) {
		if (process.platform === "linux")
			return readlink(`/proc/${pid}/cwd`).catch(() => null);
		const out = await run("lsof", [
			"-n",
			"-P",
			"-w",
			"-a",
			"-p",
			String(pid),
			"-d",
			"cwd",
			"-Fn",
		]).catch(() => "");
		const line = out.split("\n").find((l) => l.startsWith("n"));
		return line ? line.slice(1) : null;
	},
};

async function roots(path: string): Promise<string[]> {
	const out = [path.replace(/\/+$/, "")];
	const real = await realpath(path).catch(() => null);
	if (real && real !== out[0]) out.push(real);
	return out;
}

const inside = (cwd: string, bases: string[]) =>
	bases.some((b) => cwd === b || cwd.startsWith(`${b}/`));

/** Descendants of `rootPid` currently working inside `worktree`. */
export async function findOwnedProcesses(
	rootPid: number,
	worktree: string,
	probe: ProcessProbe = systemProcessProbe,
): Promise<OwnedProcess[]> {
	const table = await probe.table();
	const children = new Map<number, ProcessRow[]>();
	for (const row of table) {
		const list = children.get(row.ppid) ?? [];
		list.push(row);
		children.set(row.ppid, list);
	}
	const descendants: ProcessRow[] = [];
	const queue = [rootPid];
	const seen = new Set<number>(queue);
	while (queue.length > 0) {
		for (const child of children.get(queue.shift()!) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			descendants.push(child);
			queue.push(child.pid);
		}
	}
	const bases = await roots(worktree);
	const owned: OwnedProcess[] = [];
	for (const row of descendants) {
		const cwd = await probe.cwd(row.pid);
		if (cwd && inside(cwd, bases))
			owned.push({ pid: row.pid, started: row.started });
	}
	return owned;
}

export interface TerminateDeps {
	probe: ProcessProbe;
	kill(pid: number, signal: NodeJS.Signals): void;
	sleep(ms: number): Promise<void>;
	graceMs: number;
}

const defaultTerminateDeps: TerminateDeps = {
	probe: systemProcessProbe,
	kill: (pid, signal) => process.kill(pid, signal),
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	graceMs: 3000,
};

/**
 * Stop recorded processes that are still the SAME process (pid and start
 * time) and still inside `worktree`: SIGTERM, then SIGKILL after the grace
 * period. Returns which matched and which could not be stopped.
 */
export async function terminateOwnedProcesses(
	recorded: readonly OwnedProcess[],
	worktree: string,
	overrides: Partial<TerminateDeps> = {},
): Promise<{ matched: number[]; survivors: number[] }> {
	const deps = { ...defaultTerminateDeps, ...overrides };
	if (recorded.length === 0) return { matched: [], survivors: [] };
	const bases = await roots(worktree);
	const sameProcessInside = async (): Promise<number[]> => {
		const table = await deps.probe.table();
		const alive: number[] = [];
		for (const rec of recorded) {
			if (rec.pid === process.pid) continue;
			const row = table.find((r) => r.pid === rec.pid);
			if (!row || row.started !== rec.started) continue;
			const cwd = await deps.probe.cwd(rec.pid);
			if (cwd && inside(cwd, bases)) alive.push(rec.pid);
		}
		return alive;
	};
	const signal = (pid: number, sig: NodeJS.Signals) => {
		try {
			deps.kill(pid, sig);
		} catch {
			// Already gone or not ours to signal.
		}
	};
	const matched = await sameProcessInside();
	for (const pid of matched) signal(pid, "SIGTERM");
	if (matched.length === 0) return { matched, survivors: [] };
	await deps.sleep(deps.graceMs);
	for (const pid of await sameProcessInside()) signal(pid, "SIGKILL");
	await deps.sleep(200);
	return { matched, survivors: await sameProcessInside() };
}
