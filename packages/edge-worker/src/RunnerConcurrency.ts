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

import type { IAgentRunner } from "cyrus-core";

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
		if (this.activeCount < this.limit) {
			this.activeCount++;
			return Promise.resolve();
		}
		return new Promise<void>((resolve) => {
			this.waiters.push(resolve);
			this.onQueued?.(
				`Session start queued: ${this.activeCount} running at the ` +
					`maxConcurrentSessions limit of ${this.limit}, ` +
					`${this.waiters.length} waiting`,
			);
		});
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
export function capRunnerStarts(
	runner: IAgentRunner,
	semaphore: SessionSemaphore,
): IAgentRunner {
	const gate = async <T>(run: () => Promise<T>): Promise<T> => {
		await semaphore.acquire();
		try {
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
			if (
				property === "startStreaming" &&
				typeof target.startStreaming === "function"
			) {
				return (initialPrompt?: string) =>
					// biome-ignore lint/style/noNonNullAssertion: guarded by the typeof check above
					gate(() => target.startStreaming!(initialPrompt));
			}
			return Reflect.get(target, property, receiver);
		},
	});
}
