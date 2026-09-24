import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { definitionSchema, runSchema } from "./types.js";

const schema = z.object({
	version: z.literal(1),
	definitions: z.array(definitionSchema),
	runs: z.array(runSchema),
});
export type AutomationState = z.infer<typeof schema>;

/** A single owner, copy-on-write transactions, and durable replace-before-dispatch. */
export class AutomationStore {
	private state: AutomationState = { version: 1, definitions: [], runs: [] };
	private queue: Promise<unknown> = Promise.resolve();
	private owned = false;
	private owner = `${process.pid}:${randomUUID()}`;
	error = "";
	constructor(private directory: string) {}
	async open(): Promise<void> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const lock = join(this.directory, "owner.lock");
		try {
			const handle = await open(lock, "wx", 0o600);
			await handle.writeFile(this.owner);
			await handle.close();
			this.owned = true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			const owner = await readFile(lock, "utf8");
			const pid = Number(owner.split(":")[0]);
			if (!Number.isSafeInteger(pid) || pid <= 0)
				throw new Error("Invalid automation lock; manual recovery required");
			try {
				process.kill(pid, 0);
			} catch (probe) {
				if ((probe as NodeJS.ErrnoException).code === "ESRCH") {
					// Serialize stale-owner recovery so two starters cannot remove a newly acquired lock.
					const recoveryPath = join(this.directory, "recovery.lock");
					const recovery = await open(recoveryPath, "wx", 0o600);
					try {
						if ((await readFile(lock, "utf8")) === owner) await unlink(lock);
					} finally {
						await recovery.close();
						await unlink(recoveryPath);
					}
					return this.open();
				}
			}
			throw new Error("Another worker owns the automation store");
		}
		try {
			this.state = schema.parse(
				JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")),
			);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				await this.close();
				throw error;
			}
		}
	}
	read(): AutomationState {
		return structuredClone(this.state);
	}
	async transact<T>(change: (state: AutomationState) => T): Promise<T> {
		const operation = this.queue.then(async () => {
			if (!this.owned || this.error)
				throw new Error(this.error || "Automation store is closed");
			const next = this.read();
			const result = change(next);
			schema.parse(next);
			try {
				const temp = join(this.directory, `${this.owner}.tmp`);
				const handle = await open(temp, "w", 0o600);
				try {
					await handle.writeFile(JSON.stringify(next));
					await handle.sync();
				} finally {
					await handle.close();
				}
				await rename(temp, join(this.directory, "state.json"));
				const directory = await open(this.directory, "r");
				try {
					await directory.sync();
				} finally {
					await directory.close();
				}
				this.state = next;
			} catch (error) {
				this.error =
					"Automation storage failed. Dispatch is stopped; restart after fixing storage.";
				throw error;
			}
			return structuredClone(result);
		});
		this.queue = operation.catch(() => {});
		return operation;
	}
	async close() {
		await this.queue;
		if (this.owned) {
			const lock = join(this.directory, "owner.lock");
			if ((await readFile(lock, "utf8")) === this.owner) await unlink(lock);
			this.owned = false;
		}
	}
}
