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
 * This agent's own Linear identity, used to match @-mentions against.
 * Either field may be absent when identity resolution hasn't completed.
 */
export interface AgentLinearIdentity {
	id?: string;
	name?: string;
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
 * Matches either:
 *  - the agent's Linear display name as `@Name` (word-boundary,
 *    case-insensitive), or
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
	const { id, name } = identity;
	if (id && body.includes(id)) return true;
	if (name) {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		if (new RegExp(`@${escaped}\\b`, "i").test(body)) return true;
	}
	return false;
}
