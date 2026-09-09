/**
 * Tests for the global session concurrency cap (maxConcurrentSessions).
 *
 * Runners resolve start()/startStreaming() when the session finishes, so
 * holding a semaphore slot across that promise bounds concurrent sessions.
 */

import type { AgentSessionInfo, IAgentRunner } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { capRunnerStarts, SessionSemaphore } from "../src/RunnerConcurrency.js";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

const sessionInfo = (id: string): AgentSessionInfo =>
	({ sessionId: id }) as AgentSessionInfo;

/** A runner whose start()/startStreaming() completion the test controls. */
function fakeRunner(streaming: boolean) {
	const startGate = deferred<AgentSessionInfo>();
	const streamingGate = deferred<AgentSessionInfo>();
	const started = vi.fn(() => startGate.promise);
	const startedStreaming = vi.fn(() => streamingGate.promise);
	const runner = {
		supportsStreamingInput: streaming,
		start: started,
		...(streaming ? { startStreaming: startedStreaming } : {}),
	} as unknown as IAgentRunner;
	return { runner, started, startedStreaming, startGate, streamingGate };
}

async function settled(): Promise<void> {
	// Let queued microtasks (semaphore admissions) run.
	await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("SessionSemaphore", () => {
	it("admits immediately below the limit and queues at it", async () => {
		const semaphore = new SessionSemaphore(2);
		await semaphore.acquire();
		await semaphore.acquire();
		expect(semaphore.active).toBe(2);

		let third = false;
		const pending = semaphore.acquire().then(() => {
			third = true;
		});
		await settled();
		expect(third).toBe(false);
		expect(semaphore.waiting).toBe(1);

		semaphore.release();
		await pending;
		expect(third).toBe(true);
		expect(semaphore.active).toBe(2);
		expect(semaphore.waiting).toBe(0);
	});

	it("wakes waiters in FIFO order", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();

		const order: number[] = [];
		const first = semaphore.acquire().then(() => order.push(1));
		const second = semaphore.acquire().then(() => order.push(2));

		semaphore.release();
		await first;
		semaphore.release();
		await second;
		expect(order).toEqual([1, 2]);
	});

	it("never blocks when the limit is Infinity", async () => {
		const semaphore = new SessionSemaphore(Number.POSITIVE_INFINITY);
		for (let i = 0; i < 100; i++) {
			await semaphore.acquire();
		}
		expect(semaphore.active).toBe(100);
		expect(semaphore.waiting).toBe(0);
	});

	it("admits queued waiters when the limit is raised", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire();
		let admitted = false;
		const pending = semaphore.acquire().then(() => {
			admitted = true;
		});
		await settled();
		expect(admitted).toBe(false);

		semaphore.setLimit(2);
		await pending;
		expect(admitted).toBe(true);
	});

	it("applies a lowered limit as sessions finish", async () => {
		const semaphore = new SessionSemaphore(2);
		await semaphore.acquire();
		await semaphore.acquire();

		semaphore.setLimit(1);
		semaphore.release();
		// Still at the (new) limit: one active, so a new acquire queues.
		let admitted = false;
		semaphore.acquire().then(() => {
			admitted = true;
		});
		await settled();
		expect(admitted).toBe(false);
		expect(semaphore.active).toBe(1);
	});

	it("reports queueing through the onQueued callback", async () => {
		const onQueued = vi.fn();
		const semaphore = new SessionSemaphore(1, onQueued);
		await semaphore.acquire();
		expect(onQueued).not.toHaveBeenCalled();
		void semaphore.acquire();
		expect(onQueued).toHaveBeenCalledOnce();
	});

	it("rejects invalid limits", () => {
		expect(() => new SessionSemaphore(0)).toThrow();
		expect(() => new SessionSemaphore(Number.NaN)).toThrow();
		expect(() => new SessionSemaphore(1).setLimit(0)).toThrow();
	});
});

describe("capRunnerStarts", () => {
	it("holds a slot for the full duration of start()", async () => {
		const semaphore = new SessionSemaphore(1);
		const first = fakeRunner(false);
		const second = fakeRunner(false);
		const firstWrapped = capRunnerStarts(first.runner, semaphore);
		const secondWrapped = capRunnerStarts(second.runner, semaphore);

		const firstDone = firstWrapped.start("one");
		const secondDone = secondWrapped.start("two");
		await settled();

		expect(first.started).toHaveBeenCalledOnce();
		// Second session must not begin while the first is still running.
		expect(second.started).not.toHaveBeenCalled();

		first.startGate.resolve(sessionInfo("s1"));
		await firstDone;
		await settled();
		expect(second.started).toHaveBeenCalledOnce();

		second.startGate.resolve(sessionInfo("s2"));
		await expect(secondDone).resolves.toEqual(sessionInfo("s2"));
	});

	it("gates startStreaming() the same way", async () => {
		const semaphore = new SessionSemaphore(1);
		const first = fakeRunner(true);
		const second = fakeRunner(true);
		const firstWrapped = capRunnerStarts(first.runner, semaphore);
		const secondWrapped = capRunnerStarts(second.runner, semaphore);

		const firstDone = firstWrapped.startStreaming?.("one");
		void secondWrapped.startStreaming?.("two");
		await settled();

		expect(first.startedStreaming).toHaveBeenCalledOnce();
		expect(second.startedStreaming).not.toHaveBeenCalled();

		first.streamingGate.resolve(sessionInfo("s1"));
		await firstDone;
		await settled();
		expect(second.startedStreaming).toHaveBeenCalledOnce();
	});

	it("releases the slot when a session fails", async () => {
		const semaphore = new SessionSemaphore(1);
		const failing = fakeRunner(false);
		const next = fakeRunner(false);
		const failingWrapped = capRunnerStarts(failing.runner, semaphore);
		const nextWrapped = capRunnerStarts(next.runner, semaphore);

		const failingDone = failingWrapped.start("boom");
		const nextDone = nextWrapped.start("after");
		await settled();

		failing.startGate.reject(new Error("session crashed"));
		await expect(failingDone).rejects.toThrow("session crashed");
		await settled();

		expect(next.started).toHaveBeenCalledOnce();
		next.startGate.resolve(sessionInfo("s2"));
		await nextDone;
		expect(semaphore.active).toBe(0);
	});

	it("does not add startStreaming to runners without it", () => {
		const semaphore = new SessionSemaphore(1);
		const plain = fakeRunner(false);
		const wrapped = capRunnerStarts(plain.runner, semaphore);
		expect(wrapped.startStreaming).toBeUndefined();
	});

	it("passes prompts and results through unchanged", async () => {
		const semaphore = new SessionSemaphore(Number.POSITIVE_INFINITY);
		const { runner, started, startGate } = fakeRunner(false);
		const wrapped = capRunnerStarts(runner, semaphore);

		const done = wrapped.start("the prompt");
		startGate.resolve(sessionInfo("s1"));
		await expect(done).resolves.toEqual(sessionInfo("s1"));
		expect(started).toHaveBeenCalledWith("the prompt");
	});

	it("leaves the underlying runner untouched and its spies observable", async () => {
		// Regression guard: an earlier draft mutated runner.start in place,
		// which broke every test that asserts on a mock runner's methods.
		const semaphore = new SessionSemaphore(Number.POSITIVE_INFINITY);
		const { runner, started, startGate } = fakeRunner(false);
		const originalStart = runner.start;
		const wrapped = capRunnerStarts(runner, semaphore);

		const done = wrapped.start("p");
		startGate.resolve(sessionInfo("s"));
		await done;

		expect(runner.start).toBe(originalStart);
		expect(runner.start).toHaveBeenCalledOnce();
		expect(started).toHaveBeenCalledOnce();
	});

	it("forwards other members through to the underlying runner", () => {
		const semaphore = new SessionSemaphore(1);
		const addStreamMessage = vi.fn();
		const runner = {
			supportsStreamingInput: true,
			start: vi.fn(),
			startStreaming: vi.fn(),
			addStreamMessage,
		} as unknown as IAgentRunner;
		const wrapped = capRunnerStarts(runner, semaphore);

		expect(wrapped.supportsStreamingInput).toBe(true);
		wrapped.addStreamMessage?.("follow-up");
		expect(addStreamMessage).toHaveBeenCalledWith("follow-up");
	});
});
