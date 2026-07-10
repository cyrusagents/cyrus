import { createLogger, type ILogger } from "cyrus-core";

/**
 * A warm Claude session sitting idle between turns, as seen by the
 * {@link WarmSessionRegistry}. Implemented by {@link ClaudeRunner}; kept as a
 * narrow interface so the registry has no dependency on the runner internals
 * and stays trivially testable.
 */
export interface WarmIdleSession {
	/** Stable id for LRU keying and logging (a per-runner instance id). */
	readonly registryId: string;
	/** The Claude session id, when known — for logging only. */
	getClaudeSessionId(): string | undefined;
	/**
	 * Whether the session has scheduled wakeups / in-flight background tasks.
	 * Such a session is never evicted — it will wake itself later and dropping
	 * it would lose that work. In practice a session with pending work never
	 * arms its idle timer (it is held open with no timer), so it never registers
	 * as idle; this is the belt-and-suspenders guard.
	 */
	hasPendingWork(): boolean;
	/**
	 * Gracefully shut the idle session down — the same path the idle timer takes
	 * on expiry (completes the streaming prompt, the subprocess exits, the next
	 * comment resumes normally). Must be safe to call once.
	 */
	evictWarmSession(): void;
}

/**
 * Bounds the number of concurrently-warm *idle* Claude sessions.
 *
 * The idle keep-alive window (see `ClaudeRunner.armIdleKeepAliveTimer`) keeps a
 * finished session's subprocess alive so a follow-up comment appends to the
 * live conversation instead of paying to re-write the whole transcript to the
 * prompt cache. On its own the window is the only bound on accumulation: it
 * caps held subprocesses to sessions active in the last ~50 minutes. On a busy
 * deployment that can still be a lot of subprocesses at once.
 *
 * This registry adds an LRU cap on top. Runners register themselves as idle
 * when their turn ends warm ({@link markIdle}) and de-register when they become
 * busy again or shut down ({@link remove}). When the number of idle sessions
 * exceeds the configured maximum, the least-recently-used *eligible* session is
 * evicted through its graceful shutdown path. Sessions with pending work are
 * never evicted.
 *
 * A maximum of `0` (or negative) means unbounded — the window alone governs
 * accumulation, matching the pre-cap behavior.
 */
export class WarmSessionRegistry {
	/**
	 * Idle sessions in LRU order: the Map's insertion order is the recency
	 * order, oldest first. `markIdle` re-inserts to move a session to the most
	 * recent end, so eviction always takes from the front.
	 */
	private readonly idle = new Map<string, WarmIdleSession>();
	private maxIdleSessions: number;
	private readonly logger: ILogger;

	constructor(maxIdleSessions = 0, logger?: ILogger) {
		this.maxIdleSessions = maxIdleSessions;
		this.logger = logger ?? createLogger({ component: "WarmSessionRegistry" });
	}

	/**
	 * Update the cap at runtime (config hot-reload). Lowering it evicts the
	 * now-excess least-recently-used idle sessions immediately.
	 */
	setMaxIdleSessions(max: number): void {
		this.maxIdleSessions = max;
		this.enforceLimit();
	}

	/** Current cap; `0` means unbounded. */
	getMaxIdleSessions(): number {
		return this.maxIdleSessions;
	}

	/** Number of sessions currently tracked as idle-warm. */
	get idleCount(): number {
		return this.idle.size;
	}

	/**
	 * Mark a session idle-warm (its turn ended and it is holding the subprocess
	 * open for a follow-up). Refreshes the session's LRU recency, then evicts
	 * the oldest eligible sessions if the cap is now exceeded.
	 */
	markIdle(session: WarmIdleSession): void {
		// Re-insert so this session becomes the most-recently-used entry.
		this.idle.delete(session.registryId);
		this.idle.set(session.registryId, session);
		this.enforceLimit();
	}

	/**
	 * Drop a session from idle tracking — it became busy again (a comment was
	 * appended) or it shut down. Idempotent: safe to call for a session that was
	 * never idle or was already evicted.
	 */
	remove(registryId: string): void {
		this.idle.delete(registryId);
	}

	/**
	 * Evict least-recently-used eligible sessions until the idle count is within
	 * the cap. Sessions with pending work are skipped (never evicted); if every
	 * remaining idle session has pending work, we stop even while over the cap.
	 */
	private enforceLimit(): void {
		if (this.maxIdleSessions <= 0) return;

		while (this.idle.size > this.maxIdleSessions) {
			const victim = this.findOldestEligible();
			if (!victim) {
				// Everything left is pending-work and exempt from eviction.
				break;
			}
			// Remove before evicting so the runner's own shutdown-time remove()
			// is a no-op and cannot re-enter this loop.
			this.idle.delete(victim.registryId);
			this.logger.event("warm_idle_session_evicted", {
				registryId: victim.registryId,
				claudeSessionId: victim.getClaudeSessionId(),
				idleCount: this.idle.size,
				maxIdleSessions: this.maxIdleSessions,
			});
			victim.evictWarmSession();
		}
	}

	/** The oldest (front-of-Map) idle session without pending work, if any. */
	private findOldestEligible(): WarmIdleSession | undefined {
		for (const session of this.idle.values()) {
			if (!session.hasPendingWork()) return session;
		}
		return undefined;
	}
}
