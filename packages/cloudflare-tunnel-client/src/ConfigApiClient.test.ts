import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigApiClient } from "./ConfigApiClient.js";

afterEach(() => vi.unstubAllGlobals());

describe("hosted listener port contract", () => {
	it.each([
		undefined,
		3456,
		19119,
		1,
		65535,
	])("accepts compatible port %s", async (serverPort) => {
		const response = {
			success: true,
			config: { cloudflareToken: "fixture", apiKey: "fixture", serverPort },
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
		expect(ConfigApiClient.isValid(response)).toBe(true);
		expect(await ConfigApiClient.getConfig("fixture-auth")).toEqual(response);
		expect(fetch).toHaveBeenCalledWith(expect.any(String), {
			headers: { "X-Cyrus-Config-Capabilities": "self-host-port-v1" },
		});
	});
	it.each([
		null,
		0,
		65536,
		-1,
		1.5,
		"19119",
		"19119\nOTHER=value",
		{},
	])("rejects malformed port %s before auth writes", async (serverPort) => {
		const response = {
			success: true,
			config: { cloudflareToken: "fixture", apiKey: "fixture", serverPort },
		};
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json(response)));
		expect(ConfigApiClient.isValid(response as never)).toBe(false);
		expect((await ConfigApiClient.getConfig("fixture-auth")).success).toBe(
			false,
		);
	});
});
