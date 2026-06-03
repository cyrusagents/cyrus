/**
 * Policy for proactive Linear OAuth token refresh (CRATE-153).
 *
 * Linear access tokens live ~24h, and Linear REVOKES the previous access
 * token the moment a refresh succeeds. Agent sessions snapshot the token
 * into a static MCP Authorization header at turn start, so a refresh kills
 * the hosted Linear MCP server for every in-flight turn.
 *
 * The policy balances those forces:
 *  - unknown expiry        → refresh (token of unknown age; assume stale)
 *  - < forced TTL left     → refresh even while busy (in-flight snapshots
 *                            are about to die naturally anyway)
 *  - < soft TTL left, idle → refresh while nobody is running, so new turns
 *                            always snapshot a token with hours of runway
 *  - otherwise             → leave the token alone
 */

/** Refresh regardless of running turns when this little validity remains. */
export const LINEAR_TOKEN_FORCED_REFRESH_TTL_MS = 30 * 60 * 1000;

/** Refresh while the worker is idle when this little validity remains. */
export const LINEAR_TOKEN_SOFT_REFRESH_TTL_MS = 4 * 60 * 60 * 1000;

/** Turn-start guard: ensure at least this much runway before snapshotting. */
export const LINEAR_TOKEN_TURN_START_MIN_TTL_MS = 30 * 60 * 1000;

/** How often the proactive refresh scheduler checks token freshness. */
export const LINEAR_TOKEN_REFRESH_CHECK_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Detect the stale-token failure an agent session hits when its snapshotted
 * MCP Authorization header outlives the Linear token: the SDK surfaces it as
 * an error tool_result reading `MCP server "linear" requires re-authorization`.
 *
 * Used to (a) log the failure loudly instead of letting it pass as a quiet
 * tool error, and (b) trigger an immediate token refresh so the NEXT turn
 * starts with a working token (this turn's header is already unfixable).
 */
export function containsLinearReauthorizationError(message: unknown): boolean {
	const msg = message as {
		type?: string;
		message?: { content?: unknown };
	};
	if (!msg || msg.type !== "user") return false;

	const content = msg.message?.content;
	if (!Array.isArray(content)) return false;

	for (const block of content) {
		const b = block as {
			type?: string;
			is_error?: boolean;
			content?: unknown;
		};
		if (b?.type !== "tool_result" || b.is_error !== true) continue;

		let text = "";
		if (typeof b.content === "string") {
			text = b.content;
		} else if (Array.isArray(b.content)) {
			text = b.content
				.map((c) => (c as { text?: string })?.text ?? "")
				.join("\n");
		}

		if (text.includes("requires re-authorization")) return true;
	}

	return false;
}

export function shouldRefreshLinearToken(args: {
	/** Epoch ms when the current access token expires, or null if unknown */
	expiresAt: number | null;
	/** Current time, epoch ms */
	now: number;
	/** Whether any agent turns are currently running */
	busy: boolean;
}): boolean {
	const { expiresAt, now, busy } = args;

	if (expiresAt === null) return true;

	const remaining = expiresAt - now;
	if (remaining < LINEAR_TOKEN_FORCED_REFRESH_TTL_MS) return true;
	if (remaining < LINEAR_TOKEN_SOFT_REFRESH_TTL_MS && !busy) return true;

	return false;
}
