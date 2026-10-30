import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";

/**
 * Durable per-context journal for Jira remote-agent tasks.
 *
 * One JSON file per Jira context at
 * `<cyrusHome>/jira-agent/contexts/<contextId>.json`. Every write is atomic
 * (temp file → fsync → rename) and a failed write throws.
 *
 * Callers never mutate a published record: they mutate a copy, `save` it,
 * and only then `publish` it, so what `getContext` returns is always what is
 * on disk (persist-before-publish).
 *
 * The journal is the source of truth for idempotency (`messageHashes`, kept
 * for retired tasks too), the pinned binding of a context, the single-writer
 * reservation (`settled`), pre-admission cancel tombstones (`admitted:
 * false`), closed contexts, and the runner session to resume.
 */

export type JiraTaskState =
	| "submitted"
	| "working"
	| "canceling"
	| "completed"
	| "failed"
	| "canceled";

export const TERMINAL_STATES: ReadonlySet<JiraTaskState> = new Set([
	"completed",
	"failed",
	"canceled",
]);
const STATES: ReadonlySet<string> = new Set([
	"submitted",
	"working",
	"canceling",
	...TERMINAL_STATES,
]);

export interface JiraBinding {
	teamId: string;
	installationLinkId: string;
	accountLinkId: string;
	repositoryId: string;
}

export interface JiraIssueRef {
	id: string;
	key: string;
	summary: string;
	description: string;
}

export interface JiraProgressEntry {
	seq: number;
	at: string;
	text: string;
}

export interface JiraTaskRecord {
	taskId: string;
	/** messageId → sha256 of the canonical request body that carried it. */
	messageHashes: Record<string, string>;
	state: JiraTaskState;
	/**
	 * False while an execution for this task may still be running (or may
	 * still start). The context stays reserved until every task is settled.
	 */
	settled: boolean;
	/**
	 * False only for a pre-admission cancel tombstone: Hosted canceled a task
	 * this runtime never accepted, and any later create for it is refused.
	 */
	admitted: boolean;
	initialText: string;
	/** Committed follow-ups not yet delivered to the runner, in order. */
	pendingFollowups: string[];
	progress: JiraProgressEntry[];
	nextSeq: number;
	result: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

/** What remains of a task trimmed from a long context: enough for dedupe. */
export interface JiraRetiredTask {
	state: JiraTaskState;
	admitted: boolean;
	messageHashes: Record<string, string>;
}

export interface JiraContextRecord {
	version: 1;
	contextId: string;
	binding: JiraBinding;
	/** Null only for a context created by a pre-admission cancel tombstone. */
	issue: JiraIssueRef | null;
	workspacePath: string | null;
	/** Runner that last executed in this context, and its resumable session. */
	runnerType: string | null;
	runnerSessionId: string | null;
	/**
	 * Closed after a restart interrupted a task: an orphaned process may
	 * still touch the worktree, so no new task may run in this context.
	 */
	closed: boolean;
	/**
	 * This runtime's own descendant processes seen working in the worktree
	 * (pid + start time), so a restart can stop exactly those and nothing else.
	 */
	ownedProcesses: { pid: number; started: string }[];
	tasks: JiraTaskRecord[];
	retired: Record<string, JiraRetiredTask>;
}

export const RESTART_MESSAGE =
	"Cyrus restarted while this task was running. This conversation can't continue safely; assign the work item to Cyrus again to start a new one.";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Keep at most this many full tasks per context; older settled ones retire. */
const MAX_TASKS_PER_CONTEXT = 50;

const isStr = (v: unknown): v is string => typeof v === "string";
const isObj = (v: unknown): v is Record<string, unknown> =>
	!!v && typeof v === "object" && !Array.isArray(v);
const isHashMap = (v: unknown): v is Record<string, string> =>
	isObj(v) && Object.values(v).every(isStr);

/** Strict shape check of a stored context; throws on anything unexpected. */
export function parseContextRecord(
	raw: unknown,
	contextId: string,
): JiraContextRecord {
	const fail = (what: string): never => {
		throw new Error(`invalid journal record (${what})`);
	};
	if (!isObj(raw)) fail("not an object");
	const r = raw as Record<string, unknown>;
	if (r.version !== 1) fail("version");
	if (r.contextId !== contextId) fail("contextId");
	const b = r.binding;
	if (
		!isObj(b) ||
		!isStr(b.teamId) ||
		!isStr(b.installationLinkId) ||
		!isStr(b.accountLinkId) ||
		!isStr(b.repositoryId)
	)
		fail("binding");
	const i = r.issue;
	if (
		i !== null &&
		(!isObj(i) ||
			!isStr(i.id) ||
			!isStr(i.key) ||
			!isStr(i.summary) ||
			!isStr(i.description))
	)
		fail("issue");
	if (r.workspacePath !== null && !isStr(r.workspacePath)) fail("workspace");
	if (r.runnerType !== null && !isStr(r.runnerType)) fail("runnerType");
	if (r.runnerSessionId !== null && !isStr(r.runnerSessionId))
		fail("runnerSessionId");
	if (!Array.isArray(r.tasks)) fail("tasks");
	const tasks = (r.tasks as unknown[]).map((t) => {
		if (!isObj(t)) return fail("task");
		if (!isStr(t.taskId) || !isUuid(t.taskId)) fail("taskId");
		if (!isHashMap(t.messageHashes)) fail("messageHashes");
		if (!isStr(t.state) || !STATES.has(t.state)) fail("state");
		if (typeof t.settled !== "boolean") fail("settled");
		if (t.admitted !== undefined && typeof t.admitted !== "boolean")
			fail("admitted");
		if (!isStr(t.initialText)) fail("initialText");
		if (!Array.isArray(t.pendingFollowups) || !t.pendingFollowups.every(isStr))
			fail("pendingFollowups");
		if (
			!Array.isArray(t.progress) ||
			!t.progress.every(
				(p) =>
					isObj(p) && typeof p.seq === "number" && isStr(p.at) && isStr(p.text),
			)
		)
			fail("progress");
		if (typeof t.nextSeq !== "number") fail("nextSeq");
		if (t.result !== null && !isStr(t.result)) fail("result");
		if (t.error !== null && !isStr(t.error)) fail("error");
		if (!isStr(t.createdAt) || !isStr(t.updatedAt)) fail("timestamps");
		return { ...t, admitted: t.admitted ?? true } as JiraTaskRecord;
	});
	const retired = r.retired ?? {};
	if (
		!isObj(retired) ||
		!Object.entries(retired).every(
			([id, v]) =>
				isUuid(id) &&
				isObj(v) &&
				isStr(v.state) &&
				STATES.has(v.state) &&
				typeof v.admitted === "boolean" &&
				isHashMap(v.messageHashes),
		)
	)
		fail("retired");
	if (r.closed !== undefined && typeof r.closed !== "boolean") fail("closed");
	const owned = r.ownedProcesses ?? [];
	if (
		!Array.isArray(owned) ||
		!owned.every(
			(o) =>
				isObj(o) &&
				Number.isSafeInteger(o.pid) &&
				(o.pid as number) > 0 &&
				isStr(o.started),
		)
	)
		fail("ownedProcesses");
	return {
		version: 1,
		contextId,
		binding: b as unknown as JiraBinding,
		issue: (i ?? null) as JiraIssueRef | null,
		workspacePath: (r.workspacePath ?? null) as string | null,
		runnerType: (r.runnerType ?? null) as string | null,
		runnerSessionId: (r.runnerSessionId ?? null) as string | null,
		closed: r.closed === true,
		ownedProcesses: owned as { pid: number; started: string }[],
		tasks,
		retired: retired as Record<string, JiraRetiredTask>,
	};
}

export class JiraAgentJournal {
	private readonly dir: string;
	private readonly contexts = new Map<string, JiraContextRecord>();
	private readonly taskIndex = new Map<string, string>();
	/** Context ids whose stored file could not be read or validated. */
	private readonly quarantined = new Set<string>();

	constructor(
		cyrusHome: string,
		private readonly logger: ILogger,
	) {
		this.dir = join(cyrusHome, "jira-agent", "contexts");
	}

	/**
	 * Load every context. A context file that cannot be read or validated is
	 * quarantined (fail closed; never treated as a fresh context). Any task
	 * that was not settled when the process stopped is marked failed and its
	 * context is CLOSED: this runtime cannot prove the old execution's
	 * processes are gone, so no new writer may use that worktree. The change
	 * is persisted before the journal is used; a failure to persist throws.
	 */
	async load(now: Date = new Date()): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const files = (await readdir(this.dir)).filter(
			(f) => f.endsWith(".json") && !f.startsWith("."),
		);
		for (const file of files) {
			const contextId = file.slice(0, -".json".length);
			if (!isUuid(contextId)) continue;
			let record: JiraContextRecord;
			try {
				record = parseContextRecord(
					JSON.parse(await readFile(join(this.dir, file), "utf8")),
					contextId,
				);
			} catch (error) {
				this.quarantined.add(contextId);
				this.logger.error(
					`[JiraAgent] Journal for context ${contextId} is unreadable or invalid; quarantined`,
					error instanceof Error ? error : new Error(String(error)),
				);
				continue;
			}
			let changed = false;
			for (const task of record.tasks) {
				if (!task.settled || !TERMINAL_STATES.has(task.state)) {
					task.state = "failed";
					task.settled = true;
					task.error = RESTART_MESSAGE;
					task.pendingFollowups = [];
					task.updatedAt = now.toISOString();
					record.closed = true;
					changed = true;
				}
			}
			if (changed) await this.save(record);
			this.publish(record);
		}
	}

	/** Closed contexts with recorded own processes (restart reconciliation). */
	closedWithOwnedProcesses(): {
		workspacePath: string;
		processes: { pid: number; started: string }[];
	}[] {
		return [...this.contexts.values()]
			.filter((c) => c.closed && c.workspacePath && c.ownedProcesses.length > 0)
			.map((c) => ({
				workspacePath: c.workspacePath as string,
				processes: c.ownedProcesses,
			}));
	}

	isQuarantined(contextId: string): boolean {
		return this.quarantined.has(contextId);
	}

	getContext(contextId: string): JiraContextRecord | undefined {
		return this.contexts.get(contextId);
	}

	contextOfTask(taskId: string): string | undefined {
		return this.taskIndex.get(taskId);
	}

	/** Make a saved record the current one (call only after `save`). */
	publish(record: JiraContextRecord): void {
		const previous = this.contexts.get(record.contextId);
		if (previous) {
			for (const task of previous.tasks) this.taskIndex.delete(task.taskId);
			for (const id of Object.keys(previous.retired)) this.taskIndex.delete(id);
		}
		this.contexts.set(record.contextId, record);
		for (const task of record.tasks)
			this.taskIndex.set(task.taskId, record.contextId);
		for (const id of Object.keys(record.retired))
			this.taskIndex.set(id, record.contextId);
	}

	/** Atomically persist a record (not yet published). Throws on failure. */
	async save(record: JiraContextRecord): Promise<void> {
		this.trim(record);
		const target = join(this.dir, `${record.contextId}.json`);
		const temp = join(this.dir, `.${record.contextId}.${randomUUID()}.tmp`);
		const handle = await open(temp, "w", 0o600);
		try {
			await handle.writeFile(JSON.stringify(record), "utf8");
			await handle.sync();
		} catch (error) {
			await handle.close().catch(() => {});
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
		await handle.close();
		try {
			await rename(temp, target);
		} catch (error) {
			await rm(temp, { force: true }).catch(() => {});
			throw error;
		}
	}

	/** Old settled tasks retire to dedupe-only entries; never forgotten. */
	private trim(record: JiraContextRecord): void {
		while (record.tasks.length > MAX_TASKS_PER_CONTEXT) {
			const idx = record.tasks.findIndex(
				(t) => t.settled && TERMINAL_STATES.has(t.state),
			);
			if (idx < 0) break;
			const [removed] = record.tasks.splice(idx, 1);
			if (removed)
				record.retired[removed.taskId] = {
					state: removed.state,
					admitted: removed.admitted,
					messageHashes: removed.messageHashes,
				};
		}
	}

	allContexts(): JiraContextRecord[] {
		return [...this.contexts.values()];
	}
}
