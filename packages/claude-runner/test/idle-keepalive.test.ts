import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock file system operations
vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
}));

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import {
	query,
	type SDKMessage,
	type StopHookInput,
} from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

/**
 * A finished session whose subprocess has exited forces the next comment down
 * the resume path, which re-writes the whole conversation to the prompt cache.
 * `sessionKeepAliveMs` keeps the streaming session open for a bounded idle
 * window so the comment appends instead — and shuts it down when the window
 * elapses, so an abandoned issue does not hold a subprocess forever.
 *
 * Harness mirrors pending-work-lifecycle.test.ts: the Stop hook fires before
 * the `result` message, and the query iterator ends only when the input stream
 * completes (the real CLI exiting on stdin EOF).
 */

const SESSION_CRON = {
	id: "cron-1",
	schedule: "27 12 * * *",
	recurring: false,
	prompt: "WAKEUP: continue the test",
};

const KEEP_ALIVE_MS = 50 * 60_000;

function makeResultMessage(text: string): SDKMessage {
	return {
		type: "result",
		subtype: "success",
		is_error: false,
		result: text,
		session_id: "claude-session-1",
		duration_ms: 100,
		num_turns: 1,
	} as unknown as SDKMessage;
}

function makeSystemInit(): SDKMessage {
	return {
		type: "system",
		subtype: "init",
		session_id: "claude-session-1",
	} as unknown as SDKMessage;
}

function installMockQuery(mockQuery: ReturnType<typeof vi.mocked<any>>) {
	const state: {
		queryOptions: any;
		endTurn: (
			crons: (typeof SESSION_CRON)[],
			resultText: string,
		) => Promise<void>;
	} = {
		queryOptions: null,
		endTurn: async () => {},
	};

	mockQuery.mockImplementation(({ options, prompt }: any) => {
		state.queryOptions = options;

		const emitted: SDKMessage[] = [makeSystemInit()];
		let notify: (() => void) | null = null;
		let inputDone = false;

		(async () => {
			for await (const _msg of prompt) {
				// messages consumed; turn lifecycle is driven by endTurn()
			}
			inputDone = true;
			notify?.();
		})();

		state.endTurn = async (crons, resultText) => {
			const stopMatchers = options.hooks?.Stop ?? [];
			for (const matcher of stopMatchers) {
				for (const hook of matcher.hooks) {
					await hook(
						{
							hook_event_name: "Stop",
							stop_hook_active: false,
							session_crons: crons,
							background_tasks: [],
							cwd: "/tmp/test",
						} as unknown as StopHookInput,
						undefined,
						{ signal: new AbortController().signal },
					);
				}
			}
			emitted.push(makeResultMessage(resultText));
			notify?.();
		};

		return {
			async *[Symbol.asyncIterator]() {
				let cursor = 0;
				for (;;) {
					while (cursor < emitted.length) {
						yield emitted[cursor++];
					}
					if (inputDone) return;
					await new Promise<void>((resolve) => {
						notify = resolve;
					});
					notify = null;
				}
			},
		};
	});

	return state;
}

function waitForMessageCount(
	runner: ClaudeRunner,
	count: number,
): Promise<void> {
	return new Promise((resolve) => {
		let seen = 0;
		runner.on("message", () => {
			seen++;
			if (seen >= count) resolve();
		});
	});
}

describe("ClaudeRunner idle keep-alive", () => {
	let mockQuery: any;

	const baseConfig: ClaudeRunnerConfig = {
		workingDirectory: "/tmp/test",
		cyrusHome: "/tmp/test-cyrus-home",
	};
	const keepAliveConfig: ClaudeRunnerConfig = {
		...baseConfig,
		sessionKeepAliveMs: KEEP_ALIVE_MS,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		mockQuery = vi.mocked(query);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it("a configured window keeps the session warm without the warm pool", () => {
		// Second constructor arg (the warm-session pool switch) stays false.
		const runner = new ClaudeRunner(keepAliveConfig, false);
		expect(runner.isWarm()).toBe(true);
	});

	it("stays running after a turn ends, then shuts down when the window elapses", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(keepAliveConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await firstResult;

		// Idle, but alive: a follow-up comment would append rather than resume.
		expect(runner.isRunning()).toBe(true);
		expect(runner.isStreaming()).toBe(true);

		// Just shy of the window it is still up...
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS - 1);
		expect(runner.isRunning()).toBe(true);

		// ...and the window elapsing completes the prompt, ending the session.
		await vi.advanceTimersByTimeAsync(1);
		await completed;
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("restarts the idle window on each appended message", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(keepAliveConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await firstResult;

		// Nearly idled out, then a follow-up comment arrives.
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS - 1000);
		runner.addStreamMessage("one more thing");

		// The old deadline passes without shutting the session down.
		await vi.advanceTimersByTimeAsync(2000);
		expect(runner.isRunning()).toBe(true);

		// The new turn ends and arms a fresh, full-length window.
		await state.endTurn([], "done again");
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS - 1);
		expect(runner.isRunning()).toBe(true);

		await vi.advanceTimersByTimeAsync(1);
		await completed;
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("does not arm the window while a scheduled wakeup is pending", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(keepAliveConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("schedule a wakeup");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([SESSION_CRON], "SCHEDULED");
		await firstResult;
		expect(runner.hasPendingWork()).toBe(true);

		// Completing the prompt here would kill the in-CLI wakeup timer, so the
		// idle window must not be running: long past it, the session is still up.
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 3);
		expect(runner.isRunning()).toBe(true);

		// The wakeup turn drains the pending work and arms the window.
		await state.endTurn([], "WOKE");
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
		await completed;
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("stop() cancels a pending idle timer", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(keepAliveConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await firstResult;

		runner.stop();
		expect(runner.isRunning()).toBe(false);

		// A stale timer firing after stop() must not throw or resurrect anything.
		await expect(
			vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 2),
		).resolves.not.toThrow();
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("warm-pool sessions without a window stay open indefinitely (unchanged)", async () => {
		const state = installMockQuery(mockQuery);
		// keepSessionWarm=true from the pool, but no keep-alive window configured.
		const runner = new ClaudeRunner(baseConfig, true);

		const firstResult = waitForMessageCount(runner, 2);
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await firstResult;

		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS * 10);
		expect(runner.isRunning()).toBe(true);

		runner.stop();
		await sessionPromise;
	});

	it("without keep-alive or warm pool, the session still ends on result (unchanged)", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(baseConfig, false);

		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await completed;
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("a message appended after the window elapses is rejected, not silently dropped", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(keepAliveConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await firstResult;
		await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
		await completed;

		// The orchestrator catches this and falls back to a resume, so the comment
		// costs a rewrite in the race window but is never lost.
		expect(() => runner.addStreamMessage("too late")).toThrow();
		await sessionPromise;
	});

	describe("warm-session LRU registry integration", () => {
		function makeRegistry() {
			return {
				markIdle: vi.fn(),
				remove: vi.fn(),
				setMaxIdleSessions: vi.fn(),
				getMaxIdleSessions: vi.fn(() => 0),
				idleCount: 0,
			};
		}

		it("registers itself as idle when the keep-alive window arms", async () => {
			const state = installMockQuery(mockQuery);
			const registry = makeRegistry();
			const runner = new ClaudeRunner(
				{ ...keepAliveConfig, warmSessionRegistry: registry as any },
				false,
			);

			const firstResult = waitForMessageCount(runner, 2);
			const sessionPromise = runner.startStreaming("hello");
			await vi.waitFor(() => {
				expect(state.queryOptions).not.toBeNull();
			});

			await state.endTurn([], "done");
			await firstResult;

			// The turn ended warm: the runner is now an idle candidate for the cap.
			expect(registry.markIdle).toHaveBeenCalledWith(runner);

			runner.stop();
			await sessionPromise;
		});

		it("de-registers from the registry when a follow-up message is appended", async () => {
			const state = installMockQuery(mockQuery);
			const registry = makeRegistry();
			const runner = new ClaudeRunner(
				{ ...keepAliveConfig, warmSessionRegistry: registry as any },
				false,
			);

			const firstResult = waitForMessageCount(runner, 2);
			const sessionPromise = runner.startStreaming("hello");
			await vi.waitFor(() => {
				expect(state.queryOptions).not.toBeNull();
			});

			await state.endTurn([], "done");
			await firstResult;
			registry.remove.mockClear();

			// A comment appended before the window elapses makes the session busy
			// again — it must leave the idle set so the cap reflects reality.
			runner.addStreamMessage("one more thing");
			expect(registry.remove).toHaveBeenCalledWith(runner.registryId);

			runner.stop();
			await sessionPromise;
		});

		it("de-registers on shutdown when the idle window elapses", async () => {
			const state = installMockQuery(mockQuery);
			const registry = makeRegistry();
			const runner = new ClaudeRunner(
				{ ...keepAliveConfig, warmSessionRegistry: registry as any },
				false,
			);

			const firstResult = waitForMessageCount(runner, 2);
			const completed = new Promise<void>((resolve) => {
				runner.on("complete", () => resolve());
			});
			const sessionPromise = runner.startStreaming("hello");
			await vi.waitFor(() => {
				expect(state.queryOptions).not.toBeNull();
			});

			await state.endTurn([], "done");
			await firstResult;
			registry.remove.mockClear();

			await vi.advanceTimersByTimeAsync(KEEP_ALIVE_MS);
			await completed;

			expect(registry.remove).toHaveBeenCalledWith(runner.registryId);
			await sessionPromise;
		});

		it("stop() de-registers the idle session from the registry", async () => {
			const state = installMockQuery(mockQuery);
			const registry = makeRegistry();
			const runner = new ClaudeRunner(
				{ ...keepAliveConfig, warmSessionRegistry: registry as any },
				false,
			);

			const firstResult = waitForMessageCount(runner, 2);
			const sessionPromise = runner.startStreaming("hello");
			await vi.waitFor(() => {
				expect(state.queryOptions).not.toBeNull();
			});

			await state.endTurn([], "done");
			await firstResult;
			registry.remove.mockClear();

			runner.stop();
			expect(registry.remove).toHaveBeenCalledWith(runner.registryId);
			await sessionPromise;
		});
	});
});
