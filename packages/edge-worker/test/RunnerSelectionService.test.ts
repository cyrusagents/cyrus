import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	GPT56_MODEL_BY_LABEL,
	RunnerSelectionService,
} from "../src/RunnerSelectionService.js";

function makeService(): RunnerSelectionService {
	return new RunnerSelectionService({
		defaultRunner: "claude",
	} as EdgeWorkerConfig);
}

describe("RunnerSelectionService GPT-5.6 model routing", () => {
	it.each([
		["terra", GPT56_MODEL_BY_LABEL.terra],
		["luna", GPT56_MODEL_BY_LABEL.luna],
		["sol", GPT56_MODEL_BY_LABEL.sol],
		["gpt-5.6", GPT56_MODEL_BY_LABEL["gpt-5.6"]],
	] as const)("routes %s to the Codex runner as %s", (label, model) => {
		const selection = makeService().determineRunnerSelection([label]);

		expect(selection.runnerType).toBe("codex");
		expect(selection.modelOverride).toBe(model);
		expect(selection.modelOverride).not.toMatch(/^sonnet$/);
		expect(selection.fallbackModelOverride).not.toMatch(/^sonnet$/);
	});

	it.each([
		["low", "low"],
		["effort:medium", "medium"],
		["high", "high"],
	] as const)("accepts %s as reasoning effort %s", (label, effort) => {
		const selection = makeService().determineRunnerSelection(["luna", label]);

		expect(selection.runnerType).toBe("codex");
		expect(selection.modelOverride).toBe("gpt-5.6-luna");
		expect(selection.reasoningEffort).toBe(effort);
	});

	it("defaults reasoning effort to medium", () => {
		expect(
			makeService().determineRunnerSelection(["luna"]).reasoningEffort,
		).toBe("medium");
	});

	it("rejects a recognized GPT label when a Claude runner is explicitly selected", () => {
		expect(() =>
			makeService().determineRunnerSelection(["luna", "claude"]),
		).toThrow(/requires the codex runner/);
	});

	it("logs an unknown model-family label before falling back", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const selection = makeService().determineRunnerSelection([
			"claude-made-up",
		]);

		expect(selection.runnerType).toBe("claude");
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Unknown model label(s): claude-made-up"),
		);

		warn.mockRestore();
	});
});
