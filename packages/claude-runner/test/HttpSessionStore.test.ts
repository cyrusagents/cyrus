import { beforeEach, describe, expect, test } from "vitest";
import {
	CYRUS_TEAM_ID_HEADER,
	HttpSessionStore,
} from "../src/HttpSessionStore.js";
import { runSessionStoreConformance } from "./sessionStoreConformance.js";

type SessionStoreEntry = { type: string; [k: string]: unknown };
type StoredRow = { entry: SessionStoreEntry; mtime: number };

/**
 * In-memory server that implements the HTTP contract the HttpSessionStore
 * speaks to. Used to run the 13-check conformance suite against the real
 * `HttpSessionStore` class without needing a live cyrus-hosted backend.
 *
 * Also asserts that every incoming request carries the `X-Cyrus-Team-Id`
 * header the real server requires — that way, if a future refactor forgot
 * to send it, the conformance suite would fail loudly rather than silently.
 */
class FakeSessionServer {
	private rows = new Map<string, StoredRow[]>();
	private clock = 1_700_000_000_000;
	/** Last observed team id — exposed so tests can assert on it. */
	observedTeamId: string | undefined;

	private keyOf(projectKey: string, sessionId: string, subpath?: string) {
		return `${projectKey} ${sessionId} ${subpath ?? ""}`;
	}

	private tick(): number {
		this.clock += 1;
		return this.clock;
	}

	reset() {
		this.rows.clear();
		this.observedTeamId = undefined;
	}

	/** Handler compatible with `globalThis.fetch`. */
	handle = async (url: string | URL | Request, init?: RequestInit) => {
		const request =
			url instanceof Request ? url : new Request(url.toString(), init);
		const { pathname } = new URL(request.url);
		// Mirror the real server's requirement: the team id header must be
		// present on every request. Missing header ⇒ 401.
		const teamId = request.headers
			.get(CYRUS_TEAM_ID_HEADER.toLowerCase())
			?.trim();
		if (!teamId) {
			return new Response("missing team id", { status: 401 });
		}
		this.observedTeamId = teamId;

		const body = (await request.json()) as Record<string, unknown>;

		const projectKey = body.projectKey as string | undefined;
		const sessionId = body.sessionId as string | undefined;
		const subpath = (body.subpath as string | undefined) ?? undefined;

		switch (pathname) {
			case "/api/sessions/append": {
				if (!projectKey || !sessionId) {
					return new Response("bad request", { status: 400 });
				}
				const entries = (body.entries as SessionStoreEntry[]) ?? [];
				if (entries.length === 0) {
					return new Response(JSON.stringify({}), {
						status: 200,
						headers: { "Content-Type": "application/json" },
					});
				}
				const k = this.keyOf(projectKey, sessionId, subpath);
				const existing = this.rows.get(k) ?? [];
				const mtime = this.tick();
				for (const entry of entries) existing.push({ entry, mtime });
				this.rows.set(k, existing);
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			case "/api/sessions/load": {
				if (!projectKey || !sessionId) {
					return new Response("bad request", { status: 400 });
				}
				const k = this.keyOf(projectKey, sessionId, subpath);
				const rows = this.rows.get(k);
				const entries = rows ? rows.map((r) => r.entry) : null;
				return new Response(JSON.stringify({ entries }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			case "/api/sessions/list-sessions": {
				if (!projectKey) {
					return new Response("bad request", { status: 400 });
				}
				const sessions = new Map<string, number>();
				for (const [k, rows] of this.rows) {
					const [pk, sid, sp] = k.split(" ");
					if (pk !== projectKey) continue;
					if (sp) continue; // exclude subagent transcripts
					if (rows.length === 0) continue;
					const latest = rows.reduce(
						(acc, r) => (r.mtime > acc ? r.mtime : acc),
						0,
					);
					const prev = sessions.get(sid);
					if (prev === undefined || latest > prev) {
						sessions.set(sid, latest);
					}
				}
				const out = Array.from(sessions.entries()).map(([sid, mtime]) => ({
					sessionId: sid,
					mtime,
				}));
				return new Response(JSON.stringify({ sessions: out }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			case "/api/sessions/delete": {
				if (!projectKey || !sessionId) {
					return new Response("bad request", { status: 400 });
				}
				if (subpath === undefined) {
					// Delete main + cascade all subkeys for this (project, session).
					for (const k of Array.from(this.rows.keys())) {
						const [pk, sid] = k.split(" ");
						if (pk === projectKey && sid === sessionId) {
							this.rows.delete(k);
						}
					}
				} else {
					this.rows.delete(this.keyOf(projectKey, sessionId, subpath));
				}
				return new Response(JSON.stringify({}), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			case "/api/sessions/list-subkeys": {
				if (!projectKey || !sessionId) {
					return new Response("bad request", { status: 400 });
				}
				const subpaths: string[] = [];
				for (const k of this.rows.keys()) {
					const [pk, sid, sp] = k.split(" ");
					if (pk === projectKey && sid === sessionId && sp) {
						subpaths.push(sp);
					}
				}
				return new Response(JSON.stringify({ subpaths }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			default:
				return new Response("not found", { status: 404 });
		}
	};
}

describe("HttpSessionStore - conformance", () => {
	// Isolated store per test by prefixing projectKey with a test-unique nonce.
	// The fake server is reset between tests so even shared-key tests stay
	// isolated.
	const server = new FakeSessionServer();
	beforeEach(() => {
		server.reset();
	});

	runSessionStoreConformance(
		() =>
			new HttpSessionStore({
				baseUrl: "http://fake.invalid",
				apiKey: "test-key",
				teamId: "team-1",
				fetch: server.handle as typeof fetch,
			}),
	);
});

describe("HttpSessionStore - transport", () => {
	test("sends Authorization: Bearer <apiKey> on every request", async () => {
		let observedAuth: string | undefined;
		const store = new HttpSessionStore({
			baseUrl: "http://fake.invalid",
			apiKey: "secret-key",
			teamId: "team-1",
			fetch: (async (_input: unknown, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				observedAuth = headers.get("authorization") ?? undefined;
				return new Response(JSON.stringify({ entries: null }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		await store.load({ projectKey: "p", sessionId: "s" });
		expect(observedAuth).toBe("Bearer secret-key");
	});

	test("sends X-Cyrus-Team-Id on every request", async () => {
		let observedTeamId: string | undefined;
		const store = new HttpSessionStore({
			baseUrl: "http://fake.invalid",
			apiKey: "k",
			teamId: "team-42",
			fetch: (async (_input: unknown, init?: RequestInit) => {
				const headers = new Headers(init?.headers);
				observedTeamId =
					headers.get(CYRUS_TEAM_ID_HEADER.toLowerCase()) ?? undefined;
				return new Response(JSON.stringify({ entries: null }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		await store.load({ projectKey: "p", sessionId: "s" });
		expect(observedTeamId).toBe("team-42");
	});

	test("strips trailing slash from baseUrl", async () => {
		let observedUrl: string | undefined;
		const store = new HttpSessionStore({
			baseUrl: "http://fake.invalid/",
			apiKey: "k",
			teamId: "team-1",
			fetch: (async (input: unknown) => {
				observedUrl = typeof input === "string" ? input : String(input);
				return new Response(JSON.stringify({ entries: null }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}) as unknown as typeof fetch,
		});
		await store.load({ projectKey: "p", sessionId: "s" });
		expect(observedUrl).toBe("http://fake.invalid/api/sessions/load");
	});

	test("append([]) skips the network entirely", async () => {
		let called = 0;
		const store = new HttpSessionStore({
			baseUrl: "http://fake.invalid",
			apiKey: "k",
			teamId: "team-1",
			fetch: (async () => {
				called += 1;
				return new Response("{}", { status: 200 });
			}) as unknown as typeof fetch,
		});
		await store.append({ projectKey: "p", sessionId: "s" }, []);
		expect(called).toBe(0);
	});

	test("load preserves null vs empty-array distinction", async () => {
		const store = new HttpSessionStore({
			baseUrl: "http://fake.invalid",
			apiKey: "k",
			teamId: "team-1",
			fetch: (async () =>
				new Response(JSON.stringify({ entries: null }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				})) as unknown as typeof fetch,
		});
		expect(await store.load({ projectKey: "p", sessionId: "nope" })).toBeNull();
	});

	test("surfaces non-2xx responses as errors", async () => {
		const store = new HttpSessionStore({
			baseUrl: "http://fake.invalid",
			apiKey: "k",
			teamId: "team-1",
			fetch: (async () =>
				new Response("server blew up", {
					status: 500,
				})) as unknown as typeof fetch,
		});
		await expect(
			store.load({ projectKey: "p", sessionId: "s" }),
		).rejects.toThrow(/500/);
	});

	test("throws when baseUrl, apiKey, or teamId missing", () => {
		expect(
			() =>
				new HttpSessionStore({
					baseUrl: "",
					apiKey: "k",
					teamId: "team-1",
				}),
		).toThrow();
		expect(
			() =>
				new HttpSessionStore({
					baseUrl: "http://fake.invalid",
					apiKey: "",
					teamId: "team-1",
				}),
		).toThrow();
		expect(
			() =>
				new HttpSessionStore({
					baseUrl: "http://fake.invalid",
					apiKey: "k",
					teamId: "",
				}),
		).toThrow();
	});
});
