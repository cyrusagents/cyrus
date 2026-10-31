import { execFile } from "node:child_process";
import { readlink, realpath } from "node:fs/promises";

/**
 * Restart reconciliation for Jira task worktrees — REPORT ONLY.
 *
 * A runner's model subprocess can outlive an abruptly killed Cyrus process
 * (observed: the Claude Code child kept running in its worktree after the
 * worker was SIGKILLed). While a Jira task runs, the runtime records its OWN
 * descendant processes whose working directory is inside the task worktree
 * as (pid, start time). After a restart the closed context already refuses
 * new work in that worktree; this module only reports which recorded
 * identities may still be running so an operator can stop them.
 *
 * It deliberately never signals. Node exposes no race-free process handle
 * (no pidfd), `ps` start times have one-second precision, and any check is
 * followed by an asynchronous gap before `kill(pid)`: a recorded process can
 * exit and its pid be reused in between, so a signal could hit an unrelated
 * process. Until a safe identity primitive is available, automatic stopping
 * is deferred. (A process-environment marker was considered, but macOS does
 * not expose other processes' environments.)
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

export interface InspectionResult {
	/** Recorded identity (same pid AND start time) still present: may still be running. */
	possiblyRunning: OwnedProcess[];
	/** Recorded pid gone, or reused by a process with a different start time. */
	gone: OwnedProcess[];
	/** Inspection itself failed: nothing is known about these. */
	unknown: OwnedProcess[];
}

/**
 * Classify recorded processes after a restart without signalling anything.
 * A matching identity counts as possibly running wherever its cwd now is:
 * leaving the worktree is not evidence that it stopped.
 */
export async function inspectOwnedProcesses(
	recorded: readonly OwnedProcess[],
	probe: ProcessProbe = systemProcessProbe,
): Promise<InspectionResult> {
	const result: InspectionResult = {
		possiblyRunning: [],
		gone: [],
		unknown: [],
	};
	if (recorded.length === 0) return result;
	let table: ProcessRow[];
	try {
		table = await probe.table();
	} catch {
		result.unknown.push(...recorded);
		return result;
	}
	for (const rec of recorded) {
		const row = table.find((r) => r.pid === rec.pid);
		if (row && row.started === rec.started && rec.pid !== process.pid)
			result.possiblyRunning.push(rec);
		else result.gone.push(rec);
	}
	return result;
}
