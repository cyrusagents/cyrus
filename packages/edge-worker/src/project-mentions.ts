/**
 * Pure helpers for detecting @-mentions in Linear Project Update bodies
 * (Workstream A1).
 *
 * Project-level webhooks are workspace-wide — every Cyrus installation
 * subscribed to them receives every `ProjectUpdate` event — so each instance
 * must decide for itself whether it is the agent being addressed. These
 * functions are factored out of EdgeWorker so the routing gate can be unit
 * tested without standing up a full EdgeWorker.
 */

/**
 * Default agent-name prefix stripped before short-form matching. Tincture's
 * Linear viewer names are `tincture-bob`, `tincture-mara`, etc. — humans type
 * `@bob` / `@mara` by hand. Configurable via `CYRUS_AGENT_NAME_PREFIX`.
 */
const DEFAULT_AGENT_NAME_PREFIX = "tincture-";

/**
 * This agent's own Linear identity, used to match @-mentions against.
 * Either field may be absent when identity resolution hasn't completed.
 *
 * `shortName` is the optional short-form (`mara`) that complements the full
 * Linear display name (`tincture-mara`). When set explicitly via config, it
 * wins over the prefix-strip heuristic.
 */
export interface AgentLinearIdentity {
	id?: string;
	name?: string;
	shortName?: string;
}

/**
 * Resolve the configured agent-name prefix. Reads `CYRUS_AGENT_NAME_PREFIX`
 * each call so tests can mutate it. Empty string disables the heuristic.
 */
function getAgentNamePrefix(): string {
	const env = process.env.CYRUS_AGENT_NAME_PREFIX;
	if (env === undefined) return DEFAULT_AGENT_NAME_PREFIX;
	return env;
}

/**
 * Compute the set of names that should be considered matches against this
 * agent. Always includes the full `name` if present. Adds `shortName` when
 * explicitly set; otherwise derives a short form by stripping the configured
 * prefix from `name` (when it's a real prefix and leaves a non-empty stem).
 *
 * Exported so the strip path in {@link stripLinearSelfMention} and tests can
 * use the same logic without duplicating it.
 */
export function getAgentNameCandidates(
	identity: AgentLinearIdentity,
): string[] {
	const out = new Set<string>();
	const name = identity.name?.trim();
	if (name) out.add(name);

	const explicitShort = identity.shortName?.trim();
	if (explicitShort) {
		out.add(explicitShort);
		return Array.from(out);
	}

	const prefix = getAgentNamePrefix();
	if (name && prefix && name.toLowerCase().startsWith(prefix.toLowerCase())) {
		const stripped = name.slice(prefix.length);
		if (stripped) out.add(stripped);
	}
	return Array.from(out);
}

/**
 * Extract `@name` tokens from a Project Update body.
 *
 * Liberal on encoding — matches a bare `@Name` and the markdown-link form
 * `[@Name](url)` that Linear can emit for mentions. Returned names are
 * lower-cased and de-duplicated. Intended for logging/diagnostics; the actual
 * routing gate is {@link mentionsAgent}.
 */
export function parseMentions(body: string): string[] {
	const names = new Set<string>();
	for (const m of body.matchAll(/\[@?([a-zA-Z0-9 ._-]+?)\]\([^)]*\)/g)) {
		const name = m[1]?.trim().toLowerCase();
		if (name) names.add(name);
	}
	for (const m of body.matchAll(/@([a-zA-Z0-9._-]+)/g)) {
		const name = m[1]?.trim().toLowerCase();
		if (name) names.add(name);
	}
	return Array.from(names);
}

/**
 * True when a Project Update body @-mentions the given agent.
 *
 * Matches any of:
 *  - the agent's Linear display name as `@Name` (word-boundary,
 *    case-insensitive) — e.g. `@tincture-mara`;
 *  - the agent's short form (`@mara`), either from explicit config
 *    (`linearAgentShortName`) or derived by stripping a configurable prefix
 *    (default `tincture-`, overridable via env `CYRUS_AGENT_NAME_PREFIX`);
 *  - the agent's Linear user id appearing anywhere in the body — Linear can
 *    embed the id inside a mention link, so this is a defensive catch-all.
 *
 * Returns false when the agent identity is unknown (neither id nor name), so
 * an instance that failed to resolve its identity simply stays quiet rather
 * than responding to everything.
 */
export function mentionsAgent(
	body: string,
	identity: AgentLinearIdentity,
): boolean {
	if (!body) return false;
	const { id } = identity;
	if (id && body.includes(id)) return true;
	for (const candidate of getAgentNameCandidates(identity)) {
		const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`@${escaped}\\b`, "i").test(body)) return true;
	}
	return false;
}
