import type { EdgeWorkerConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RunnerSelectionService } from "../src/RunnerSelectionService.js";

const envKeys = [
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_API_KEY",
	"GEMINI_API_KEY",
	"OPENAI_API_KEY",
	"CURSOR_API_KEY",
	"OPENCODE_API_KEY",
] as const;

describe("RunnerSelectionService", () => {
	const originalEnv: Record<string, string | undefined> = {};

	beforeEach(() => {
		for (const key of envKeys) {
			originalEnv[key] = process.env[key];
			delete process.env[key];
		}
	});

	afterEach(() => {
		for (const key of envKeys) {
			const value = originalEnv[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	});

	it("does not auto-detect OpenCode from an API key because OpenCode auth is CLI-managed", () => {
		process.env.OPENCODE_API_KEY = "not-used-by-opencode";

		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		expect(service.getDefaultRunner()).toBe("claude");
	});

	it("supports explicit OpenCode default runner without requiring model config", () => {
		const service = new RunnerSelectionService({
			defaultRunner: "opencode",
		} as EdgeWorkerConfig);

		expect(service.getDefaultRunner()).toBe("opencode");
		expect(service.getDefaultModelForRunner("opencode")).toBeUndefined();
		expect(
			service.getDefaultFallbackModelForRunner("opencode"),
		).toBeUndefined();
	});

	it("does not infer OpenCode from provider/model syntax unless configured", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			[],
			"[model=anthropic/claude-sonnet-4.5]",
		);

		expect(selection.runnerType).toBe("claude");
		expect(selection.modelOverride).toBe("anthropic/claude-sonnet-4.5");
	});

	it("infers OpenCode from provider/model syntax when configured", () => {
		const service = new RunnerSelectionService({
			inferOpenCodeRunnerFromProviderModel: true,
		} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			[],
			"[model=anthropic/claude-sonnet-4.5]",
		);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("anthropic/claude-sonnet-4.5");
	});

	it("keeps explicit OpenCode model selection independent of provider/model inference", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			[],
			"[agent=opencode]\n[model=openai/gpt-5]",
		);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("openai/gpt-5");
	});

	it("selects OpenCode runner and provider-qualified model from a three-part label", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection([
			"opencode/openai/gpt-5.5",
		]);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("openai/gpt-5.5");
		expect(selection.fallbackModelOverride).toBeUndefined();
	});

	it("passes two-part OpenCode labels through for runner validation", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection([
			"opencode/kimi-k2.7-code",
		]);

		expect(selection.runnerType).toBe("opencode");
		expect(selection.modelOverride).toBe("opencode/kimi-k2.7-code");
	});

	it("maps openai provider labels to the Codex runner", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(["openai/gpt-5.5"]);

		expect(selection.runnerType).toBe("codex");
		expect(selection.modelOverride).toBe("gpt-5.5");
	});

	it("lets description selectors override provider/model labels", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(
			["opencode/openai/gpt-5.5"],
			"[agent=claude]\n[model=sonnet]",
		);

		expect(selection.runnerType).toBe("claude");
		expect(selection.modelOverride).toBe("sonnet");
	});
});
