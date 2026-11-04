import { vi } from "vitest";
import { PlaneApiClient } from "../src/PlaneApiClient.js";

export const BASE = "http://plane.localhost";
export const API = `${BASE}/api/v1/workspaces/acme`;

/**
 * Fake Plane server: routes "METHOD path" to a JSON body, or to a Response
 * (e.g. a redirect or file bytes); records requests. Paths outside the API
 * are keyed by their full URL.
 */
export function fakePlane(routes: Record<string, unknown>) {
	const calls: Array<{ method: string; url: string; body?: unknown }> = [];
	const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
		const method = init.method ?? "GET";
		calls.push({
			method,
			url,
			body:
				init.body && method !== "GET" && !url.endsWith("/auth/o/token/")
					? JSON.parse(String(init.body))
					: undefined,
		});
		if (url === `${BASE}/auth/o/token/`) {
			return new Response(
				JSON.stringify({ access_token: "bot-token", expires_in: 3600 }),
			);
		}
		const key = `${method} ${url.replace(API, "")}`;
		if (!(key in routes)) {
			return new Response("not found", { status: 404 });
		}
		const route = routes[key];
		if (route instanceof Response) {
			return route.clone();
		}
		return new Response(JSON.stringify(route));
	});
	const api = new PlaneApiClient(
		{
			baseUrl: BASE,
			workspaceSlug: "acme",
			clientId: "cid",
			clientSecret: "secret",
			appInstallationId: "inst-1",
		},
		{ fetch: fetchImpl as never },
	);
	return { api, calls, fetchImpl };
}
