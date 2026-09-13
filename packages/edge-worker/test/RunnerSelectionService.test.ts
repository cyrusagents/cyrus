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

	it("maps GPT-6 Astra labels to the Codex runner", () => {
		const service = new RunnerSelectionService({} as EdgeWorkerConfig);

		const selection = service.determineRunnerSelection(["gpt-6-astra"]);

		expect(selection.runnerType).toBe("codex");
		expect(selection.modelOverride).toBe("gpt-6-astra");
		expect(selection.fallbackModelOverride).toBe("gpt-5.2-codex");
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

	// CYR-79 context, and an honest note about what these do and do not prove.
	//
	// This precedence is NOT what the defect broke — it worked before CYR-79 and
	// is unchanged by it. What these pin is the CONTRACT the fix has to serve:
	// the runner an issue gets is decided here, inside the sandbox, per turn,
	// from tags and labels the router never sees — which is why the credential
	// could not be delivered on the router's workspace-wide default. If this
	// precedence were ever changed to consult the default first, the reason the
	// router now delivers unconditionally would quietly evaporate.
	//
	// The defect itself is reproduced in
	// `packages/router/test/ContainerTargets.test.ts` ("the Codex credential is
	// delivered independently of the default"). The two halves live in different
	// packages and there is no single test spanning both.
	describe("an issue-level Codex selection under a non-Codex default", () => {
		const claudeDefault = {
			defaultRunner: "claude",
			claudeDefaultModel: "opus",
		} as EdgeWorkerConfig;

		it("wins over a Claude default via an [agent=codex] tag", () => {
			const service = new RunnerSelectionService(claudeDefault);

			const selection = service.determineRunnerSelection([], "[agent=codex]");

			expect(service.getDefaultRunner()).toBe("claude");
			expect(selection.runnerType).toBe("codex");
			// Whatever the container was told the Codex default is — which since
			// CYR-79 the router sets from its catalog even on a Claude container.
			expect(selection.modelOverride).toBe("gpt-5.5");
		});

		it("takes the Codex default the container was given, not the Claude one", () => {
			const service = new RunnerSelectionService({
				...claudeDefault,
				codexDefaultModel: "gpt-5.6-sol",
			} as EdgeWorkerConfig);

			const selection = service.determineRunnerSelection([], "[agent=codex]");

			expect(selection.runnerType).toBe("codex");
			expect(selection.modelOverride).toBe("gpt-5.6-sol");
		});

		it("wins over a Claude default via a [model=] tag naming a Codex model", () => {
			const service = new RunnerSelectionService(claudeDefault);

			const selection = service.determineRunnerSelection(
				[],
				"[model=gpt-5.6-sol]",
			);

			expect(selection.runnerType).toBe("codex");
			expect(selection.modelOverride).toBe("gpt-5.6-sol");
		});

		it("wins over a Claude default via a label", () => {
			const service = new RunnerSelectionService(claudeDefault);

			const selection = service.determineRunnerSelection(["codex"]);

			expect(selection.runnerType).toBe("codex");
		});
	});

	// The built-in below is a LAST resort: since CYR-79 the router emits
	// `CYRUS_CODEX_DEFAULT_MODEL` on every container from its own catalog, so
	// `codexDefaultModel` is normally set and this constant is reached only on a
	// deployment that predates that. It is deliberately the probe-verified
	// `gpt-5.5` and not the newer `gpt-5.6-sol`, because this value is baked into
	// the worker image and changing it costs a rebuild — the opposite of the
	// one-line rollback an unverified model needs.
	describe("Codex model defaults", () => {
		it("falls back to the probe-verified model when the container names none", () => {
			const service = new RunnerSelectionService({} as EdgeWorkerConfig);

			expect(service.getDefaultModelForRunner("codex")).toBe("gpt-5.5");
		});

		it("lets the value the router delivered win", () => {
			const service = new RunnerSelectionService({
				codexDefaultModel: "gpt-5.6-sol",
			} as EdgeWorkerConfig);

			expect(service.getDefaultModelForRunner("codex")).toBe("gpt-5.6-sol");
		});

		it("falls back to a model subscription auth actually serves", () => {
			// `gpt-5.2-codex` was rejected outright on a live ChatGPT account, so
			// the old fallback could only ever fail for the credential most
			// sessions run on.
			const service = new RunnerSelectionService({} as EdgeWorkerConfig);

			expect(service.getDefaultFallbackModelForRunner("codex")).toBe("gpt-5.5");
		});

		it("does not hand a Codex model to a Cursor session", () => {
			// Cursor used to reach the same catch-all as Codex in
			// `inferFallbackModel` and take `gpt-5.5` — and because
			// `fallbackModelOverride` is always truthy, that shadowed the
			// configured Cursor fallback downstream.
			const service = new RunnerSelectionService({
				cursorDefaultFallbackModel: "composer-2",
			} as EdgeWorkerConfig);

			const selection = service.determineRunnerSelection(
				[],
				"[agent=cursor]\n[model=composer-2]",
			);

			expect(selection.runnerType).toBe("cursor");
			expect(selection.fallbackModelOverride).toBe("composer-2");
		});
	});
});
