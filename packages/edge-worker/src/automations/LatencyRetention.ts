import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, mkdirSync, openSync } from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import {
	type LatencyRetention,
	type LatencySnapshot,
	latencyStages,
} from "./Latency.js";

const numeric = z.number().finite().nonnegative();
const metric = z
	.object({
		durationMs: numeric.max(600000),
		flag: z.enum(["failed", "capped"]).optional(),
	})
	.strict();
const hosted = z
	.object({
		cyrus_auth: metric.optional(),
		cyrus_body: metric.optional(),
		cyrus_event: metric.optional(),
		cyrus_admit: metric.optional(),
		cyrus_commit: metric.optional(),
		cyrus_callback: metric.optional(),
		cyrus_interrupt: metric.optional(),
		cyrus_total: metric.optional(),
	})
	.strict();
const mcpHosted = z
	.object({
		cyrus_mcp_preflight: metric.optional(),
		cyrus_mcp_authorize: metric.optional(),
		cyrus_mcp_sql: metric.optional(),
		cyrus_mcp_connection: metric.optional(),
		cyrus_mcp_selection: metric.optional(),
		cyrus_mcp_source_validation: metric.optional(),
		cyrus_mcp_session: metric.optional(),
		cyrus_total: metric.optional(),
	})
	.strict();
const snapshotSchema = z
	.object({
		version: z.literal(1),
		retention: z.literal("process-memory"),
		attempt: z.number().int().positive(),
		elapsedMs: numeric,
		finished: z.literal(true),
		droppedSpans: numeric.int(),
		spans: z
			.array(
				z
					.object({
						stage: z.enum(latencyStages),
						startMs: numeric,
						durationMs: numeric.optional(),
						failed: z.literal(true).optional(),
						hosted: z.union([hosted, mcpHosted]).optional(),
					})
					.strict(),
			)
			.max(128),
	})
	.strict();
const documentSchema = z
	.array(
		z
			.object({
				key: z.string().regex(/^[a-f0-9]{64}$/),
				savedAt: numeric.int(),
				snapshot: snapshotSchema,
			})
			.strict(),
	)
	.max(64);
type Document = z.infer<typeof documentSchema>;
const MAX_BYTES = 2 * 1024 * 1024;
const TTL = 24 * 60 * 60 * 1000;
const hash = (value: string) =>
	createHash("sha256").update(value).digest("hex");
interface Database {
	exec(sql: string): void;
	prepare(sql: string): {
		get(): { body: string } | undefined;
		run(body: string): unknown;
	};
	close(): void;
}

/** Best-effort diagnostic store. Never read by admission, checkpoint or model code. */
export class PrivateLatencyRetention implements LatencyRetention {
	constructor(
		private readonly directory: string,
		private readonly workspaceId: string,
		private readonly now = Date.now,
	) {}
	private transact<T>(
		update: (rows: Document, now: number) => T,
	): T | undefined {
		let db: Database | undefined;
		try {
			if (!isAbsolute(this.directory) || !this.workspaceId) return;
			mkdirSync(this.directory, { recursive: true, mode: 0o700 });
			const dir = lstatSync(this.directory);
			if (
				!dir.isDirectory() ||
				dir.uid !== process.getuid?.() ||
				dir.mode & 0o077
			)
				return;
			const path = join(this.directory, `${hash(this.workspaceId)}.sqlite`);
			try {
				closeSync(
					openSync(
						path,
						constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
						0o600,
					),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") return;
			}
			const file = lstatSync(path);
			if (
				!file.isFile() ||
				file.uid !== process.getuid?.() ||
				file.mode & 0o077 ||
				file.nlink !== 1 ||
				file.size > 4 * 1024 * 1024
			)
				return;
			const { DatabaseSync } = createRequire(import.meta.url)(
				"node:sqlite",
			) as { DatabaseSync: new (path: string) => Database };
			db = new DatabaseSync(path);
			// Separate from the scheduling ledger. Never wait for a diagnostic writer.
			db.exec(
				"PRAGMA busy_timeout=0; PRAGMA secure_delete=ON; PRAGMA page_size=4096; PRAGMA max_page_count=1024; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS traces (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL); BEGIN IMMEDIATE",
			);
			const row = db.prepare("SELECT body FROM traces WHERE id=1").get();
			let rows: Document = [];
			if (row && Buffer.byteLength(row.body) <= MAX_BYTES) {
				try {
					rows = documentSchema.parse(JSON.parse(row.body));
				} catch {
					/* Invalid diagnostics are unavailable, never echoed. */
				}
			}
			const now = this.now();
			rows = rows.filter((r) => r.savedAt <= now && now - r.savedAt < TTL);
			const result = update(rows, now);
			let body = JSON.stringify(rows);
			while (rows.length > 64 || Buffer.byteLength(body) > MAX_BYTES) {
				rows.shift();
				body = JSON.stringify(rows);
			}
			if (row?.body !== body)
				db.prepare(
					"INSERT INTO traces(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
				).run(body);
			db.exec("COMMIT");
			return result;
		} catch {
			return undefined; // No raw error/path, and no effect on work success.
		} finally {
			try {
				db?.close();
			} catch {
				/* No diagnostics failure escapes. */
			}
		}
	}
	save(id: string, snapshot: LatencySnapshot): void {
		const parsed = snapshotSchema.safeParse(snapshot);
		if (!parsed.success) return;
		this.transact((rows, now) => {
			const key = hash(id),
				index = rows.findIndex((r) => r.key === key);
			if (index >= 0) {
				if (rows[index]!.snapshot.attempt >= parsed.data.attempt) return;
				rows.splice(index, 1);
			}
			rows.push({ key, savedAt: now, snapshot: parsed.data });
		});
	}
	read(id: string): LatencySnapshot | undefined {
		return this.readMany([id]).get(id);
	}
	readMany(ids: readonly string[]): Map<string, LatencySnapshot> {
		return (
			this.transact((rows) => {
				const requested = new Map(ids.map((id) => [hash(id), id]));
				const result = new Map<string, LatencySnapshot>();
				for (const row of rows) {
					const id = requested.get(row.key);
					if (id !== undefined)
						result.set(id, { ...row.snapshot, retention: "private-disk" });
				}
				return result;
			}) ?? new Map()
		);
	}
}
