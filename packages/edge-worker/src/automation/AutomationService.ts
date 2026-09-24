import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
	AutomationScheduler,
	nextOccurrence,
	previewSchedule,
} from "./AutomationScheduler.js";
import type { AutomationState, AutomationStore } from "./AutomationStore.js";
import {
	type AutomationAdapter,
	type AutomationDefinition,
	AutomationError,
	type AutomationRun,
	activeRun,
	automationInputSchema,
	type RunUpdate,
} from "./types.js";

export class AutomationService {
	private scheduler: AutomationScheduler;
	private dispatches = new Set<Promise<void>>();
	private polling = false;
	private stopped = true;
	private pausedForUpdate = false;
	private lastReconcile = 0;
	error = "";
	constructor(
		readonly store: AutomationStore,
		private adapter: AutomationAdapter,
	) {
		this.scheduler = new AutomationScheduler(
			(now, missed) => this.tick(now, missed),
			(error) => {
				this.error = String(error);
			},
		);
	}
	async start(timers = true, paused = false) {
		try {
			await this.store.open();
			this.stopped = paused;
			this.pausedForUpdate = paused;
			for (const run of this.store.read().runs.filter(activeRun))
				await this.reconcile(run.id);
			if (!paused) {
				await this.tick(Date.now(), true);
				if (timers) this.scheduler.start();
			}
		} catch (error) {
			this.error = String(error);
		}
	}
	enableScheduling() {
		if (this.pausedForUpdate) {
			this.pausedForUpdate = false;
			this.stopped = false;
		}
		if (!this.stopped) this.scheduler.start();
	}
	isBusy(): boolean {
		return this.polling || this.dispatches.size > 0;
	}
	pauseScheduling(): void {
		this.stopped = true;
		this.scheduler.stop();
	}
	async stop() {
		this.stopped = true;
		this.scheduler.stop();
		while (this.polling) await delay(10);
		await Promise.allSettled([...this.dispatches]);
		await this.store.close();
	}
	list() {
		return {
			definitions: this.store.read().definitions,
			error: this.store.error || this.error,
		};
	}
	get(id: string) {
		const definition = this.store.read().definitions.find((d) => d.id === id);
		if (!definition) throw new AutomationError("Automation not found", 404);
		return definition;
	}
	runs(id: string) {
		this.get(id);
		return this.store
			.read()
			.runs.filter((r) => r.automationId === id)
			.reverse();
	}
	async save(raw: unknown, id?: string, revision?: number) {
		const input = automationInputSchema.parse(raw);
		const now = Date.now();
		const times = previewSchedule(input, now);
		if (!times.length)
			throw new AutomationError("Choose a future execution time");
		await this.adapter.validate(input);
		return this.store.transact((state) => {
			const existing = id
				? state.definitions.find((d) => d.id === id)
				: undefined;
			if (id && !existing)
				throw new AutomationError("Automation not found", 404);
			if (existing && (existing.archived || existing.revision !== revision))
				throw new AutomationError(
					"Automation changed; reload before editing",
					409,
				);
			const definition: AutomationDefinition = {
				...input,
				id: existing?.id ?? randomUUID(),
				revision: (existing?.revision ?? 0) + 1,
				createdAt: existing?.createdAt ?? now,
				updatedAt: now,
				archived: false,
				nextRunAt: input.enabled ? times[0]! : null,
				scheduleState: input.enabled ? "scheduled" : "paused",
			};
			if (existing)
				state.definitions[state.definitions.indexOf(existing)] = definition;
			else state.definitions.push(definition);
			return definition;
		});
	}
	async setEnabled(
		id: string,
		revision: number,
		enabled: boolean,
		archive = false,
	) {
		return this.store.transact((state) => {
			const definition = state.definitions.find((d) => d.id === id);
			if (!definition) throw new AutomationError("Automation not found", 404);
			if (definition.revision !== revision || definition.archived)
				throw new AutomationError(
					"Automation changed; reload before editing",
					409,
				);
			definition.enabled = enabled && !archive;
			definition.archived = archive;
			definition.nextRunAt = definition.enabled
				? nextOccurrence(definition, Date.now())
				: null;
			if (definition.enabled && definition.nextRunAt === null)
				definition.enabled = false;
			definition.scheduleState = archive
				? "archived"
				: !enabled
					? "paused"
					: definition.nextRunAt
						? "scheduled"
						: "missed";
			definition.updatedAt = Date.now();
			definition.revision++;
			return definition;
		});
	}
	private makeRun(
		state: AutomationState,
		definition: AutomationDefinition,
		at: number,
		key: string,
		trigger: "manual" | "scheduled",
		reason?: string,
	): AutomationRun {
		const existing = state.runs.find((r) => r.key === key);
		if (existing) return existing;
		const overlap = state.runs.some(
			(r) => r.automationId === definition.id && activeRun(r),
		);
		const run: AutomationRun = {
			id: randomUUID(),
			automationId: definition.id,
			key,
			trigger,
			scheduledAt: at,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			snapshot: structuredClone(definition),
			status: reason || overlap ? "skipped" : "dispatching",
			message: reason || (overlap ? "Previous run has not finished" : ""),
			issueId:
				definition.target.kind === "linear_issue" ? randomUUID() : undefined,
			prUrls: [],
			attempts: 0,
		};
		state.runs.push(run);
		return run;
	}
	async runNow(id: string, requestId: string) {
		if (this.stopped) throw new AutomationError("Scheduler is stopped", 503);
		if (!requestId || requestId.length > 128)
			throw new AutomationError("A request ID is required");
		const run = await this.store.transact((state) => {
			const definition = state.definitions.find(
				(d) => d.id === id && !d.archived,
			);
			if (!definition) throw new AutomationError("Automation not found", 404);
			return this.makeRun(
				state,
				definition,
				Date.now(),
				`${id}:manual:${requestId}`,
				"manual",
			);
		});
		this.launch(run);
		return run;
	}
	async tick(now: number, missed = false) {
		if (this.polling || this.stopped || this.store.error) return;
		this.polling = true;
		try {
			const due = this.store
				.read()
				.definitions.some(
					(d) =>
						d.enabled &&
						!d.archived &&
						d.nextRunAt !== null &&
						d.nextRunAt <= now,
				);
			if (due) {
				const runs = await this.store.transact((state) => {
					const result: AutomationRun[] = [];
					for (const d of state.definitions) {
						if (
							!d.enabled ||
							d.archived ||
							d.nextRunAt === null ||
							d.nextRunAt > now
						)
							continue;
						const skip = missed || now - d.nextRunAt > 60000;
						result.push(
							this.makeRun(
								state,
								d,
								d.nextRunAt,
								`${d.id}:${d.nextRunAt}`,
								"scheduled",
								skip
									? "Missed while worker was offline or suspended"
									: undefined,
							),
						);
						d.nextRunAt = nextOccurrence(d, now);
						if (d.schedule.kind === "once") {
							d.enabled = false;
							d.scheduleState = skip ? "missed" : "finished";
						}
					}
					return result;
				});
				for (const run of runs) this.launch(run);
			}
			if (now - this.lastReconcile >= 30000) {
				this.lastReconcile = now;
				for (const run of this.store.read().runs.filter(activeRun)) {
					if (run.status !== "dispatching") await this.reconcile(run.id);
				}
			}
		} finally {
			this.polling = false;
		}
	}
	private launched = new Set<string>();
	private launch(run: AutomationRun) {
		if (
			run.status !== "dispatching" ||
			this.launched.has(run.id) ||
			this.stopped
		)
			return;
		this.launched.add(run.id);
		const work = this.dispatch(run)
			.catch((error) => {
				this.error = String(error);
			})
			.finally(() => this.dispatches.delete(work));
		this.dispatches.add(work);
	}
	private async dispatch(run: AutomationRun) {
		let ambiguousAttempt = false;
		for (let attempt = 1; attempt <= 3 && !this.stopped; attempt++) {
			await this.store.transact((state) => {
				const saved = state.runs.find((r) => r.id === run.id)!;
				saved.attempts = attempt;
				saved.startedAt ??= Date.now();
			});
			let enteredDispatch = false;
			try {
				await this.adapter.validate(run.snapshot);
				enteredDispatch = true;
				await this.update(run.id, await this.adapter.dispatch(run), true);
				return;
			} catch (error) {
				const permanent =
					error instanceof AutomationError &&
					error.statusCode < 500 &&
					error.statusCode !== 429;
				if (!permanent && enteredDispatch) ambiguousAttempt = true;
				if (
					!permanent &&
					attempt < 3 &&
					(run.snapshot.target.kind === "linear_issue" || !enteredDispatch)
				) {
					await delay(1000 * attempt);
					continue;
				}
				await this.update(
					run.id,
					{
						status: permanent && !ambiguousAttempt ? "failed" : "uncertain",
						message: error instanceof Error ? error.message : String(error),
					},
					true,
				);
				return;
			}
		}
	}
	async update(
		id: string,
		patch: RunUpdate,
		onlyDispatching = false,
		expectedUpdatedAt?: number,
	) {
		await this.store.transact((state) => {
			const run = state.runs.find((r) => r.id === id);
			if (
				!run ||
				(expectedUpdatedAt !== undefined && run.updatedAt !== expectedUpdatedAt)
			)
				return;
			// Creation may return after its webhook (or even completion). Keep the
			// immutable issue link without regressing the execution state.
			if (patch.issueUrl && !run.issueUrl) run.issueUrl = patch.issueUrl;
			if (!activeRun(run) || (onlyDispatching && run.status !== "dispatching"))
				return;
			Object.assign(run, patch, {
				updatedAt: Math.max(Date.now(), run.updatedAt + 1),
			});
		});
	}
	async confirmEnded(id: string) {
		const run = await this.reconcile(id);
		if (run.status !== "uncertain")
			throw new AutomationError(
				"Only an unconfirmed run can be cleared; active work must finish first",
				409,
			);
		await this.store.transact((state) => {
			const current = state.runs.find((r) => r.id === id);
			if (
				!current ||
				current.status !== "uncertain" ||
				current.updatedAt !== run.updatedAt
			)
				throw new AutomationError(
					"Execution changed while being checked; refresh and try again",
					409,
				);
			current.status = "failed";
			current.message = `${run.message}\nOperator confirmed that the previous execution has ended.`;
			current.updatedAt = Math.max(Date.now(), current.updatedAt + 1);
		});
	}

	async reconcile(id: string) {
		const run = this.store.read().runs.find((r) => r.id === id);
		if (!run) throw new AutomationError("Run not found", 404);
		if (!activeRun(run)) return run;
		try {
			const patch = await this.adapter.reconcile(run);
			if (Object.keys(patch).length)
				await this.update(id, patch, false, run.updatedAt);
		} catch (error) {
			await this.update(
				id,
				{
					status: "uncertain",
					message: `Unable to confirm previous run: ${String(error)}`,
				},
				false,
				run.updatedAt,
			);
		}
		return this.store.read().runs.find((r) => r.id === id)!;
	}
}
