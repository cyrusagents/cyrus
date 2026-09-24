import { afterEach, describe, expect, it, vi } from "vitest";
import { getMikoAppUrl } from "../src/app-url.js";

afterEach(() => vi.unstubAllEnvs());

describe("operator-owned control plane", () => {
	it("does not enable an external destination just because credentials exist", () => {
		vi.stubEnv("MIKO_APP_URL", undefined);
		vi.stubEnv("MIKO_API_KEY", "local-api-key");
		vi.stubEnv("MIKO_TEAM_ID", "local-team");
		expect(getMikoAppUrl()).toBeUndefined();
	});

	it("treats an empty URL as disabled", () => {
		vi.stubEnv("MIKO_APP_URL", "   ");
		expect(getMikoAppUrl()).toBeUndefined();
	});

	it("uses the operator's destination without trailing slashes", () => {
		vi.stubEnv("MIKO_APP_URL", " https://control-plane.example.com/// ");
		expect(getMikoAppUrl()).toBe("https://control-plane.example.com");
	});
});
