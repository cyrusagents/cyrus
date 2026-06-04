import { describe, expect, it } from "vitest";
import { LinearWorkspaceConfigSchema } from "../src/config-schemas.js";

describe("LinearWorkspaceConfigSchema", () => {
	it("preserves linearTokenExpiresAt so proactive refresh can persist expiry (CRATE-153)", () => {
		const parsed = LinearWorkspaceConfigSchema.parse({
			linearToken: "lin_oauth_abc",
			linearRefreshToken: "lin_refresh_def",
			linearWorkspaceName: "AGC-prod",
			linearTokenExpiresAt: 1780000000000,
		});
		expect(parsed.linearTokenExpiresAt).toBe(1780000000000);
	});

	it("keeps linearTokenExpiresAt optional for configs written before the field existed", () => {
		const parsed = LinearWorkspaceConfigSchema.parse({
			linearToken: "lin_oauth_abc",
		});
		expect(parsed.linearTokenExpiresAt).toBeUndefined();
	});
});
