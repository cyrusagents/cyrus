/**
 * Global concurrency cap for agent runner sessions.
 *
 * Every runner created by the EdgeWorker resolves `start()` /
 * `startStreaming()` only when its session finishes, so holding a semaphore
 * slot for the duration of that promise bounds how many sessions execute at
 * once. Hosts running many webhook-driven sessions use this to keep total
 * runner memory/CPU inside what the machine can serve, instead of letting an
 * unbounded burst of sessions take the whole process down (e.g. via the
 * kernel OOM killer).
 */

import type { AgentSessionInfo, IAgentRunner } from "cyrus-core";

/**
 * Counting semaphore with FIFO waiters and a live-adjustable limit.
 *
 * `Number.POSITIVE_INFINITY` means uncapped — `acquire()` resolves
 * immediately. Lowering the limit never interrupts running sessions; it
 * simply stops admitting new ones until enough slots free up.
 */
export class SessionSemaphore {
	private activeCount = 0;
	private waiters: Array<() => void> = [];

	constructor(
		private limit: number,
		private readonly onQueued?: (message: string) => void,
	) {
		if (Number.isNaN(limit) || limit < 1) {
			throw new Error(
				`SessionSemaphore limit must be >= 1 or Infinity, got ${limit}`,
			);
		}
	}

	get active(): number {
		return this.activeCount;
	}

	get waiting(): number {
		return this.waiters.length;
	}

	get currentLimit(): number {
		return this.limit;
	}

	acquire(): Promise<void> {
		return this.acquireCancellable().granted.then(() => undefined);
	}

	/**
	 * Like `acquire()`, but the wait can be withdrawn. `cancel()` removes a
	 * still-queued waiter (its promise resolves `false` and no slot is
	 * taken); once a slot was granted `cancel()` does nothing and the caller
	 * owns the slot (`granted` resolved `true`).
	 */
	acquireCancellable(): { granted: Promise<boolean>; cancel: () => void } {
		if (this.activeCount < this.limit) {
			this.activeCount++;
			return { granted: Promise.resolve(true), cancel: () => {} };
		}
		let waiter: (() => void) | null = null;
		let resolveGranted: (granted: boolean) => void = () => {};
		const granted = new Promise<boolean>((resolve) => {
			resolveGranted = resolve;
			waiter = () => resolve(true);
			this.waiters.push(waiter);
			this.onQueued?.(
				`Session start queued: ${this.activeCount} running at the ` +
					`maxConcurrentSessions limit of ${this.limit}, ` +
					`${this.waiters.length} waiting`,
			);
		});
		return {
			granted,
			cancel: () => {
				const index = waiter ? this.waiters.indexOf(waiter) : -1;
				if (index >= 0) {
					this.waiters.splice(index, 1);
					resolveGranted(false);
				}
			},
		};
	}

	release(): void {
		if (this.activeCount === 0) {
			// A release with nothing active is a bookkeeping bug in the caller;
			// clamp rather than let the count go negative and over-admit later.
			return;
		}
		this.activeCount--;
		this.admitWaiters();
	}

	/**
	 * Adjust the limit at runtime (config hot-reload). Raising it admits
	 * queued sessions immediately; lowering it applies as sessions finish.
	 */
	setLimit(limit: number): void {
		if (Number.isNaN(limit) || limit < 1) {
			throw new Error(
				`SessionSemaphore limit must be >= 1 or Infinity, got ${limit}`,
			);
		}
		this.limit = limit;
		this.admitWaiters();
	}

	private admitWaiters(): void {
		while (this.waiters.length > 0 && this.activeCount < this.limit) {
			this.activeCount++;
			const next = this.waiters.shift();
			next?.();
		}
	}
}

/**
 * Wrap a runner so `start()` and `startStreaming()` hold a semaphore slot for
 * their full duration. Both resolve when the session completes, so the slot
 * is held for the session's lifetime and released on success and failure
 * alike. Follow-up messages streamed into an already-started session
 * (`addStreamMessage`) are untouched — the session already holds its slot.
 *
 * The wrapper is a Proxy rather than an instance mutation: the underlying
 * runner is never modified, every other property forwards through unchanged,
 * and the original methods stay observable (e.g. as test spies).
 */
const START_GUARD = Symbol("cyrus.runnerStartGuard");

/**
 * Register a check that a slot-gated runner (see `capRunnerStarts`) runs
 * inside its acquired slot, right before the underlying start. Returning
 * false skips the start (the call resolves as not started). Returns false if
 * the runner is not gated, so callers can fall back to their own checks.
 */
export function setRunnerStartGuard(
	runner: IAgentRunner,
	guard: () => boolean,
): boolean {
	const register = (runner as unknown as Record<symbol, unknown>)[START_GUARD];
	if (typeof register !== "function") return false;
	(register as (g: () => boolean) => void)(guard);
	return true;
}

export function capRunnerStarts(
	runner: IAgentRunner,
	semaphore: SessionSemaphore,
): IAgentRunner {
	// `stop()` before the session has spawned must win: a runner stopped while
	// queued for a slot never starts, and one whose slot arrives at the same
	// moment re-checks the flag inside the slot, right before spawning.
	// One-shot latch: once stopped, this wrapped instance never starts again
	// (callers build a fresh runner to resume). That is what keeps a canceled
	// queued attempt from being revived.
	let stopped = false;
	let withdraw: (() => void) | null = null;
	// Optional owner check run inside the acquired slot, immediately before
	// spawning (e.g. "is the bound repository still configured?").
	let startGuard: (() => boolean) | null = null;
	const notStarted = (): AgentSessionInfo => ({
		sessionId: null,
		startedAt: new Date(),
		isRunning: false,
	});
	const gate = async (
		run: () => Promise<AgentSessionInfo>,
	): Promise<AgentSessionInfo> => {
		if (stopped) return notStarted();
		const admission = semaphore.acquireCancellable();
		withdraw = admission.cancel;
		const granted = await admission.granted;
		withdraw = null;
		if (!granted) return notStarted();
		try {
			if (stopped) return notStarted();
			if (startGuard && !startGuard()) return notStarted();
			return await run();
		} finally {
			semaphore.release();
		}
	};

	return new Proxy(runner, {
		get(target, property, receiver) {
			if (property === "start") {
				return (prompt: string) => gate(() => target.start(prompt));
			}
			if (property === "startStreaming") {
				const startStreaming = target.startStreaming?.bind(target);
				if (startStreaming) {
					return (initialPrompt?: string) =>
						gate(() => startStreaming(initialPrompt));
				}
			}
			if (property === START_GUARD) {
				return (guard: () => boolean) => {
					startGuard = guard;
				};
			}
			if (property === "stop") {
				return () => {
					stopped = true;
					withdraw?.();
					return target.stop();
				};
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
