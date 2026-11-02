import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

// The SDK is stubbed to fail the way an auth/spawn failure does; everything
// else is the real ClaudeRunner.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";

// Callers (e.g. the Jira task service) rely on this contract: a failure
// before any result is reported through onError and start() RESOLVES — it
// does not reject — with no result message emitted.
describe("ClaudeRunner error contract", () => {
	const root = mkdtempSync(join(tmpdir(), "cyrus-error-contract-"));
	mkdirSync(join(root, "home", "logs", "project"), { recursive: true });
	mkdirSync(join(root, "project"));
	afterAll(async () => {
		await new Promise((r) => setTimeout(r, 50));
		rmSync(root, { recursive: true, force: true });
	});

	it("emits onError and resolves start without a result when the SDK fails", async () => {
		vi.mocked(query).mockImplementation((() => {
			// biome-ignore lint/correctness/useYield: fails before yielding, like an auth error
			return (async function* () {
				throw new Error("Invalid API key · Please run /login");
			})();
		}) as any);
		const onError = vi.fn();
		const messages: any[] = [];
		const runner = new ClaudeRunner({
			workingDirectory: join(root, "project"),
			cyrusHome: join(root, "home"),
			onError,
			onMessage: (m) => {
				messages.push(m);
			},
		});
		const info = await runner.start("hi");
		expect(info.isRunning).toBe(false);
		expect(onError).toHaveBeenCalledTimes(1);
		expect(onError.mock.calls[0]![0].message).toContain("Invalid API key");
		expect(messages.filter((m) => m.type === "result")).toEqual([]);
	});
});
