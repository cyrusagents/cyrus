import type {
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";
import type { ILogger } from "cyrus-core";

/**
 * HTTP-backed Claude Agent SDK SessionStore.
 *
 * Mirrors session transcripts from an edge-worker / ClaudeRunner to the
 * Cyrus hosted control plane, which persists them in a per-team Supabase
 * table.
 *
 * References (CYPACK-1121):
 *   - SDK session-storage contract & lifecycle:
 *     https://code.claude.com/docs/en/agent-sdk/session-storage
 *   - Reference adapters + behavioral conformance suite:
 *     https://github.com/anthropics/claude-agent-sdk-typescript/tree/main/examples/session-stores
 *
 * Every request carries two pieces of identity, provided by the edge's
 * environment:
 *
 *   - `Authorization: Bearer <CYRUS_API_KEY>` — proves the caller holds the
 *     team's API key.
 *   - `X-Cyrus-Team-Id:  <CYRUS_TEAM_ID>`    — names the team the request
 *     belongs to.
 *
 * The server looks up the team by id (O(1) primary-key lookup) and verifies
 * that the bearer token matches the team's stored key. Unlike the previous
 * hash-reverse-lookup design, no per-request index into `teams` is needed —
 * the edge already knows its own team id.
 *
 * Wire protocol (all POST, JSON body):
 *
 *   POST {baseUrl}/api/sessions/append        { projectKey, sessionId, subpath?, entries }
 *   POST {baseUrl}/api/sessions/load          { projectKey, sessionId, subpath? }          -> { entries: SessionStoreEntry[] | null }
 *   POST {baseUrl}/api/sessions/list-sessions { projectKey }                                -> { sessions: [{ sessionId, mtime }] }
 *   POST {baseUrl}/api/sessions/delete        { projectKey, sessionId, subpath? }
 *   POST {baseUrl}/api/sessions/list-subkeys  { projectKey, sessionId }                     -> { subpaths: string[] }
 *
 * The adapter passes the 13-contract conformance suite from the upstream
 * examples (`examples/session-stores/shared/conformance.ts`) when pointed
 * at a conforming backend. The cyrus-hosted implementation of these routes
 * is the canonical conforming backend.
 */
export interface HttpSessionStoreOptions {
	/** Base URL of the control-plane, e.g. "https://app.atcyrus.com". */
	baseUrl: string;
	/** Team-scoped API key. Sent as `Authorization: Bearer <apiKey>`. */
	apiKey: string;
	/**
	 * Team id this edge belongs to. Sent as `X-Cyrus-Team-Id: <teamId>`.
	 * The server verifies the bearer token actually belongs to this team.
	 */
	teamId: string;
	/**
	 * Optional fetch override — primarily for tests. Defaults to the global
	 * `fetch`. Signature intentionally matches `globalThis.fetch`.
	 */
	fetch?: typeof fetch;
	/** Optional logger; defaults to a silent no-op. */
	logger?: ILogger;
	/** Request timeout in ms. Defaults to 15_000. */
	timeoutMs?: number;
}

type JsonBody = Record<string, unknown>;

/**
 * Header name used to identify the team. Extracted as a module-level
 * constant so tests and any future alternate transport stay in sync.
 */
export const CYRUS_TEAM_ID_HEADER = "X-Cyrus-Team-Id";

export class HttpSessionStore implements SessionStore {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly teamId: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger: ILogger | undefined;
	private readonly timeoutMs: number;

	constructor(opts: HttpSessionStoreOptions) {
		if (!opts.baseUrl) throw new Error("HttpSessionStore: baseUrl required");
		if (!opts.apiKey) throw new Error("HttpSessionStore: apiKey required");
		if (!opts.teamId) throw new Error("HttpSessionStore: teamId required");
		// Strip trailing slash so path concat is predictable.
		this.baseUrl = opts.baseUrl.replace(/\/$/, "");
		this.apiKey = opts.apiKey;
		this.teamId = opts.teamId;
		this.fetchImpl = opts.fetch ?? fetch;
		this.logger = opts.logger;
		this.timeoutMs = opts.timeoutMs ?? 15_000;
	}

	async append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void> {
		if (entries.length === 0) return;
		await this.post("/api/sessions/append", {
			projectKey: key.projectKey,
			sessionId: key.sessionId,
			...(key.subpath !== undefined && { subpath: key.subpath }),
			entries,
		});
	}

	async load(key: SessionKey): Promise<SessionStoreEntry[] | null> {
		const res = await this.post<{ entries: SessionStoreEntry[] | null }>(
			"/api/sessions/load",
			{
				projectKey: key.projectKey,
				sessionId: key.sessionId,
				...(key.subpath !== undefined && { subpath: key.subpath }),
			},
		);
		// Server returns `entries: null` when no transcript exists. Preserve that
		// distinction — returning `[]` would look like an empty-but-present
		// session, which the SDK treats differently from "no session found".
		return res.entries ?? null;
	}

	async listSessions(
		projectKey: string,
	): Promise<Array<{ sessionId: string; mtime: number }>> {
		const res = await this.post<{
			sessions: Array<{ sessionId: string; mtime: number }>;
		}>("/api/sessions/list-sessions", { projectKey });
		return res.sessions ?? [];
	}

	async delete(key: SessionKey): Promise<void> {
		await this.post("/api/sessions/delete", {
			projectKey: key.projectKey,
			sessionId: key.sessionId,
			...(key.subpath !== undefined && { subpath: key.subpath }),
		});
	}

	async listSubkeys(key: {
		projectKey: string;
		sessionId: string;
	}): Promise<string[]> {
		const res = await this.post<{ subpaths: string[] }>(
			"/api/sessions/list-subkeys",
			{
				projectKey: key.projectKey,
				sessionId: key.sessionId,
			},
		);
		return res.subpaths ?? [];
	}

	/**
	 * Builds the headers for every request. Kept as a separate method so the
	 * auth scheme can be extended (extra headers, different schemes) by
	 * subclassing without rewriting the transport.
	 */
	protected buildRequestHeaders(): Record<string, string> {
		return {
			"Content-Type": "application/json",
			Authorization: `Bearer ${this.apiKey}`,
			[CYRUS_TEAM_ID_HEADER]: this.teamId,
		};
	}

	private async post<T = unknown>(path: string, body: JsonBody): Promise<T> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
				method: "POST",
				headers: this.buildRequestHeaders(),
				body: JSON.stringify(body),
				signal: controller.signal,
			});
			if (!response.ok) {
				const text = await response.text().catch(() => "");
				const err = new Error(
					`HttpSessionStore ${path} ${response.status}: ${text.slice(0, 500)}`,
				);
				this.logger?.error?.(err.message);
				throw err;
			}
			// Empty bodies (append / delete) are fine — don't blow up on JSON
			// parse if the server omits the body.
			const text = await response.text();
			if (!text) return {} as T;
			return JSON.parse(text) as T;
		} finally {
			clearTimeout(timeout);
		}
	}
}
