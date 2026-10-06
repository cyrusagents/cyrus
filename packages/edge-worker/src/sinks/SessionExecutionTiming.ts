import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { SessionActivityJournal } from "./SessionActivityJournal.js";

const milliseconds = z.number().int().nonnegative().safe();
export const executionTimingStateSchema = z
	.object({
		attemptId: z.string().min(1).max(300),
		fence: z.number().int().positive().safe(),
		complete: z.boolean(),
		intervals: z
			.array(
				z
					.object({
						attemptId: z.string().min(1).max(300),
						kind: z.enum(["model", "tool"]),
						startedAt: z.string().datetime(),
						observedAt: z.string().datetime(),
						durationMs: milliseconds,
						closed: z.boolean(),
					})
					.strict(),
			)
			.max(4096),
	})
	.strict();
export type ExecutionTimingState = z.infer<typeof executionTimingStateSchema>;
export interface ExecutionMeasurement {
	executionDurationMs: number;
	executionDurationComplete: boolean;
}

/** Observed execution, never queue/receipt age. No authority or scheduler lives here. */
export class SessionExecutionTiming {
	private current?: {
		index: number;
		started: number;
		excluded: number;
		pauses: number;
		pauseStarted: number;
		timer: ReturnType<typeof setInterval>;
		abort: () => void;
	};
	constructor(
		private readonly journal: SessionActivityJournal,
		private readonly sessionId: string,
		private readonly attemptId: string,
		private readonly fence: number,
		historicalWork: boolean,
		private readonly signal: AbortSignal,
		private readonly failed: () => void,
		private readonly clock: { monotonic: () => number; wall: () => string } = {
			monotonic: () => performance.now(),
			wall: () => new Date().toISOString(),
		},
	) {
		journal.execution(sessionId, (old) => {
			if (old && fence <= old.fence)
				throw new Error("Stale execution timing owner");
			const state = old ?? {
				attemptId,
				fence,
				complete: !historicalWork,
				intervals: [],
			};
			// A dead process has no trustworthy final timestamp. Keep its last durable
			// monotonic sample, mark incomplete, and never count time until this resume.
			for (const interval of state.intervals)
				if (!interval.closed) {
					interval.closed = true;
					state.complete = false;
				}
			state.attemptId = attemptId;
			state.fence = fence;
			return state;
		});
	}
	private update(
		action: (state: ExecutionTimingState) => void,
	): ExecutionTimingState {
		return this.journal.execution(this.sessionId, (state) => {
			if (
				!state ||
				state.attemptId !== this.attemptId ||
				state.fence !== this.fence
			)
				throw new Error("Stale execution timing owner");
			action(state);
			return state;
		})!;
	}
	snapshot(): ExecutionMeasurement {
		const state = this.update(() => {});
		const total = state.intervals.reduce(
			(sum, interval) => sum + interval.durationMs,
			0,
		);
		if (!Number.isSafeInteger(total))
			throw new Error("Execution duration overflow");
		return {
			executionDurationMs: total,
			executionDurationComplete: state.complete,
		};
	}
	private sample(close: boolean): void {
		const current = this.current;
		if (!current) return;
		if (close) {
			clearInterval(current.timer);
			this.signal.removeEventListener("abort", current.abort);
			this.current = undefined;
		}
		const now = this.clock.monotonic();
		const elapsed = Math.floor(
			now -
				current.started -
				current.excluded -
				(current.pauses ? now - current.pauseStarted : 0),
		);
		if (!Number.isSafeInteger(elapsed) || elapsed < 0)
			throw new Error("Invalid monotonic execution clock");
		this.update((state) => {
			const interval = state.intervals[current.index]!;
			if (interval.closed || elapsed < interval.durationMs)
				throw new Error("Execution interval changed");
			interval.durationMs = elapsed;
			interval.observedAt = this.clock.wall();
			interval.closed = close;
		});
	}
	/** Exclude blocking supervisor/receipt waits inside a native harness invocation. */
	async exclude<T>(operation: () => Promise<T>): Promise<T> {
		const current = this.current;
		if (!current) return operation();
		if (current.pauses++ === 0) current.pauseStarted = this.clock.monotonic();
		try {
			return await operation();
		} finally {
			if (--current.pauses === 0)
				current.excluded += this.clock.monotonic() - current.pauseStarted;
		}
	}

	async measure<T>(
		kind: "model" | "tool",
		operation: () => Promise<T>,
	): Promise<T> {
		this.signal.throwIfAborted();
		if (this.current) throw new Error("Overlapping execution intervals");
		const started = this.clock.monotonic();
		const wall = this.clock.wall();
		const state = this.update((state) =>
			state.intervals.push({
				attemptId: this.attemptId,
				kind,
				startedAt: wall,
				observedAt: wall,
				durationMs: 0,
				closed: false,
			}),
		);
		const abort = () => {
			try {
				this.sample(true);
			} catch {
				this.failed();
			}
		};
		const timer = setInterval(() => {
			try {
				this.sample(false);
			} catch {
				clearInterval(timer);
				this.failed();
			}
		}, 5000);
		timer.unref();
		this.current = {
			excluded: 0,
			pauses: 0,
			pauseStarted: 0,
			index: state.intervals.length - 1,
			started,
			timer,
			abort,
		};
		this.signal.addEventListener("abort", abort, { once: true });
		try {
			return await operation();
		} finally {
			this.sample(true);
		}
	}
}
