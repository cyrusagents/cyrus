import { describe, expect, it, vi } from "vitest";
import {
	type WarmIdleSession,
	WarmSessionRegistry,
} from "../src/WarmSessionRegistry";

/**
 * The idle keep-alive window keeps a finished Claude session's subprocess alive
 * so a follow-up comment appends to the live conversation instead of re-writing
 * the whole transcript to the prompt cache. On its own the window is the only
 * bound on accumulation. This registry adds an LRU cap on top: when the number
 * of idle sessions exceeds the configured maximum, the least-recently-used
 * eligible session is evicted through its graceful shutdown path. Sessions with
 * pending scheduled work are never evicted.
 */

const silentLogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	event: () => {},
} as any;

interface FakeSession extends WarmIdleSession {
	evicted: boolean;
}

function makeSession(
	id: string,
	opts: { pendingWork?: boolean } = {},
): FakeSession {
	const session: FakeSession = {
		registryId: id,
		evicted: false,
		getClaudeSessionId: () => `claude-${id}`,
		hasPendingWork: () => opts.pendingWork ?? false,
		evictWarmSession: vi.fn(() => {
			session.evicted = true;
		}),
	};
	return session;
}

describe("WarmSessionRegistry", () => {
	it("does not evict anything when the cap is 0 (unbounded)", () => {
		const registry = new WarmSessionRegistry(0, silentLogger);
		const sessions = [makeSession("a"), makeSession("b"), makeSession("c")];
		for (const s of sessions) registry.markIdle(s);

		expect(registry.idleCount).toBe(3);
		expect(sessions.every((s) => !s.evicted)).toBe(true);
	});

	it("evicts the least-recently-used session once the cap is exceeded", () => {
		const registry = new WarmSessionRegistry(2, silentLogger);
		const a = makeSession("a");
		const b = makeSession("b");
		const c = makeSession("c");

		registry.markIdle(a);
		registry.markIdle(b);
		// Third idle session trips the cap; the oldest (a) is evicted.
		registry.markIdle(c);

		expect(a.evicted).toBe(true);
		expect(b.evicted).toBe(false);
		expect(c.evicted).toBe(false);
		expect(registry.idleCount).toBe(2);
	});

	it("treats markIdle as a recency touch so the true LRU is evicted", () => {
		const registry = new WarmSessionRegistry(2, silentLogger);
		const a = makeSession("a");
		const b = makeSession("b");
		const c = makeSession("c");

		registry.markIdle(a);
		registry.markIdle(b);
		// `a` is used again — it is now the most recent, so `b` is the LRU.
		registry.markIdle(a);
		registry.markIdle(c);

		expect(b.evicted).toBe(true);
		expect(a.evicted).toBe(false);
		expect(c.evicted).toBe(false);
	});

	it("never evicts a session with pending work, skipping to the next eligible one", () => {
		const registry = new WarmSessionRegistry(2, silentLogger);
		const a = makeSession("a", { pendingWork: true });
		const b = makeSession("b");
		const c = makeSession("c");

		registry.markIdle(a);
		registry.markIdle(b);
		// Over the cap: `a` is oldest but exempt, so `b` (next oldest) is evicted.
		registry.markIdle(c);

		expect(a.evicted).toBe(false);
		expect(b.evicted).toBe(true);
		expect(c.evicted).toBe(false);
	});

	it("stops evicting when every remaining idle session is pending-work, even over the cap", () => {
		const registry = new WarmSessionRegistry(1, silentLogger);
		const a = makeSession("a", { pendingWork: true });
		const b = makeSession("b", { pendingWork: true });

		registry.markIdle(a);
		registry.markIdle(b);

		// Both exempt: the registry stays over its cap rather than dropping work.
		expect(a.evicted).toBe(false);
		expect(b.evicted).toBe(false);
		expect(registry.idleCount).toBe(2);
	});

	it("remove() drops a session so it no longer counts toward the cap", () => {
		const registry = new WarmSessionRegistry(2, silentLogger);
		const a = makeSession("a");
		const b = makeSession("b");
		const c = makeSession("c");

		registry.markIdle(a);
		registry.markIdle(b);
		// `a` becomes busy again and de-registers before `c` arrives.
		registry.remove("a");
		registry.markIdle(c);

		// Only b and c remain; nothing was evicted.
		expect(registry.idleCount).toBe(2);
		expect(a.evicted).toBe(false);
		expect(b.evicted).toBe(false);
		expect(c.evicted).toBe(false);
	});

	it("remove() is idempotent and safe for an unknown id", () => {
		const registry = new WarmSessionRegistry(2, silentLogger);
		expect(() => registry.remove("never-seen")).not.toThrow();
		const a = makeSession("a");
		registry.markIdle(a);
		registry.remove("a");
		registry.remove("a");
		expect(registry.idleCount).toBe(0);
	});

	it("setMaxIdleSessions lowers the cap and evicts the now-excess LRU sessions", () => {
		const registry = new WarmSessionRegistry(0, silentLogger);
		const a = makeSession("a");
		const b = makeSession("b");
		const c = makeSession("c");
		registry.markIdle(a);
		registry.markIdle(b);
		registry.markIdle(c);
		expect(registry.idleCount).toBe(3);

		// Tighten the cap at runtime (config hot-reload): the two oldest go.
		registry.setMaxIdleSessions(1);

		expect(a.evicted).toBe(true);
		expect(b.evicted).toBe(true);
		expect(c.evicted).toBe(false);
		expect(registry.idleCount).toBe(1);
		expect(registry.getMaxIdleSessions()).toBe(1);
	});

	it("re-registering the same id does not double-count it", () => {
		const registry = new WarmSessionRegistry(2, silentLogger);
		const a = makeSession("a");
		registry.markIdle(a);
		registry.markIdle(a);
		expect(registry.idleCount).toBe(1);
	});
});
