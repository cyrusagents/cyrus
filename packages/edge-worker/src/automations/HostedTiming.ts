/** Optional diagnostic metadata, never authority or an input to model execution. */
const metrics = new Set([
	"cyrus_auth",
	"cyrus_body",
	"cyrus_event",
	"cyrus_admit",
	"cyrus_commit",
	"cyrus_callback",
	"cyrus_interrupt",
	"cyrus_total",
]);
export type HostedTiming = Partial<
	Record<
		| "cyrus_auth"
		| "cyrus_body"
		| "cyrus_event"
		| "cyrus_admit"
		| "cyrus_commit"
		| "cyrus_callback"
		| "cyrus_interrupt"
		| "cyrus_total",
		{ durationMs: number; flag?: "failed" | "capped" }
	>
>;
export interface SupervisorTiming {
	headers: { "X-Cyrus-Latency-Diagnostics": "1" };
	read(response: Response): void;
}
const mcpMetrics = new Set([
	"cyrus_mcp_preflight",
	"cyrus_mcp_authorize",
	"cyrus_mcp_sql",
	"cyrus_mcp_connection",
	"cyrus_mcp_selection",
	"cyrus_mcp_source_validation",
	"cyrus_mcp_session",
	"cyrus_total",
] as const);
export type McpHostedTiming = Partial<
	Record<
		| "cyrus_mcp_preflight"
		| "cyrus_mcp_authorize"
		| "cyrus_mcp_sql"
		| "cyrus_mcp_connection"
		| "cyrus_mcp_selection"
		| "cyrus_mcp_source_validation"
		| "cyrus_mcp_session"
		| "cyrus_total",
		{ durationMs: number; flag?: "failed" | "capped" }
	>
>;
export function readMcpHostedTiming(
	response: Response,
): McpHostedTiming | undefined {
	if (response.status === 403) return;
	return readTiming(response, mcpMetrics);
}
export function readHostedTiming(response: Response): HostedTiming | undefined {
	return readTiming(response, metrics);
}
/** Strict v1 subset. Reject the entire header on ambiguity; never retain raw text. */
function readTiming(
	response: Response,
	allowed: ReadonlySet<string>,
):
	| Record<string, { durationMs: number; flag?: "failed" | "capped" }>
	| undefined {
	if (
		response.status === 401 ||
		response.headers.get("x-cyrus-hosted-timing") !== "1"
	)
		return;
	const raw = response.headers.get("server-timing");
	if (!raw || raw.length > 1024 || Buffer.byteLength(raw, "utf8") > 1024)
		return;
	const parts = raw.split(",");
	if (parts.length > 8) return;
	const result: Record<
		string,
		{ durationMs: number; flag?: "failed" | "capped" }
	> = {};
	for (const part of parts) {
		const match =
			/^\s*(cyrus_[a-z_]+);dur=(\d+(?:\.\d{1,3})?)(?:;desc="(failed|capped)")?\s*$/.exec(
				part,
			);
		if (!match || !allowed.has(match[1]!)) return;
		const name = match[1]!;
		const durationMs = Number(match[2]);
		const flag = match[3] as "failed" | "capped" | undefined;
		if (
			Object.hasOwn(result, name) ||
			!Number.isFinite(durationMs) ||
			durationMs > 600000 ||
			(flag === "capped" && durationMs !== 600000)
		)
			return;
		result[name] = { durationMs, ...(flag && { flag }) };
	}
	return result;
}
