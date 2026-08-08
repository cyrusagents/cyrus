import { describe, expect, it } from "vitest";
import { EdgeConfigSchema } from "../src/config-schemas.js";

const baseConfig = {
	repositories: [],
};

describe("runner fallback config", () => {
	it("accepts a typed Claude quota fallback policy", () => {
		const result = EdgeConfigSchema.safeParse({
			...baseConfig,
			runnerFallbacks: {
				claude: {
					runners: ["codex"],
					rateLimitTypes: ["five_hour", "seven_day"],
				},
			},
		});

		expect(result.success).toBe(true);
	});

	it("rejects unknown quota categories", () => {
		const result = EdgeConfigSchema.safeParse({
			...baseConfig,
			runnerFallbacks: {
				claude: {
					runners: ["codex"],
					rateLimitTypes: ["authentication_error"],
				},
			},
		});

		expect(result.success).toBe(false);
	});

	it("rejects a direct fallback loop", () => {
		const result = EdgeConfigSchema.safeParse({
			...baseConfig,
			runnerFallbacks: {
				claude: {
					runners: ["claude"],
					rateLimitTypes: ["five_hour"],
				},
			},
		});

		expect(result.success).toBe(false);
	});
});
