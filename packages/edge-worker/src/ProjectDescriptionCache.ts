import { createLogger, type ILogger } from "cyrus-core";

/**
 * Successful cache read shape. `updatedAtMs` is the row's `updated_at`
 * timestamp parsed to unix-ms, used by callers to apply a freshness TTL
 * (N6). Undefined when the edge function returns no `updated_at`.
 */
export interface CacheGetResult {
	description: string;
	updatedAtMs?: number;
}

/**
 * Connection details for the bridge's project-description cache endpoint.
 */
export interface ProjectDescriptionCacheConfig {
	/**
	 * Full URL of the bridge edge function, e.g.
	 * `https://<ref>.supabase.co/functions/v1/cyrus-project-cache`.
	 */
	url: string;
	/** Shared bearer token authenticating this agent to the edge function. */
	token: string;
}

/**
 * Client for the Notion↔Linear bridge's project-description cache
 * (Workstream A2 — "project description as a long-running system prompt").
 *
 * The cache table (`project_description_cache`) lives in the bridge's
 * Supabase. This client talks to a thin edge function in front of it, so the
 * Supabase service-role key never has to be distributed to Cyrus instances —
 * each instance only holds a shared bearer token.
 *
 * Every method is **best-effort**: if the cache is not configured, or any
 * request fails, the call resolves to a no-op / `undefined`. The agent still
 * runs — it just doesn't get the project's standing context that turn.
 *
 * Configured via env vars (see {@link fromEnv}) rather than `config.json` so
 * the same published package works for installs that don't run the bridge.
 */
export class ProjectDescriptionCache {
	private readonly config: ProjectDescriptionCacheConfig | null;
	private readonly logger: ILogger;

	constructor(config: ProjectDescriptionCacheConfig | null, logger?: ILogger) {
		this.config = config;
		this.logger =
			logger ?? createLogger({ component: "ProjectDescriptionCache" });
	}

	/**
	 * Build from environment variables:
	 * - `CYRUS_PROJECT_CACHE_URL` — bridge edge function URL
	 * - `CYRUS_PROJECT_CACHE_TOKEN` — shared bearer token
	 *
	 * When either is missing, returns an unconfigured (no-op) instance.
	 */
	static fromEnv(logger?: ILogger): ProjectDescriptionCache {
		const url = process.env.CYRUS_PROJECT_CACHE_URL?.trim();
		const token = process.env.CYRUS_PROJECT_CACHE_TOKEN?.trim();
		if (url && token) {
			return new ProjectDescriptionCache({ url, token }, logger);
		}
		return new ProjectDescriptionCache(null, logger);
	}

	/** Whether a cache endpoint is configured (env vars present). */
	get isConfigured(): boolean {
		return this.config !== null;
	}

	/**
	 * Read a project's cached description.
	 * Resolves to `undefined` on cache miss, unconfigured cache, or any error.
	 */
	async get(linearProjectId: string): Promise<CacheGetResult | undefined> {
		if (!this.config) return undefined;
		try {
			// E3: defensive URL construction. String concatenation would produce
			// `?…?…` if `config.url` ever carries an existing query string.
			const url = new URL(this.config.url);
			url.searchParams.set("linear_project_id", linearProjectId);
			const res = await fetch(url.toString(), {
				headers: { Authorization: `Bearer ${this.config.token}` },
			});
			if (res.status === 404) return undefined;
			if (!res.ok) {
				this.logger.warn(
					`Project cache GET ${linearProjectId} → HTTP ${res.status}`,
				);
				return undefined;
			}
			const body = (await res.json()) as {
				description?: string;
				updated_at?: string;
			};
			if (typeof body.description !== "string") return undefined;
			// N6: parse `updated_at` (always present in successful responses
			// from the edge function) so callers can apply a TTL.
			let updatedAtMs: number | undefined;
			if (body.updated_at) {
				const parsed = Date.parse(body.updated_at);
				if (Number.isFinite(parsed)) updatedAtMs = parsed;
			}
			return { description: body.description, updatedAtMs };
		} catch (error) {
			this.logger.warn(
				`Project cache GET ${linearProjectId} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
			return undefined;
		}
	}

	/**
	 * Upsert a project's cached description. Best-effort — failures are logged
	 * and swallowed.
	 */
	async set(linearProjectId: string, description: string): Promise<void> {
		if (!this.config) return;
		try {
			const res = await fetch(this.config.url, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${this.config.token}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					linear_project_id: linearProjectId,
					description,
				}),
			});
			if (!res.ok) {
				this.logger.warn(
					`Project cache POST ${linearProjectId} → HTTP ${res.status}`,
				);
			}
		} catch (error) {
			this.logger.warn(
				`Project cache POST ${linearProjectId} failed: ${
					error instanceof Error ? error.message : String(error)
				}`,
			);
		}
	}
}
