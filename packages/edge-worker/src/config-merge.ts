import type { EdgeWorkerConfig } from "cyrus-core";

/**
 * Pure merge of an on-disk EdgeConfig (`parsed`) onto an in-memory
 * EdgeWorkerConfig (`current`).
 *
 * Layering, in order:
 *  1. `current` — preserves runtime/handler fields that aren't sourced from
 *     disk (handlers, version, cyrusHome, server*, ngrokAuthToken, …).
 *  2. `parsed` — overlays every field present on disk. The spread
 *     auto-propagates new EdgeConfig fields, avoiding the whitelist-rot
 *     bug where a newly-added config field (e.g. memoryGate,
 *     maxConcurrentRunners) is silently dropped on hot-reload.
 *  3. Explicit fallbacks for legacy keys whose resolution differs from
 *     "newer file wins" (model name aliases, etc.).
 *
 * Extracted as a pure function so it can be unit-tested without touching
 * the file system or the chokidar watcher.
 */
export function mergeEdgeConfig(
	current: EdgeWorkerConfig,
	parsed: Record<string, unknown>,
): EdgeWorkerConfig {
	const parsedRepos = parsed.repositories;
	return {
		...current,
		...(parsed as Partial<EdgeWorkerConfig>),
		repositories: Array.isArray(parsedRepos) ? parsedRepos : [],

		// Legacy alias resolution: prefer the new key, fall back to the
		// legacy key, then to whatever was in memory before.
		claudeDefaultModel:
			(parsed.claudeDefaultModel as string | undefined) ||
			(parsed.defaultModel as string | undefined) ||
			current.claudeDefaultModel ||
			current.defaultModel,
		claudeDefaultFallbackModel:
			(parsed.claudeDefaultFallbackModel as string | undefined) ||
			(parsed.defaultFallbackModel as string | undefined) ||
			current.claudeDefaultFallbackModel ||
			current.defaultFallbackModel,
	};
}

/**
 * Keys that are sourced outside the on-disk config file and must be
 * excluded from change-detection diffs.
 */
const RUNTIME_ONLY_KEYS: ReadonlySet<string> = new Set([
	// Repository diff is owned by detectRepositoryChanges()
	"repositories",
	// Runtime / non-serializable fields not sourced from disk
	"handlers",
	"version",
	"cyrusHome",
	"webhookBaseUrl",
	"webhookPort",
	"webhookHost",
	"serverPort",
	"serverHost",
	"ngrokAuthToken",
	"platform",
	"agentHandle",
	"agentUserId",
]);

/**
 * Returns true when any non-repository, disk-sourced field differs
 * between two EdgeWorker configs. The key set is computed from the
 * live objects, so any new EdgeConfig field added to the schema is
 * automatically included in change detection.
 */
export function hasGlobalConfigChanges(
	current: EdgeWorkerConfig,
	next: EdgeWorkerConfig,
	deepEqual: (a: unknown, b: unknown) => boolean,
): boolean {
	const a = current as unknown as Record<string, unknown>;
	const b = next as unknown as Record<string, unknown>;
	const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
	for (const key of keys) {
		if (RUNTIME_ONLY_KEYS.has(key)) continue;
		if (!deepEqual(a[key], b[key])) return true;
	}
	return false;
}
