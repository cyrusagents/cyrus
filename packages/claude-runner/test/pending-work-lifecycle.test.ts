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
 * CYPACK-1310: ScheduleWakeup (and CronCreate//loop) timers live inside the
 * CLI subprocess. Completing the streaming prompt on `result` closes the
 * CLI's stdin and the timer dies with it. The only signal that pending work
 * exists is the Stop hook's `session_crons`/`background_tasks` — verified
 * empirically (see apps/f1/test-drives/2026-06-11-cypack-1310-schedulewakeup.md):
 * the message stream itself is identical with and without pending wakeups.
 *
 * These tests emulate the real CLI contract:
 *  - the Stop hook fires BEFORE the `result` message is emitted
 *  - the query iterator ends only when the input stream is completed
 */

const SESSION_CRON = {
	id: "cron-1",
	schedule: "27 12 * * *",
	recurring: false,
	prompt: "WAKEUP: continue the test",
};

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

/**
 * Build a mock SDK query whose turns are driven by the test. Each call to
 * `endTurn(cronList, resultText)` fires the recorded Stop hooks (with the
 * given session_crons) and then emits a result message — mirroring the real
 * CLI's hook-before-result ordering. The iterator ends when the runner's
 * input stream (queryOptions.prompt) completes, exactly like the real CLI
 * exiting on stdin EOF.
 */
function installMockQuery(mockQuery: ReturnType<typeof vi.mocked<any>>) {
	const state: {
		queryOptions: any;
		endTurn: (
			crons: (typeof SESSION_CRON)[],
			resultText: string,
		) => Promise<void>;
		endTurnWithWork: (
			work: { sessionCrons?: any[]; backgroundTasks?: any[] },
			resultText: string,
		) => Promise<void>;
	} = {
		queryOptions: null,
		endTurn: async () => {},
		endTurnWithWork: async () => {},
	};

	mockQuery.mockImplementation(({ options, prompt }: any) => {
		state.queryOptions = options;

		const emitted: SDKMessage[] = [makeSystemInit()];
		let notify: (() => void) | null = null;
		let inputDone = false;

		// Consume the streaming input like the CLI does; flag EOF.
		(async () => {
			for await (const _msg of prompt) {
				// messages consumed; turn lifecycle is driven by endTurn()
			}
			inputDone = true;
			notify?.();
		})();

		state.endTurnWithWork = async (work, resultText) => {
			const stopMatchers = options.hooks?.Stop ?? [];
			for (const matcher of stopMatchers) {
				for (const hook of matcher.hooks) {
					await hook(
						{
							hook_event_name: "Stop",
							stop_hook_active: false,
							session_crons: work.sessionCrons ?? [],
							background_tasks: work.backgroundTasks ?? [],
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
		state.endTurn = (crons, resultText) =>
			state.endTurnWithWork({ sessionCrons: crons }, resultText);

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

describe("ClaudeRunner pending-work lifecycle (CYPACK-1310)", () => {
	let mockQuery: any;

	const defaultConfig: ClaudeRunnerConfig = {
		workingDirectory: "/tmp/test",
		cyrusHome: "/tmp/test-cyrus-home",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		mockQuery = vi.mocked(query);
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("merges the pending-work recorder into caller-provided Stop hooks", async () => {
		const state = installMockQuery(mockQuery);
		const callerStopHook = vi.fn(async () => ({}));
		const runner = new ClaudeRunner({
			...defaultConfig,
			hooks: {
				Stop: [{ matcher: ".*", hooks: [callerStopHook] }],
			},
		});

		const completion = waitForMessageCount(runner, 2);
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		// Both the caller's hook and the internal recorder are registered.
		expect(state.queryOptions.hooks.Stop).toHaveLength(2);

		await state.endTurn([], "done");
		await completion;
		expect(callerStopHook).toHaveBeenCalledTimes(1);
		await sessionPromise;
	});

	it("completes the prompt on result when nothing is pending (cold mode)", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(defaultConfig, false);

		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");

		// With no pending work the prompt completes, the iterator ends, and
		// the session finishes — no external completeStream() call needed.
		await completed;
		expect(runner.isRunning()).toBe(false);
		expect(runner.hasPendingWork()).toBe(false);
		await sessionPromise;
	});

	it("holds the prompt open when a wakeup is pending, then completes after the wakeup turn", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(defaultConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("schedule a wakeup");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		// Turn 1 ends with a pending one-shot wakeup.
		await state.endTurn([SESSION_CRON], "SCHEDULED");
		await firstResult;

		// The runner recorded the pending work and held the stream open: the
		// session is still running and still accepting streamed messages.
		expect(runner.hasPendingWork()).toBe(true);
		expect(runner.getPendingWork().sessionCrons).toEqual([SESSION_CRON]);
		expect(runner.isRunning()).toBe(true);
		expect(runner.isStreaming()).toBe(true);

		// Turn 2 (the wakeup turn) ends with nothing pending → prompt
		// completes → iterator ends → session finishes.
		await state.endTurn([], "WOKE");
		await completed;
		expect(runner.hasPendingWork()).toBe(false);
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("holds the prompt open for an in-flight background task, then completes when it settles", async () => {
		// A `Bash(run_in_background: true)` task is registered by the SDK and
		// reported in the Stop hook's background_tasks. Verified against the
		// real SDK (CYPACK-1310 bgbash probe): closing stdin while such a task
		// is running KILLS it, so the prompt must stay open until it settles.
		// (A bare `sleep 120 &` is NOT registered — the Bash tool call returns
		// instantly — so background_tasks is empty and there is nothing to
		// hold open; that is an SDK-tracking limitation, not a Cyrus bug.)
		const BG_TASK = {
			id: "task-1",
			type: "shell",
			status: "running",
			description: "Sleep for 120 seconds in background",
			command: "sleep 120",
		};
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(defaultConfig, false);

		const firstResult = waitForMessageCount(runner, 2);
		const completed = new Promise<void>((resolve) => {
			runner.on("complete", () => resolve());
		});
		const sessionPromise = runner.startStreaming("run a background command");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		// Turn 1 ends with the background task still running.
		await state.endTurnWithWork({ backgroundTasks: [BG_TASK] }, "STARTED");
		await firstResult;

		expect(runner.hasPendingWork()).toBe(true);
		expect(runner.getPendingWork().backgroundTasks).toEqual([BG_TASK]);
		expect(runner.isRunning()).toBe(true);

		// The task settles → its notification wakes a turn that ends with no
		// pending work → prompt completes → session finishes.
		await state.endTurnWithWork({ backgroundTasks: [] }, "done");
		await completed;
		expect(runner.hasPendingWork()).toBe(false);
		expect(runner.isRunning()).toBe(false);
		await sessionPromise;
	});

	it("keeps warm-mode behavior unchanged (stream stays open regardless)", async () => {
		const state = installMockQuery(mockQuery);
		const runner = new ClaudeRunner(defaultConfig, true);

		const firstResult = waitForMessageCount(runner, 2);
		const sessionPromise = runner.startStreaming("hello");
		await vi.waitFor(() => {
			expect(state.queryOptions).not.toBeNull();
		});

		await state.endTurn([], "done");
		await firstResult;

		// Warm sessions never complete the prompt on result.
		expect(runner.isRunning()).toBe(true);
		expect(runner.isStreaming()).toBe(true);

		// Cleanup: complete the stream so the mock iterator ends.
		runner.completeStream();
		await sessionPromise;
	});
});
