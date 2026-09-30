import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	admissionSchema,
	modelStepSchema,
	toolCallSchema,
} from "./contract.js";
import { engineeringFilesSchema } from "./Engineering.js";

export const messageSchema = z
	.object({
		role: z.enum(["user", "assistant"]),
		content: z.string().max(500_000),
	})
	.strict();
export type AutomationMessage = z.infer<typeof messageSchema>;
export const automationToolOutputSchema = z
	.object({
		items: z
			.array(z.object({ text: z.string().max(100_000) }).strict())
			.max(100),
		nextCursor: z.string().max(2000).nullable(),
	})
	.strict();
export const checkpointSchema = z
	.object({
		version: z.literal(1),
		scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
		messages: z.array(messageSchema).max(100),
		sequence: z.number().int().nonnegative().max(24),
		pending: z
			.object({
				key: z.string().regex(/^[a-f0-9]{64}$/),
				step: modelStepSchema,
				result: automationToolOutputSchema.optional(),
				engineeringFiles: engineeringFilesSchema.optional(),
			})
			.strict()
			.optional(),
		status: z.enum(["running", "completed"]),
		engineeringFiles: engineeringFilesSchema.optional(),
		sessionDelivery: admissionSchema.shape.sessionDelivery,
		sessionDeliveryAuthority: admissionSchema.shape.sessionDeliveryAuthority,
		native: z
			.object({
				threadId: z.string().uuid(),
				rollout: z.string().max(2700000),
				tool: z
					.object({
						sequence: z.number().int().min(0).max(24),
						call: toolCallSchema,
					})
					.strict()
					.optional(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type AutomationCheckpoint = z.infer<typeof checkpointSchema>;

/** Dedicated checkpoint type/directory; no legacy/native session can be loaded here. */
export class AutomationCheckpointStore {
	constructor(private readonly directory: string) {
		if (!isAbsolute(directory))
			throw new Error("Absolute checkpoint directory required");
	}
	private async path(key: string) {
		if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid checkpoint key");
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const stat = await lstat(this.directory);
		if (
			!stat.isDirectory() ||
			stat.uid !== process.getuid?.() ||
			stat.mode & 0o077
		)
			throw new Error("Unsafe checkpoint directory");
		return join(this.directory, `${key}.json`);
	}
	async load(key: string): Promise<AutomationCheckpoint | undefined> {
		const path = await this.path(key);
		try {
			const handle = await open(
				path,
				constants.O_RDONLY | constants.O_NOFOLLOW,
			);
			try {
				const stat = await handle.stat();
				if (
					!stat.isFile() ||
					stat.uid !== process.getuid?.() ||
					stat.mode & 0o077 ||
					stat.size > 4_000_000
				)
					throw new Error("Unsafe checkpoint");
				const state = checkpointSchema.parse(
					JSON.parse(await handle.readFile("utf8")),
				);
				if (state.scopeKey !== key)
					throw new Error("Checkpoint scope mismatch");
				return state;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	async save(checkpoint: AutomationCheckpoint): Promise<void> {
		const state = checkpointSchema.parse(checkpoint);
		const serialized = JSON.stringify(state);
		if (Buffer.byteLength(serialized) > 4_000_000)
			throw new Error("Checkpoint limit exceeded");
		const path = await this.path(state.scopeKey);
		const temp = `${path}.${randomUUID()}.tmp`;
		const handle = await open(temp, "wx", 0o600);
		try {
			await handle.writeFile(serialized);
			await handle.sync();
		} finally {
			await handle.close();
		}
		try {
			await rename(temp, path);
			const dir = await open(this.directory, "r");
			try {
				await dir.sync();
			} finally {
				await dir.close();
			}
		} finally {
			await unlink(temp).catch(() => {});
		}
	}
}
