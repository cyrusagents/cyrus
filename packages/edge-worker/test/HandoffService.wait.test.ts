import { describe, expect, it, vi } from "vitest";
import { HandoffService } from "../src/HandoffService.js";

function svc() {
	const reader = {
		getCurrentBranch: () => "",
		getStatus: () => "",
		getRecentCommits: () => "",
		getDiffSummary: () => "",
		getOpenPrUrl: () => undefined,
	};
	return new HandoffService(reader as any);
}

describe("HandoffService.waitForStopped", () => {
	it("returns true once the runner reports stopped", async () => {
		let calls = 0;
		const isRunning = () => {
			calls += 1;
			return calls < 3; // running for 2 polls, then stopped
		};
		const stopped = await svc().waitForStopped(isRunning, {
			timeoutMs: 1000,
			pollIntervalMs: 100,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		expect(stopped).toBe(true);
	});

	it("returns false when the runner never stops within the timeout", async () => {
		const stopped = await svc().waitForStopped(() => true, {
			timeoutMs: 300,
			pollIntervalMs: 100,
			sleep: vi.fn().mockResolvedValue(undefined),
		});
		expect(stopped).toBe(false);
	});

	it("returns true immediately when already stopped", async () => {
		const sleep = vi.fn().mockResolvedValue(undefined);
		const stopped = await svc().waitForStopped(() => false, {
			timeoutMs: 300,
			pollIntervalMs: 100,
			sleep,
		});
		expect(stopped).toBe(true);
		expect(sleep).not.toHaveBeenCalled();
	});
});
