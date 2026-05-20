import { describe, expect, it, vi } from "vitest";
import { createFetchFailureModesClient } from "../../../src/tools/cyrus-tools/failure-modes-http-client.js";

describe("createFetchFailureModesClient", () => {
	it("sends Bearer token + JSON body to /api/failure-modes", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						success: true,
						action: "created",
						linearIssueUrl: "https://linear.app/x/issue/Y-1",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);
		const client = createFetchFailureModesClient({
			baseUrl: "https://app.atcyrus.com/",
			apiKey: "secret-key",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});

		const result = await client.postFailureMode({
			sessionId: "sess-1",
			category: "x",
			recap: "y",
			userQuoteSnippet: "u",
			agentFailureSnippet: "a",
		});

		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init] = fetchImpl.mock.calls[0]!;
		expect(url).toBe("https://app.atcyrus.com/api/failure-modes");
		expect(init.method).toBe("POST");
		expect(init.headers.Authorization).toBe("Bearer secret-key");
		expect(init.headers["Content-Type"]).toBe("application/json");
		const body = JSON.parse(init.body);
		expect(body.sessionId).toBe("sess-1");
		expect(result).toEqual({
			ok: true,
			action: "created",
			linearIssueUrl: "https://linear.app/x/issue/Y-1",
		});
	});

	it("maps non-2xx response to a structured error", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(JSON.stringify({ error: "Invalid API key" }), {
					status: 401,
				}),
		);
		const client = createFetchFailureModesClient({
			baseUrl: "https://example.com",
			apiKey: "x",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const result = await client.postFailureMode({
			sessionId: "s",
			category: "c",
			recap: "r",
			userQuoteSnippet: "u",
			agentFailureSnippet: "a",
		});
		expect(result).toEqual({
			ok: false,
			status: 401,
			error: "Invalid API key",
		});
	});

	it("returns a transport error when fetch throws", async () => {
		const fetchImpl = vi.fn(async () => {
			throw new Error("network down");
		});
		const client = createFetchFailureModesClient({
			baseUrl: "https://example.com",
			apiKey: "x",
			fetchImpl: fetchImpl as unknown as typeof fetch,
		});
		const result = await client.postFailureMode({
			sessionId: "s",
			category: "c",
			recap: "r",
			userQuoteSnippet: "u",
			agentFailureSnippet: "a",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.status).toBe(0);
			expect(result.error).toMatch(/network down/);
		}
	});
});
