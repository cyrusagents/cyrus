import { describe, expect, it } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";
import type { CodexRunnerConfig } from "../src/types.js";

function makeConfig(
	overrides: Partial<CodexRunnerConfig> = {},
): CodexRunnerConfig {
	return {
		model: "gpt-5.6-luna",
		workingDirectory: "/tmp/cyrus-codex-config-test",
		cyrusHome: "/tmp/cyrus-codex-config-test-home",
		...overrides,
	} as CodexRunnerConfig;
}

describe("CodexConfigBuilder reasoning effort", () => {
	it("defaults to medium", async () => {
		const resolved = await new CodexConfigBuilder(makeConfig()).build();

		expect(resolved.modelReasoningEffort).toBe("medium");
	});

	it("preserves the selected effort", async () => {
		const resolved = await new CodexConfigBuilder(
			makeConfig({ modelReasoningEffort: "low" }),
		).build();

		expect(resolved.modelReasoningEffort).toBe("low");
	});
});
