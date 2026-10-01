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
/** Strict v1 subset. Reject the entire header on ambiguity; never retain raw text. */
export function readHostedTiming(response: Response): HostedTiming | undefined {
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
	const result: HostedTiming = {};
	for (const part of parts) {
		const match =
			/^\s*(cyrus_[a-z]+);dur=(\d+(?:\.\d{1,3})?)(?:;desc="(failed|capped)")?\s*$/.exec(
				part,
			);
		if (!match || !metrics.has(match[1]!)) return;
		const name = match[1] as keyof HostedTiming;
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
