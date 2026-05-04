import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	hasGlobalConfigChanges,
	mergeEdgeConfig,
} from "../src/config-merge.js";

function baseConfig(): EdgeWorkerConfig {
	return {
		repositories: [],
		cyrusHome: "/tmp/cyrus",
		version: "1.0.0",
		handlers: { onError: () => {} },
	} as unknown as EdgeWorkerConfig;
}

const deepEqual = (a: unknown, b: unknown) =>
	JSON.stringify(a) === JSON.stringify(b);

describe("mergeEdgeConfig — auto-propagation of disk fields", () => {
	it("propagates memoryGate from parsed config (regression: CYPACK-1165 whitelist drop)", () => {
		const merged = mergeEdgeConfig(baseConfig(), {
			repositories: [],
			memoryGate: 0.8,
		});
		expect(merged.memoryGate).toBe(0.8);
	});

	it("propagates maxConcurrentRunners from parsed config (regression: CYPACK-1165)", () => {
		const merged = mergeEdgeConfig(baseConfig(), {
			repositories: [],
			maxConcurrentRunners: 3,
		});
		expect(merged.maxConcurrentRunners).toBe(3);
	});

	it("propagates an unknown future field via spread (open/closed)", () => {
		// Demonstrates the structural property: a hypothetical new
		// EdgeConfig field flows through without code changes here.
		const merged = mergeEdgeConfig(baseConfig(), {
			repositories: [],
			someFutureGate: { enabled: true },
		});
		expect(
			(merged as unknown as Record<string, unknown>).someFutureGate,
		).toEqual({ enabled: true });
	});

	it("preserves runtime fields (handlers, version, cyrusHome) not present on disk", () => {
		const current = baseConfig();
		const merged = mergeEdgeConfig(current, { repositories: [] });
		expect(merged.handlers).toBe(current.handlers);
		expect(merged.version).toBe("1.0.0");
		expect(merged.cyrusHome).toBe("/tmp/cyrus");
	});

	it("disk repositories override in-memory repositories", () => {
		const current = {
			...baseConfig(),
			repositories: [{ id: "old" }],
		} as unknown as EdgeWorkerConfig;
		const merged = mergeEdgeConfig(current, {
			repositories: [{ id: "new" }],
		});
		expect(merged.repositories).toEqual([{ id: "new" }]);
	});

	it("treats missing repositories as an empty array", () => {
		const merged = mergeEdgeConfig(baseConfig(), {});
		expect(merged.repositories).toEqual([]);
	});

	it("resolves claudeDefaultModel via legacy alias chain", () => {
		const current = {
			...baseConfig(),
			claudeDefaultModel: "memorized",
		} as unknown as EdgeWorkerConfig;
		// Disk has only the legacy `defaultModel` key
		const merged = mergeEdgeConfig(current, {
			repositories: [],
			defaultModel: "legacy-disk",
		});
		expect(merged.claudeDefaultModel).toBe("legacy-disk");
	});

	it("prefers the new claudeDefaultModel key over the legacy defaultModel", () => {
		const merged = mergeEdgeConfig(baseConfig(), {
			repositories: [],
			claudeDefaultModel: "new",
			defaultModel: "old",
		});
		expect(merged.claudeDefaultModel).toBe("new");
	});

	it("falls back to in-memory model when disk has neither key", () => {
		const current = {
			...baseConfig(),
			claudeDefaultModel: "from-memory",
		} as unknown as EdgeWorkerConfig;
		const merged = mergeEdgeConfig(current, { repositories: [] });
		expect(merged.claudeDefaultModel).toBe("from-memory");
	});
});

describe("hasGlobalConfigChanges — structural diff", () => {
	it("detects a change to memoryGate (regression: CYPACK-1165 whitelist gap)", () => {
		const before = baseConfig();
		const after = {
			...before,
			memoryGate: 0.8,
		} as unknown as EdgeWorkerConfig;
		expect(hasGlobalConfigChanges(before, after, deepEqual)).toBe(true);
	});

	it("detects a change to maxConcurrentRunners (regression: CYPACK-1165)", () => {
		const before = baseConfig();
		const after = {
			...before,
			maxConcurrentRunners: 3,
		} as unknown as EdgeWorkerConfig;
		expect(hasGlobalConfigChanges(before, after, deepEqual)).toBe(true);
	});

	it("detects a change to an unknown future field (open/closed)", () => {
		const before = baseConfig();
		const after = {
			...before,
			someFutureGate: { enabled: true },
		} as unknown as EdgeWorkerConfig;
		expect(hasGlobalConfigChanges(before, after, deepEqual)).toBe(true);
	});

	it("ignores changes to runtime-only keys (repositories, handlers, server*)", () => {
		const before = baseConfig();
		const after = {
			...before,
			repositories: [{ id: "new" }],
			handlers: { onError: () => {} },
			serverPort: 4321,
			cyrusHome: "/tmp/different",
			ngrokAuthToken: "different",
		} as unknown as EdgeWorkerConfig;
		expect(hasGlobalConfigChanges(before, after, deepEqual)).toBe(false);
	});

	it("returns false when nothing relevant changed", () => {
		const before = {
			...baseConfig(),
			memoryGate: 0.8,
			maxConcurrentRunners: 3,
		} as unknown as EdgeWorkerConfig;
		const after = {
			...before,
			memoryGate: 0.8,
		} as unknown as EdgeWorkerConfig;
		expect(hasGlobalConfigChanges(before, after, deepEqual)).toBe(false);
	});
});
