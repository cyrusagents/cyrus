import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { BoardLog } from "./StatusBoard.js";

const MAX_TASKS = 200;
const MAX_LOGS = 100;
const MAX_BYTES = 16 * 1024 * 1024;
const text = z.string().max(4100);
const taskSchema = z.object({
	id: text,
	issue: text,
	linearWorkspaceSlug: text.optional(),
	title: text,
	status: z.enum(["running", "completed", "error", "idle"]),
	reason: text,
	model: text,
	reasoningEffort: text.optional(),
	fastMode: z.boolean().optional(),
	createdAt: z.number().finite(),
	lastActivityAt: z.number().finite(),
	turnStartedAt: z.number().finite(),
	quiet: z.boolean(),
	repositories: z.array(text).max(100),
	archived: z.boolean().optional(),
});
const logSchema = z.object({
	at: z.number().finite(),
	source: text,
	level: z.enum(["debug", "info", "warning", "error"]),
	kind: z.enum(["activity", "tool", "output", "lifecycle", "service"]),
	text,
	sessionId: text.optional(),
	issue: text.optional(),
	toolCallId: z
		.string()
		.regex(/^[a-f0-9]{64}$/)
		.optional(),
});
const recordSchema = z.object({
	task: taskSchema,
	logs: z.array(logSchema).max(MAX_LOGS),
});
export type BoardTask = z.infer<typeof taskSchema>;
type HistoryRecord = z.infer<typeof recordSchema>;

/** Small, display-only archive. Never restores runners or includes raw sessions. */
export class BoardHistory {
	private records = new Map<string, HistoryRecord>();
	private loading: Promise<void>;
	private writing: Promise<void> = Promise.resolve();
	warning = "";

	constructor(
		private path?: string,
		private sanitize: (value: string) => string = (value) => value,
	) {
		this.loading = this.load();
	}
	ready(): Promise<void> {
		return this.loading;
	}
	async flush(): Promise<void> {
		await this.loading;
		await this.writing;
	}
	tasks(): BoardTask[] {
		return [...this.records.values()].map(({ task }) => task);
	}
	logs(id: string): BoardLog[] {
		return this.records.get(id)?.logs ?? [];
	}

	add(task: BoardTask, logs: BoardLog[]): void {
		this.records.set(
			task.id,
			this.normalize({ task, logs: logs.slice(-MAX_LOGS) }),
		);
		this.prune();
		this.writing = this.writing
			.then(async () => {
				await this.loading;
				if (!this.path) return;
				this.prune();
				await mkdir(dirname(this.path), { recursive: true });
				await writeFile(`${this.path}.tmp`, this.serialize(), { mode: 0o600 });
				await rename(`${this.path}.tmp`, this.path);
				this.warning = "";
			})
			.catch(() => {
				this.warning =
					"Task history could not be saved. It may be lost on restart.";
			});
	}
	private normalize(record: HistoryRecord): HistoryRecord {
		const parsed = recordSchema.parse(record);
		const task = { ...parsed.task, archived: true, quiet: false };
		for (const key of ["issue", "title", "reason", "model"] as const)
			task[key] = this.sanitize(task[key]);
		if (task.linearWorkspaceSlug)
			task.linearWorkspaceSlug = this.sanitize(task.linearWorkspaceSlug);
		if (task.reasoningEffort)
			task.reasoningEffort = this.sanitize(task.reasoningEffort);
		task.repositories = task.repositories.map(this.sanitize);
		if (task.status === "running") task.status = "idle";
		return {
			task,
			logs: parsed.logs.map((log) => ({
				...log,
				text: this.sanitize(log.text),
				source: this.sanitize(log.source),
			})),
		};
	}
	private serialize(): string {
		return JSON.stringify({ version: 1, records: [...this.records.values()] });
	}
	private prune(): void {
		this.records = new Map(
			[...this.records.values()]
				.sort((a, b) => b.task.lastActivityAt - a.task.lastActivityAt)
				.slice(0, MAX_TASKS)
				.map((record) => [record.task.id, record]),
		);
		while (
			Buffer.byteLength(this.serialize()) > MAX_BYTES &&
			this.records.size
		) {
			const oldest = [...this.records.keys()].at(-1);
			if (oldest !== undefined) this.records.delete(oldest);
		}
	}
	private async load(): Promise<void> {
		if (!this.path) return;
		try {
			if ((await stat(this.path)).size > MAX_BYTES)
				throw Error("Archive too large");
			const data = z
				.object({
					version: z.literal(1),
					records: z.array(recordSchema).max(MAX_TASKS),
				})
				.parse(JSON.parse(await readFile(this.path, "utf8")));
			for (const record of data.records) {
				if (!this.records.has(record.task.id))
					this.records.set(record.task.id, this.normalize(record));
			}
			this.prune();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.warning =
					"Saved task history could not be read. Current tasks are still available.";
		}
	}
}
