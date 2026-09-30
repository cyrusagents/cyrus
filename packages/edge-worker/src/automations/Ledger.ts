import { randomUUID } from "node:crypto";
import {
	chmodSync,
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
import {
	type AutomationRegistration,
	digest,
	registrationSchema,
} from "./contract.js";
import {
	type AutomationDiagnostic,
	diagnosticSchema,
	FAILURE_HISTORY_LIMIT,
	failureHistoryEntrySchema,
	failureSchema,
} from "./Diagnostics.js";
import {
	type AutomationRecoveryRequest,
	recoveryReceiptSchema,
	recoveryRequestSchema,
} from "./Recovery.js";
import {
	AUTOMATION_LIMITS,
	instructionKey,
	latestTick,
	retryDelayMilliseconds,
} from "./scheduling.js";

const occurrenceSchema = z
	.object({
		id: z.string(),
		automationId: z.string(),
		revision: z.number().int(),
		input: z.string().max(100_000),
		trigger: z.enum(["instruction", "event", "tick"]),
		scheduledAt: z.string(),
		order: z.number().int(),
		lastFailure: failureSchema.optional(),
		failureHistory: z
			.array(failureHistoryEntrySchema)
			.max(FAILURE_HISTORY_LIMIT)
			.optional(),
		retryCycle: z
			.object({
				number: z.number().int().positive(),
				attemptsBase: z.number().int().nonnegative(),
			})
			.strict()
			.optional(),
		status: z.enum(["queued", "running", "completed", "cancelled", "blocked"]),
		attempts: z.number().int(),
		attemptId: z.string(),
		fence: z.number().int(),
		leaseUntil: z.number(),
		availableAt: z.number(),
		checkpointScope: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
		receipt: z
			.object({
				definition: registrationSchema,
				scopeKey: z.string().regex(/^[a-f0-9]{64}$/),
				attempts: z.number().int().positive(),
			})
			.strict()
			.optional(),
	})
	.strict();
export type AutomationOccurrence = z.infer<typeof occurrenceSchema>;
const stateSchema = z
	.object({
		version: z.literal(1),
		definitions: z.record(z.string(), registrationSchema),
		lastSlots: z.record(z.string(), z.number()),
		recoveryCommands: z
			.record(
				z.string(),
				z
					.object({
						request: recoveryRequestSchema,
						receipt: recoveryReceiptSchema,
					})
					.strict(),
			)
			.optional(),
		occurrences: z.record(z.string(), occurrenceSchema),
		order: z.number().int(),
	})
	.strict();
type State = z.infer<typeof stateSchema>;
interface Database {
	exec(sql: string): void;
	prepare(sql: string): {
		get(...args: unknown[]): { body: string } | undefined;
		run(...args: unknown[]): unknown;
	};
	close(): void;
}

/** One authoritative generic ledger. SQLite serializes claims across processes/restarts. */
export class AutomationLedger {
	private readonly db: Database;
	constructor(
		directory: string,
		private readonly workspaceId: string,
		private readonly clock = Date.now,
	) {
		if (!isAbsolute(directory) || !workspaceId)
			throw new Error(
				"Paired workspace and absolute ledger directory required",
			);
		mkdirSync(directory, { recursive: true, mode: 0o700 });
		const dir = lstatSync(directory);
		if (
			!dir.isDirectory() ||
			dir.uid !== process.getuid?.() ||
			dir.mode & 0o077
		)
			throw new Error("Unsafe automation ledger directory");
		const path = join(directory, `${digest(workspaceId)}.sqlite`);
		if (!existsSync(path)) {
			try {
				closeSync(
					openSync(
						path,
						constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
						0o600,
					),
				);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			}
		}
		const stat = lstatSync(path);
		if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.mode & 0o077)
			throw new Error("Unsafe automation ledger");
		// Node22+ built-in SQLite; no new native package or network/provider credential.
		const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
			DatabaseSync: new (path: string) => Database;
		};
		this.db = new DatabaseSync(path);
		this.db.exec(
			"PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS automation_state (id INTEGER PRIMARY KEY CHECK(id=1), body TEXT NOT NULL)",
		);
		chmodSync(path, 0o600);
	}
	private transact<T>(fn: (state: State, now: number) => T): T {
		this.db.exec("BEGIN IMMEDIATE");
		try {
			const row = this.db
				.prepare("SELECT body FROM automation_state WHERE id=1")
				.get();
			const state = row
				? stateSchema.parse(JSON.parse(row.body))
				: {
						version: 1 as const,
						definitions: {},
						lastSlots: {},
						occurrences: {},
						order: 0,
					};
			const result = fn(state, this.clock());
			const body = JSON.stringify(stateSchema.parse(state));
			if (Buffer.byteLength(body) > 16_000_000)
				throw new Error("Automation ledger capacity reached");
			this.db
				.prepare(
					"INSERT INTO automation_state(id,body) VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body",
				)
				.run(body);
			this.db.exec("COMMIT");
			return result;
		} catch (error) {
			this.db.exec("ROLLBACK");
			throw error;
		}
	}
	upsert(raw: unknown): AutomationRegistration {
		const definition = registrationSchema.parse(raw);
		if (definition.workspaceId !== this.workspaceId)
			throw new Error("Wrong automation workspace");
		return this.transact((state, now) => {
			const key = digest(definition.id);
			const old = state.definitions[key];
			if (old) {
				if (
					definition.revision < old.revision ||
					(definition.revision === old.revision &&
						digest(definition) !== digest(old))
				)
					throw new Error("Automation revision conflict");
				if (definition.revision === old.revision) return old;
				if (
					old.state === "deleted" ||
					old.ownerId !== definition.ownerId ||
					old.namespace !== definition.namespace ||
					old.scopeRef !== definition.scopeRef
				)
					throw new Error("Automation identity is immutable");
			} else if (Object.keys(state.definitions).length >= 1000)
				throw new Error("Automation definition limit");
			state.definitions[key] = definition;
			delete state.lastSlots[key];
			// Editing/resuming never replays ticks from a paused or superseded revision.
			const currentTick = old ? latestTick(definition, now, null) : null;
			if (currentTick) state.lastSlots[key] = currentTick.slot;
			for (const occurrence of Object.values(state.occurrences)) {
				if (
					occurrence.automationId === definition.id &&
					!occurrence.receipt &&
					!["completed", "cancelled"].includes(occurrence.status)
				)
					occurrence.status = "cancelled";
			}
			return definition;
		});
	}
	enqueue(
		automationId: string,
		revision: number,
		eventId: string,
		input: string,
		trigger: "instruction" | "event" = "instruction",
	): AutomationOccurrence {
		if (input.length > 100_000) throw new Error("Automation input limit");
		return this.transact((state, now) => {
			const definition = this.definition(state, automationId, revision);
			const key = instructionKey(definition, eventId, trigger);
			const old = state.occurrences[key];
			if (old) {
				if (old.input !== input) throw new Error("Occurrence payload conflict");
				return old;
			}
			return this.add(state, definition, key, input, trigger, now);
		});
	}
	/** Explicit operator recovery; command replay never resets a budget twice. */
	recover(raw: AutomationRecoveryRequest) {
		const request = recoveryRequestSchema.parse(raw);
		if (request.workspaceId !== this.workspaceId)
			throw new Error("Recovery workspace mismatch");
		return this.transact((state, now) => {
			const definition = this.definition(
				state,
				request.automationId,
				request.revision,
			);
			const occurrence = state.occurrences[request.occurrenceId];
			if (
				!occurrence ||
				definition.workspaceId !== request.workspaceId ||
				occurrence.automationId !== request.automationId ||
				occurrence.revision !== request.revision
			)
				throw new Error("Recovery occurrence mismatch");
			const key = digest(request.commandId);
			const old = state.recoveryCommands?.[key];
			if (old) {
				if (digest(old.request) !== digest(request))
					throw new Error("Recovery command conflict");
				return old.receipt;
			}
			if (
				occurrence.status !== "blocked" ||
				occurrence.fence !== request.expectedFence ||
				occurrence.leaseUntil > now
			)
				throw new Error("Recovery requires the current blocked fence");
			if (Object.keys(state.recoveryCommands ?? {}).length >= 10_000)
				throw new Error("Recovery command limit");
			if (
				Object.values(state.occurrences).filter(
					(o) =>
						o.automationId === request.automationId && o.status === "queued",
				).length >= AUTOMATION_LIMITS.queuedPerDefinition
			)
				throw new Error("Automation queue full");
			const cycle = (occurrence.retryCycle?.number ?? 0) + 1;
			const receipt = recoveryReceiptSchema.parse({
				...request,
				cycle,
				maxAttempts: AUTOMATION_LIMITS.maxAttempts,
				status: "accepted",
				acceptedAt: new Date(now).toISOString(),
			});
			state.recoveryCommands ??= {};
			state.recoveryCommands[key] = { request, receipt };
			occurrence.retryCycle = {
				number: cycle,
				attemptsBase: occurrence.attempts,
			};
			occurrence.status = "queued";
			occurrence.availableAt = now;
			occurrence.leaseUntil = 0;
			return receipt;
		});
	}
	private cycleAttempts(occurrence: AutomationOccurrence): number {
		// An explicit cycle counts all claims, including a transition to terminal receipt recovery.
		if (occurrence.retryCycle)
			return occurrence.attempts - occurrence.retryCycle.attemptsBase;
		return occurrence.receipt?.attempts ?? occurrence.attempts;
	}

	private definition(
		state: State,
		id: string,
		revision?: number,
	): AutomationRegistration {
		const definition = state.definitions[digest(id)];
		if (
			!definition ||
			definition.state !== "enabled" ||
			(revision !== undefined && definition.revision !== revision)
		)
			throw new Error("Automation definition unavailable");
		return definition;
	}
	private add(
		state: State,
		definition: AutomationRegistration,
		key: string,
		input: string,
		trigger: "instruction" | "event" | "tick",
		now: number,
	): AutomationOccurrence {
		if (
			Object.values(state.occurrences).filter(
				(o) => o.automationId === definition.id && o.status === "queued",
			).length >= AUTOMATION_LIMITS.queuedPerDefinition
		)
			throw new Error("Automation queue full");
		const occurrence: AutomationOccurrence = {
			id: key,
			automationId: definition.id,
			revision: definition.revision,
			input,
			trigger,
			scheduledAt: new Date(now).toISOString(),
			order: ++state.order,
			status: "queued",
			attempts: 0,
			attemptId: "",
			fence: 0,
			leaseUntil: 0,
			availableAt: now,
		};
		state.occurrences[key] = occurrence;
		return occurrence;
	}
	claim(
		limit: number,
		executeEnabled = true,
	): Array<{
		definition: AutomationRegistration;
		occurrence: AutomationOccurrence;
	}> {
		return this.transact((state, now) => {
			for (const [key, definition] of Object.entries(state.definitions)) {
				if (!executeEnabled) break;
				const tick = latestTick(definition, now, state.lastSlots[key] ?? null);
				if (!tick) continue;
				// Keep one queued coalesced tick; explicit instruction occurrences remain FIFO.
				for (const o of Object.values(state.occurrences))
					if (
						o.automationId === definition.id &&
						o.trigger === "tick" &&
						!o.receipt &&
						!o.retryCycle &&
						o.status === "queued"
					)
						o.status = "cancelled";
				const queued = Object.values(state.occurrences).filter(
					(o) => o.automationId === definition.id && o.status === "queued",
				).length;
				if (queued < AUTOMATION_LIMITS.queuedPerDefinition) {
					this.add(
						state,
						definition,
						tick.key,
						"Scheduled automation tick",
						"tick",
						Date.parse(tick.scheduledAt),
					);
					state.lastSlots[key] = tick.slot;
				}
			}
			for (const o of Object.values(state.occurrences)) {
				if (o.status === "running" && o.leaseUntil <= now) {
					o.status =
						this.cycleAttempts(o) >= AUTOMATION_LIMITS.maxAttempts
							? "blocked"
							: "queued";
				}
			}
			const running = Object.values(state.occurrences).filter(
				(o) => o.status === "running",
			);
			const busy = new Set(
				running.map(
					(o) => state.definitions[digest(o.automationId)]?.namespace,
				),
			);
			const claims: Array<{
				definition: AutomationRegistration;
				occurrence: AutomationOccurrence;
			}> = [];
			for (const o of Object.values(state.occurrences).sort(
				(a, b) => a.order - b.order,
			)) {
				if (
					claims.length >=
					Math.min(
						limit,
						AUTOMATION_LIMITS.workspaceConcurrency - running.length,
					)
				)
					break;
				const definition =
					o.receipt?.definition ?? state.definitions[digest(o.automationId)];
				if (
					!definition ||
					(!o.receipt &&
						(!executeEnabled ||
							definition.state !== "enabled" ||
							definition.revision !== o.revision)) ||
					o.status !== "queued" ||
					busy.has(definition.namespace)
				)
					continue;
				if (o.availableAt > now) {
					// Backoff does not let later arrivals overtake the same namespace.
					busy.add(definition.namespace);
					continue;
				}
				o.status = "running";
				o.attempts++;
				if (o.receipt) o.receipt.attempts++;
				o.fence++;
				o.attemptId = randomUUID();
				o.leaseUntil = now + AUTOMATION_LIMITS.leaseSeconds * 1000;
				busy.add(definition.namespace);
				claims.push({ definition, occurrence: { ...o } });
			}
			return claims;
		});
	}
	/** Pin admitted execution material before effects; retries cannot silently start a new scope. */
	bindCheckpoint(claim: AutomationOccurrence, scopeKey: string): void {
		z.string()
			.regex(/^[a-f0-9]{64}$/)
			.parse(scopeKey);
		this.transact((state, now) => {
			const o = state.occurrences[claim.id];
			if (
				!o ||
				o.status !== "running" ||
				o.attemptId !== claim.attemptId ||
				o.fence !== claim.fence ||
				o.leaseUntil <= now
			)
				throw new Error("Stale checkpoint owner");
			if (o.checkpointScope && o.checkpointScope !== scopeKey)
				throw new Error("Admitted checkpoint scope changed");
			o.checkpointScope = scopeKey;
		});
	}
	/** Persist before transmitting a terminal result. Receipt recovery survives edits/pause. */
	markReceipt(
		claim: AutomationOccurrence,
		definition: AutomationRegistration,
		scopeKey: string,
	): void {
		this.transact((state, now) => {
			const o = state.occurrences[claim.id];
			if (
				!o ||
				o.status !== "running" ||
				o.attemptId !== claim.attemptId ||
				o.fence !== claim.fence ||
				o.leaseUntil <= now
			)
				throw new Error("Stale receipt owner");
			if (o.receipt) {
				if (
					o.receipt.scopeKey !== scopeKey ||
					digest(o.receipt.definition) !== digest(definition)
				)
					throw new Error("Receipt identity changed");
			} else {
				if (
					digest(this.definition(state, claim.automationId, claim.revision)) !==
					digest(definition)
				)
					throw new Error("Receipt definition changed");
				o.receipt = { definition, scopeKey, attempts: 1 };
			}
		});
	}
	renew(claim: AutomationOccurrence): void {
		this.transact((state, now) => {
			const o = state.occurrences[claim.id];
			if (!o?.receipt)
				this.definition(state, claim.automationId, claim.revision);
			if (
				!o ||
				o.status !== "running" ||
				o.attemptId !== claim.attemptId ||
				o.fence !== claim.fence ||
				o.leaseUntil <= now
			)
				throw new Error("Stale automation owner");
			o.leaseUntil = now + AUTOMATION_LIMITS.leaseSeconds * 1000;
		});
	}
	finish(
		claim: AutomationOccurrence,
		success: boolean,
		failure?: AutomationDiagnostic,
	): void {
		this.transact((state, now) => {
			const o = state.occurrences[claim.id];
			if (
				!o ||
				o.status !== "running" ||
				o.attemptId !== claim.attemptId ||
				o.fence !== claim.fence ||
				o.leaseUntil <= now
			)
				return;
			if (success) {
				o.status = "completed";
				delete o.lastFailure;
			} else {
				o.lastFailure = {
					...diagnosticSchema.parse(
						failure ?? { phase: "execute", code: "execution_interrupted" },
					),
					at: new Date(now).toISOString(),
				};
				const history = o.failureHistory ?? [];
				history.push({ ...o.lastFailure, attempt: o.attempts, fence: o.fence });
				// Keep the first recorded failure plus the latest bounded tail.
				// Never infer an older failure/attempt from legacy lastFailure.
				o.failureHistory =
					history.length > FAILURE_HISTORY_LIMIT
						? [history[0]!, ...history.slice(-(FAILURE_HISTORY_LIMIT - 1))]
						: history;
				const delay = retryDelayMilliseconds(this.cycleAttempts(o));
				o.status = delay === null ? "blocked" : "queued";
				o.availableAt = now + (delay ?? 0);
				o.leaseUntil = 0;
			}
		});
	}
	status(automationId: string) {
		return this.transact((state) => ({
			definition: state.definitions[digest(automationId)] ?? null,
			occurrences: Object.values(state.occurrences).filter(
				(o) => o.automationId === automationId,
			),
		}));
	}
	close(): void {
		this.db.close();
	}
}
