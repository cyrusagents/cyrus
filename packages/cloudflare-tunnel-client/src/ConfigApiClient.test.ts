import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigApiClient, getCyrusAppUrl } from "./ConfigApiClient.js";

afterEach(() => {
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
});

describe("pairing credential transport", () => {
	it("uses preview Authorization without a query or redirect and normalizes trailing slash", async () => {
		vi.stubEnv(
			"CYRUS_APP_URL",
			"https://cyrus-preview-cyhost-1321.vercel.app/",
		);
		const fetcher = vi.fn().mockResolvedValue(
			Response.json({
				success: true,
				config: { cloudflareToken: "fixture-tunnel", apiKey: "fixture-key" },
			}),
		);
		vi.stubGlobal("fetch", fetcher);
		expect((await ConfigApiClient.getConfig("fixture-auth-code")).success).toBe(
			true,
		);
		expect(fetcher).toHaveBeenCalledWith(
			"https://cyrus-preview-cyhost-1321.vercel.app/api/config",
			{
				headers: {
					Authorization: "Bearer fixture-auth-code",
					"X-Cyrus-Config-Capabilities": "self-host-port-v1",
				},
				redirect: "error",
				signal: expect.any(AbortSignal),
			},
		);
		expect(getCyrusAppUrl()).toBe(
			"https://cyrus-preview-cyhost-1321.vercel.app",
		);
	});

	it.each([
		"http",
		"json",
		"exception",
	])("does not reflect credentials from %s errors into CLI output", async (mode) => {
		const sensitive = "fixture-auth-code-never-logged";
		const fetcher = vi.fn();
		if (mode === "http")
			fetcher.mockResolvedValue(
				new Response(sensitive, { status: 401, statusText: sensitive }),
			);
		if (mode === "json")
			fetcher.mockResolvedValue(
				Response.json({ success: false, error: sensitive }),
			);
		if (mode === "exception") fetcher.mockRejectedValue(new Error(sensitive));
		vi.stubGlobal("fetch", fetcher);
		const result = await ConfigApiClient.getConfig(sensitive);
		expect(result.success).toBe(false);
		expect(JSON.stringify(result)).not.toContain(sensitive);
	});
});
