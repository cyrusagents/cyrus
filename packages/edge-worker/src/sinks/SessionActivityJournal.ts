import { createHash } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	lstatSync,
	mkdirSync,
	openSync,
} from "node:fs";
import { createRequire } from "node:module";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import type { CyrusSessionDescriptor } from "./IActivitySink.js";
import {
	type ExecutionTimingState,
	executionTimingStateSchema,
} from "./SessionExecutionTiming.js";
import {
	canonicalSessionJson,
	cyrusSessionDescriptorSchema,
	parseSessionDeliveryItem,
	type SessionDeliveryAck,
	type SessionDeliveryItem,
	sessionDeliveryDigest,
	verifySessionDeliveryAck,
} from "./session-delivery.js";

const stateSchema = z
	.object({
		version: z.literal(1),
		sessions: z
			.array(
				z
					.object({
						descriptor: cyrusSessionDescriptorSchema,
						execution: executionTimingStateSchema.optional(),
						sources: z
							.array(
								z
									.object({
										key: z.string().min(1).max(300),
										sequence: z.number().int().positive(),
										digest: z.string().regex(/^[a-f0-9]{64}$/),
									})
									.strict(),
							)
							.max(4096)
							.default([]),
						nextSequence: z.number().int().positive().safe(),
						ackSequence: z.number().int().nonnegative().safe(),
						ackDigest: z
							.string()
							.regex(/^[a-f0-9]{64}$/)
							.nullable(),
					})
					.strict(),
			)
			.max(512),
		pending: z.array(z.unknown()).max(1024),
	})
	.strict();
type State = Omit<z.infer<typeof stateSchema>, "pending"> & {
	pending: SessionDeliveryItem[];
};
interface Database {
	exec(sql: string): void;
	prepare(sql: string): {
		get(): { body: string } | undefined;
		run(body: string): unknown;
	};
	close(): void;
}

/** Durable transport receipts only; this journal never schedules or claims work. */
export class SessionActivityJournal {
	readonly id: string;
	private readonly db: Database;
	constructor(directory: string, workspaceId: string, namespace: string) {
		if (!isAbsolute(directory) || !workspaceId || !namespace)
			throw new Error(
				"Bound workspace, namespace and absolute journal directory required",
			);
		this.id = `cyrus:${createHash("sha256").update(canonicalSessionJson({ workspaceId, namespace })).digest("hex")}`;
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const dir = lstatSync(directory);
		if (
			!dir.isDirectory() ||
			dir.uid !== process.getuid?.() ||
			dir.mode & 0o077
		)
			throw new Error("Unsafe session journal directory");
		const file = join(directory, `${this.id.slice(6)}.sqlite`);
		if (!existsSync(file)) {
			try {
				closeSync(
					openSync(
						file,
						constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
						0o600,
					),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		const stat = lstatSync(file);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
			throw new Error("Unsafe session journal file");
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
			DatabaseSync: new (path: string) => Database;
		};
		this.db = new DatabaseSync(file);
		this.db.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS session_activity_journal (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
		);
	}
	private transact<T>(action: (state: State) => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db
				.prepare("SELECT body FROM session_activity_journal WHERE id=1")
				.get();
			if (row && Buffer.byteLength(row.body) > 16_777_216)
				throw new Error("Session journal exceeds byte limit");
			const parsed = row
				? stateSchema.parse(JSON.parse(row.body))
				: { version: 1 as const, sessions: [], pending: [] };
			const state: State = {
				...parsed,
				pending: parsed.pending.map(parseSessionDeliveryItem),
			};
			const result = action(state);
			stateSchema.parse(state);
			const encoded = JSON.stringify(state);
			if (Buffer.byteLength(encoded) > 16_777_216)
				throw new Error("Session journal exceeds byte limit");
			this.db
				.prepare(
					"INSERT INTO session_activity_journal(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
				)
				.run(encoded);
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	create(
		descriptor: CyrusSessionDescriptor,
		remoteParentAcknowledged = false,
	): SessionDeliveryItem {
		const item = parseSessionDeliveryItem({
			sessionId: descriptor.id,
			sequence: 1,
			kind: "session",
			payload: descriptor,
		});
		return this.transact((state) => {
			const existing = state.sessions.find(
				(s) => s.descriptor.id === descriptor.id,
			);
			if (existing) {
				if (
					canonicalSessionJson(existing.descriptor) !==
					canonicalSessionJson(descriptor)
				)
					throw new Error("Session identity cannot change");
				return item;
			}
			if (
				descriptor.parentSessionId &&
				!remoteParentAcknowledged &&
				!state.sessions.some(
					(s) =>
						s.descriptor.id === descriptor.parentSessionId &&
						s.ackSequence >= 1,
				)
			)
				throw new Error("Parent creation must be acknowledged first");
			state.sessions.push({
				descriptor: cyrusSessionDescriptorSchema.parse(descriptor),
				sources: [],
				nextSequence: 2,
				ackSequence: 0,
				ackDigest: null,
			});
			state.pending.push(item);
			return item;
		});
	}
	append(
		sessionId: string,
		event:
			| {
					kind: "activity";
					payload: Extract<
						SessionDeliveryItem,
						{ kind: "activity" }
					>["payload"];
			  }
			| {
					kind: "lifecycle";
					payload: Extract<
						SessionDeliveryItem,
						{ kind: "lifecycle" }
					>["payload"];
			  },
		sourceKey?: string,
	): SessionDeliveryItem {
		return this.transact((state) => {
			const session = state.sessions.find((s) => s.descriptor.id === sessionId);
			if (!session || session.ackSequence < 1)
				throw new Error("Session has no admitted creation receipt");
			const previous = sourceKey
				? session.sources.find((source) => source.key === sourceKey)
				: undefined;
			const item = parseSessionDeliveryItem({
				sessionId,
				sequence: previous?.sequence ?? session.nextSequence,
				...event,
			});
			if (previous) {
				if (previous.digest !== sessionDeliveryDigest(item))
					throw new Error("Source event changed on replay");
				return item;
			}
			if (sourceKey)
				session.sources.push({
					key: sourceKey,
					sequence: item.sequence,
					digest: sessionDeliveryDigest(item),
				});
			session.nextSequence++;
			state.pending.push(item);
			return item;
		});
	}
	peek(
		excludedSessions: ReadonlySet<string> = new Set(),
	): SessionDeliveryItem | undefined {
		return this.transact((state) =>
			state.pending.find((item) => !excludedSessions.has(item.sessionId)),
		);
	}
	acknowledge(
		item: SessionDeliveryItem,
		response: unknown,
	): SessionDeliveryAck {
		const ack = verifySessionDeliveryAck(response, item);
		return this.transact((state) => {
			const session = state.sessions.find(
				(s) => s.descriptor.id === item.sessionId,
			);
			if (!session) throw new Error("Unknown session receipt");
			// Another process can already have acknowledged an identical delivery.
			if (
				session.ackSequence === item.sequence &&
				session.ackDigest === ack.digest
			)
				return ack;
			const index = state.pending.findIndex(
				(pending) => pending.sessionId === item.sessionId,
			);
			const head = state.pending[index];
			if (
				!head ||
				sessionDeliveryDigest(head) !== ack.digest ||
				session.ackSequence + 1 !== item.sequence
			)
				throw new Error("Out-of-order session acknowledgement");
			state.pending.splice(index, 1);
			session.ackSequence = item.sequence;
			session.ackDigest = ack.digest;
			return ack;
		});
	}
	isCreated(sessionId: string): boolean {
		return this.transact((state) =>
			state.sessions.some(
				(s) => s.descriptor.id === sessionId && s.ackSequence >= 1,
			),
		);
	}
	execution(
		sessionId: string,
		update?: (state: ExecutionTimingState | undefined) => ExecutionTimingState,
	): ExecutionTimingState | undefined {
		return this.transact((state) => {
			const session = state.sessions.find((s) => s.descriptor.id === sessionId);
			if (!session || session.ackSequence < 1)
				throw new Error("Session has no admitted creation receipt");
			if (update)
				session.execution = executionTimingStateSchema.parse(
					update(session.execution),
				);
			return session.execution;
		});
	}

	close(): void {
		this.db.close();
	}
}
