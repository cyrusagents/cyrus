/**
 * Per-project rolling-window rate limiter for agent replies on Linear
 * Project Updates (B2). Keeps a small in-memory ledger of reply timestamps
 * keyed by `projectId`; on each check, prunes entries older than the
 * configured window and answers whether the count has hit the cap.
 *
 * Reset on process restart is acceptable — the goal is to break a
 * cross-agent ping-pong loop that's actively unrolling, not to enforce a
 * persistent quota.
 */
export interface ProjectReplyRateLimitConfig {
	/** Maximum replies allowed within `windowMs`. */
	count: number;
	/** Rolling window length in ms. */
	windowMs: number;
}

export class ProjectReplyRateLimiter {
	private readonly timestamps: Map<string, number[]> = new Map();
	private readonly getConfig: () => ProjectReplyRateLimitConfig;
	private readonly now: () => number;

	constructor(
		getConfig: () => ProjectReplyRateLimitConfig,
		now: () => number = () => Date.now(),
	) {
		this.getConfig = getConfig;
		this.now = now;
	}

	/**
	 * True when this projectId has already used up its quota in the current
	 * window. Prunes expired entries as a side-effect.
	 */
	isLimited(projectId: string): boolean {
		const { count, windowMs } = this.getConfig();
		const cutoff = this.now() - windowMs;
		const ts = this.timestamps.get(projectId) ?? [];
		const recent = ts.filter((t) => t >= cutoff);
		if (recent.length !== ts.length) {
			if (recent.length === 0) {
				this.timestamps.delete(projectId);
			} else {
				this.timestamps.set(projectId, recent);
			}
		}
		return recent.length >= count;
	}

	/** Record a reply attempt against this projectId. */
	record(projectId: string): void {
		const ts = this.timestamps.get(projectId) ?? [];
		ts.push(this.now());
		this.timestamps.set(projectId, ts);
	}

	/** Number of recent timestamps for a projectId (test helper). */
	count(projectId: string): number {
		const { windowMs } = this.getConfig();
		const cutoff = this.now() - windowMs;
		return (this.timestamps.get(projectId) ?? []).filter((t) => t >= cutoff)
			.length;
	}
}

/**
 * Resolve the B2 rate-limit config from environment variables, with sane
 * defaults: 3 replies per 5-minute rolling window.
 */
export function getProjectReplyRateLimitFromEnv(): ProjectReplyRateLimitConfig {
	const count = Number.parseInt(
		process.env.CYRUS_PROJECT_REPLY_LIMIT_COUNT ?? "3",
		10,
	);
	const windowMs = Number.parseInt(
		process.env.CYRUS_PROJECT_REPLY_LIMIT_WINDOW_MS ?? "300000",
		10,
	);
	return {
		count: Number.isFinite(count) && count > 0 ? count : 3,
		windowMs: Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 300_000,
	};
}
