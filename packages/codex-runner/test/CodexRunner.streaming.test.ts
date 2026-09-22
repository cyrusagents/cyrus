import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { CodexBackend, CodexUserInput } from "../src/backend/types.js";
import { CodexRunner } from "../src/CodexRunner.js";

/** Minimal fake backend for exercising runner-level streaming wiring. */
class FakeBackend extends EventEmitter implements CodexBackend {
	supportsSteer: boolean;
	steerCalls: CodexUserInput[][] = [];
	private active: boolean;
	constructor(opts: { supportsSteer: boolean; active: boolean }) {
		super();
		this.supportsSteer = opts.supportsSteer;
		this.active = opts.active;
	}
	setActive(active: boolean) {
		this.active = active;
	}
	async open() {
		return { threadId: "t" };
	}
	async runTurn() {}
	steer = vi.fn(async (input: CodexUserInput[]) => {
		this.steerCalls.push(input);
	});
	isTurnActive() {
		return this.active;
	}
	async interrupt() {}
	async close() {}
}

/** Attach a fake backend and mark the runner as running, like a live session. */
function attachRunning(runner: CodexRunner, backend: FakeBackend): void {
	(runner as unknown as { backend: CodexBackend }).backend = backend;
	(
		runner as unknown as {
			sessionInfo: { sessionId: string; startedAt: Date; isRunning: boolean };
		}
	).sessionInfo = { sessionId: "s", startedAt: new Date(), isRunning: true };
}

describe("CodexRunner streaming input selection", () => {
	it("always supports streaming input (Codex runs via app-server)", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			atmikoHome: "/tmp",
		});
		expect(runner.supportsStreamingInput).toBe(true);
	});

	it("steers the active turn when a stream message arrives mid-turn", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			atmikoHome: "/tmp",
		});
		const backend = new FakeBackend({ supportsSteer: true, active: true });
		attachRunning(runner, backend);

		runner.addStreamMessage("fix the auth bug too");

		expect(backend.steer).toHaveBeenCalledTimes(1);
		expect(backend.steerCalls[0]).toEqual([
			{ type: "text", text: "fix the auth bug too" },
		]);
		expect(runner.isStreaming()).toBe(true);
	});

	it("buffers a follow-up that arrives before the turn is active, then flushes it on turn-started", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			atmikoHome: "/tmp",
		});
		// Running, but the turn has not started yet (startup gap).
		const backend = new FakeBackend({ supportsSteer: true, active: false });
		attachRunning(runner, backend);

		// isStreaming must be true during the gap so the caller streams the
		// message in rather than deferring/dropping it.
		expect(runner.isStreaming()).toBe(true);

		runner.addStreamMessage("hows it going?");
		// Not steered yet — buffered until the turn becomes steerable.
		expect(backend.steer).not.toHaveBeenCalled();

		// Turn starts → buffered follow-up is flushed via steer.
		backend.setActive(true);
		(
			runner as unknown as {
				handleBackendEvent: (e: { kind: string }) => void;
			}
		).handleBackendEvent({ kind: "turn-started" });

		expect(backend.steer).toHaveBeenCalledTimes(1);
		expect(backend.steerCalls[0]).toEqual([
			{ type: "text", text: "hows it going?" },
		]);
	});

	it("stops streaming and rejects once the turn has finished", () => {
		const runner = new CodexRunner({
			workingDirectory: "/tmp",
			atmikoHome: "/tmp",
		});
		const backend = new FakeBackend({ supportsSteer: true, active: false });
		attachRunning(runner, backend);
		(
			runner as unknown as {
				handleBackendEvent: (e: unknown) => void;
			}
		).handleBackendEvent({
			kind: "turn-completed",
			usage: { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 },
		});

		expect(runner.isStreaming()).toBe(false);
		expect(() => runner.addStreamMessage("too late")).toThrow(
			/no active codex turn/i,
		);
	});
});
