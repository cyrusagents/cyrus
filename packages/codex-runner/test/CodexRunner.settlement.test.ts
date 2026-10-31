import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../src/CodexRunner.js";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";

function deferred<T = void>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}
class Backend extends EventEmitter {
	supportsSteer = true;
	opening = deferred<{ threadId: string }>();
	turning = deferred();
	closing = deferred();
	open = vi.fn(() => this.opening.promise);
	runTurn = vi.fn(() => this.turning.promise);
	close = vi.fn(() => this.closing.promise);
	isTurnActive = () => true;
	interrupt = async () => {};
}
const dirs: string[] = [];
afterEach(() => {
	vi.restoreAllMocks();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
function setup() {
	const home = mkdtempSync(join(tmpdir(), "cyrus-codex-settlement-"));
	dirs.push(home);
	const runner = new CodexRunner({
		workingDirectory: home,
		cyrusHome: home,
		codexHome: home,
		isolatedProcess: true,
		disableMcpDiscovery: true,
	});
	const backend = new Backend();
	vi.spyOn(runner as never, "createBackend").mockReturnValue(backend as never);
	return { runner, backend };
}
describe("Codex settlement", () => {
	it("does not settle a stopped execution until owned transport cleanup finishes", async () => {
		const { runner, backend } = setup();
		const running = runner.start("read the fixture");
		await vi.waitFor(() => expect(backend.open).toHaveBeenCalled());
		backend.opening.resolve({ threadId: "test" });
		await vi.waitFor(() => expect(backend.runTurn).toHaveBeenCalled());
		let settled = false;
		void running.then(() => {
			settled = true;
		});
		runner.stop();
		backend.turning.resolve();
		await vi.waitFor(() => expect(backend.close).toHaveBeenCalled());
		expect(settled).toBe(false);
		expect(runner.isRunning()).toBe(true);
		backend.closing.resolve();
		await running;
		expect(runner.isRunning()).toBe(false);
	});
	it("never starts a turn after cancellation while opening", async () => {
		const { runner, backend } = setup();
		const running = runner.start("must not execute");
		await vi.waitFor(() => expect(backend.open).toHaveBeenCalled());
		runner.stop();
		backend.opening.resolve({ threadId: "test" });
		backend.closing.resolve();
		await running;
		expect(backend.runTurn).not.toHaveBeenCalled();
	});
	it("does not open after cancellation while building configuration", async () => {
		const { runner, backend } = setup();
		const gate = deferred<Awaited<ReturnType<CodexConfigBuilder["build"]>>>();
		vi.spyOn(CodexConfigBuilder.prototype, "build").mockReturnValue(
			gate.promise,
		);
		const running = runner.start("must not execute");
		runner.stop();
		backend.closing.resolve();
		gate.resolve({} as never);
		await running;
		expect(backend.open).not.toHaveBeenCalled();
		expect(backend.runTurn).not.toHaveBeenCalled();
	});
	it("awaits cleanup even when starting a turn has an uncertain RPC failure", async () => {
		const { runner, backend } = setup();
		backend.runTurn.mockRejectedValue(new Error("turn/start timed out"));
		const running = runner.start("uncertain dispatch");
		backend.opening.resolve({ threadId: "test" });
		let settled = false;
		void running.then(() => {
			settled = true;
		});
		await vi.waitFor(() => expect(backend.close).toHaveBeenCalled());
		expect(settled).toBe(false);
		expect(backend.runTurn).toHaveBeenCalled();
		backend.closing.resolve();
		await running;
	});
});

it("keeps unknown teardown fenced instead of reporting settlement", async () => {
	const { runner, backend } = setup();
	const observed = deferred();
	runner.on("error", () => observed.resolve());
	backend.close.mockRejectedValue(new Error("termination probe unavailable"));
	const running = runner.start("hold");
	backend.opening.resolve({ threadId: "test" });
	backend.turning.resolve();
	let settled = false;
	void running.finally(() => {
		settled = true;
	});
	await observed.promise;
	expect(settled).toBe(false);
	expect(runner.isRunning()).toBe(true);
});
