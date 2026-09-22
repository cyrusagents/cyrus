import { afterEach, describe, expect, it, vi } from "vitest";
import { getAtmikoAppUrl } from "../src/app-url.js";

afterEach(() => vi.unstubAllEnvs());

describe("operator-owned control plane", () => {
	it("does not enable an external destination just because credentials exist", () => {
		vi.stubEnv("ATMIKO_APP_URL", undefined);
		vi.stubEnv("ATMIKO_API_KEY", "local-api-key");
		vi.stubEnv("ATMIKO_TEAM_ID", "local-team");
		expect(getAtmikoAppUrl()).toBeUndefined();
	});

	it("treats an empty URL as disabled", () => {
		vi.stubEnv("ATMIKO_APP_URL", "   ");
		expect(getAtmikoAppUrl()).toBeUndefined();
	});

	it("uses the operator's destination without trailing slashes", () => {
		vi.stubEnv("ATMIKO_APP_URL", " https://control-plane.example.com/// ");
		expect(getAtmikoAppUrl()).toBe("https://control-plane.example.com");
	});
});
