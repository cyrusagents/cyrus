import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";

/**
 * Durable per-context journal for Jira remote-agent tasks.
 *
 * One JSON file per Jira context at
 * `<cyrusHome>/jira-agent/contexts/<contextId>.json`. Every write is atomic
 * (temp file → fsync → rename) and a failed write throws: callers must never
 * report a state they could not persist.
 *
 * The journal is the source of truth for idempotency (`messageHashes`), the
 * pinned binding of a context (workspace/installation/account/repository and
 * Jira issue), the single-writer reservation (`settled`), and the runner
 * session to resume for later tasks in the same context.
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
	initialText: string;
	/** Follow-ups not yet delivered to the runner, in arrival order. */
	pendingFollowups: string[];
	progress: JiraProgressEntry[];
	nextSeq: number;
	result: string | null;
	error: string | null;
	createdAt: string;
	updatedAt: string;
}

export interface JiraContextRecord {
	version: 1;
	contextId: string;
	binding: JiraBinding;
	issue: JiraIssueRef;
	workspacePath: string | null;
	/** Runner that last executed in this context, and its resumable session. */
	runnerType: string | null;
	runnerSessionId: string | null;
	tasks: JiraTaskRecord[];
}

export const RESTART_MESSAGE =
	"Cyrus restarted while this task was running; send a follow-up to continue.";

const UUID_RE =
	/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
	return UUID_RE.test(value);
}

/** Keep at most this many tasks per context (oldest settled ones dropped). */
const MAX_TASKS_PER_CONTEXT = 50;

export class JiraAgentJournal {
	private readonly dir: string;
	private readonly contexts = new Map<string, JiraContextRecord>();
	private readonly taskIndex = new Map<string, string>();

	constructor(
		cyrusHome: string,
		private readonly logger: ILogger,
	) {
		this.dir = join(cyrusHome, "jira-agent", "contexts");
	}

	/**
	 * Load every context. Any task that was not terminal when the process
	 * stopped is marked failed (the runner died with the process) and the
	 * change is persisted before the journal is used.
	 */
	async load(now: Date = new Date()): Promise<void> {
		await mkdir(this.dir, { recursive: true });
		const files = (await readdir(this.dir)).filter((f) => f.endsWith(".json"));
		for (const file of files) {
			const contextId = file.slice(0, -".json".length);
			if (!isUuid(contextId)) continue;
			let record: JiraContextRecord;
			try {
				record = JSON.parse(
					await readFile(join(this.dir, file), "utf8"),
				) as JiraContextRecord;
			} catch (error) {
				this.logger.error(
					`[JiraAgent] Unreadable journal ${file}; leaving it untouched`,
					error instanceof Error ? error : new Error(String(error)),
				);
				continue;
			}
			if (record.version !== 1 || record.contextId !== contextId) continue;
			let changed = false;
			for (const task of record.tasks) {
				if (!TERMINAL_STATES.has(task.state) || !task.settled) {
					task.state = "failed";
					task.settled = true;
					task.error = RESTART_MESSAGE;
					task.pendingFollowups = [];
					task.updatedAt = now.toISOString();
					changed = true;
				}
			}
			this.contexts.set(contextId, record);
			for (const task of record.tasks)
				this.taskIndex.set(task.taskId, contextId);
			if (changed) await this.save(record);
		}
	}

	getContext(contextId: string): JiraContextRecord | undefined {
		return this.contexts.get(contextId);
	}

	contextOfTask(taskId: string): string | undefined {
		return this.taskIndex.get(taskId);
	}

	findTask(
		record: JiraContextRecord,
		taskId: string,
	): JiraTaskRecord | undefined {
		return record.tasks.find((t) => t.taskId === taskId);
	}

	/** Register a brand-new context in memory (persist with `save`). */
	putContext(record: JiraContextRecord): void {
		this.contexts.set(record.contextId, record);
		for (const task of record.tasks) {
			this.taskIndex.set(task.taskId, record.contextId);
		}
	}

	/** Remove a context that was never persisted (failed first write). */
	forgetContext(contextId: string): void {
		const record = this.contexts.get(contextId);
		if (!record) return;
		for (const task of record.tasks) this.taskIndex.delete(task.taskId);
		this.contexts.delete(contextId);
	}

	indexTask(contextId: string, taskId: string): void {
		this.taskIndex.set(taskId, contextId);
	}

	unindexTask(taskId: string): void {
		this.taskIndex.delete(taskId);
	}

	/** Atomically persist a context. Throws on any I/O failure. */
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

	private trim(record: JiraContextRecord): void {
		while (record.tasks.length > MAX_TASKS_PER_CONTEXT) {
			const idx = record.tasks.findIndex(
				(t) => t.settled && TERMINAL_STATES.has(t.state),
			);
			if (idx < 0) break;
			const [removed] = record.tasks.splice(idx, 1);
			if (removed) this.taskIndex.delete(removed.taskId);
		}
	}

	allContexts(): JiraContextRecord[] {
		return [...this.contexts.values()];
	}
}
