/**
 * Tests for ProjectDescriptionCache (Workstream A2) — the best-effort client
 * for the bridge-backed project-description cache.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ProjectDescriptionCache } from "../src/ProjectDescriptionCache.js";

describe("ProjectDescriptionCache.fromEnv", () => {
	const original = {
		url: process.env.CYRUS_PROJECT_CACHE_URL,
		token: process.env.CYRUS_PROJECT_CACHE_TOKEN,
	};

	afterEach(() => {
		process.env.CYRUS_PROJECT_CACHE_URL = original.url;
		process.env.CYRUS_PROJECT_CACHE_TOKEN = original.token;
	});

	it("is unconfigured when env vars are absent", () => {
		delete process.env.CYRUS_PROJECT_CACHE_URL;
		delete process.env.CYRUS_PROJECT_CACHE_TOKEN;
		expect(ProjectDescriptionCache.fromEnv().isConfigured).toBe(false);
	});

	it("is unconfigured when only one env var is present", () => {
		process.env.CYRUS_PROJECT_CACHE_URL = "https://example.com/cache";
		delete process.env.CYRUS_PROJECT_CACHE_TOKEN;
		expect(ProjectDescriptionCache.fromEnv().isConfigured).toBe(false);
	});

	it("is configured when both env vars are present", () => {
		process.env.CYRUS_PROJECT_CACHE_URL = "https://example.com/cache";
		process.env.CYRUS_PROJECT_CACHE_TOKEN = "secret-token";
		expect(ProjectDescriptionCache.fromEnv().isConfigured).toBe(true);
	});
});

describe("ProjectDescriptionCache (unconfigured)", () => {
	const cache = new ProjectDescriptionCache(null);

	it("get() resolves to undefined without making a request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		expect(await cache.get("project-1")).toBeUndefined();
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});

	it("set() is a no-op without making a request", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		await cache.set("project-1", "desc");
		expect(fetchSpy).not.toHaveBeenCalled();
		fetchSpy.mockRestore();
	});
});

describe("ProjectDescriptionCache (configured)", () => {
	const cache = new ProjectDescriptionCache({
		url: "https://example.com/cyrus-project-cache",
		token: "secret-token",
	});

	beforeEach(() => {
		vi.restoreAllMocks();
	});

	it("get() returns the cached description on a hit", async () => {
		const updatedAt = "2026-05-15T10:00:00.000Z";
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({
					description: "Enterprise audience.",
					updated_at: updatedAt,
				}),
				{ status: 200 },
			),
		);
		const result = await cache.get("project-1");
		expect(result?.description).toBe("Enterprise audience.");
		expect(result?.updatedAtMs).toBe(Date.parse(updatedAt));
	});

	it("get() returns description with undefined updatedAtMs when updated_at is absent", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ description: "No timestamp." }), {
				status: 200,
			}),
		);
		const result = await cache.get("project-1");
		expect(result?.description).toBe("No timestamp.");
		expect(result?.updatedAtMs).toBeUndefined();
	});

	it("get() uses URL.searchParams for the linear_project_id (E3)", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(
				new Response(JSON.stringify({ description: "x" }), { status: 200 }),
			);
		await cache.get("project with spaces & symbols");
		const [calledUrl] = fetchSpy.mock.calls[0]!;
		expect(typeof calledUrl).toBe("string");
		const parsed = new URL(calledUrl as string);
		expect(parsed.searchParams.get("linear_project_id")).toBe(
			"project with spaces & symbols",
		);
	});

	it("get() returns undefined on a 404 miss", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify({ error: "not found" }), { status: 404 }),
		);
		expect(await cache.get("project-1")).toBeUndefined();
	});

	it("get() returns undefined (does not throw) on a network error", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
		expect(await cache.get("project-1")).toBeUndefined();
	});

	it("set() POSTs the project id and description with the bearer token", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(new Response("{}", { status: 200 }));
		await cache.set("project-1", "New description.");
		expect(fetchSpy).toHaveBeenCalledTimes(1);
		const [url, init] = fetchSpy.mock.calls[0]!;
		expect(url).toBe("https://example.com/cyrus-project-cache");
		expect(init?.method).toBe("POST");
		expect((init?.headers as Record<string, string>).Authorization).toBe(
			"Bearer secret-token",
		);
		expect(JSON.parse(init?.body as string)).toEqual({
			linear_project_id: "project-1",
			description: "New description.",
		});
	});

	it("set() swallows network errors", async () => {
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ETIMEDOUT"));
		await expect(cache.set("project-1", "desc")).resolves.toBeUndefined();
	});
});
