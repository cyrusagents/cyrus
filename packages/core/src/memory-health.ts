import * as os from "node:os";
import * as v8 from "node:v8";

/**
 * Memory gate configuration — a single intuitive knob.
 *
 * Accepts:
 *   - `false` (or omitted)  → gate disabled, always healthy
 *   - `true`                → gate enabled at the default pressure threshold
 *                             (`DEFAULT_MEMORY_PRESSURE_THRESHOLD`)
 *   - `number` in (0, 1]    → gate enabled at this pressure threshold
 *                             (e.g. `0.85` rejects new sessions when memory
 *                             pressure exceeds 85%)
 *
 * "Pressure" is computed as the worst of three normalized dimensions:
 *   - process RSS as a fraction of total system memory
 *   - V8 heap used as a fraction of the heap size limit
 *   - system memory used (i.e. `1 - freeFraction`)
 *
 * Using a single percentage keeps the knob portable across host sizes
 * (no absolute-MB threshold to retune for different boxes) and captures
 * the three concerns from the legacy config (`maxRssPercent`,
 * `minAvailableMemoryMb`, `maxHeapUsagePercent`) in one number.
 */
export type MemoryGateConfig = boolean | number;

/** Default pressure threshold when `memoryGate: true` is supplied. */
export const DEFAULT_MEMORY_PRESSURE_THRESHOLD = 0.85;

/**
 * Cross-platform memory snapshot captured at check time.
 * All byte values are normalized to megabytes (MB = 1024 * 1024 bytes).
 */
export interface MemoryMetrics {
	/** Resident set size of the Cyrus process, in MB. */
	rssMb: number;
	/** Total system memory reported by os.totalmem(), in MB. */
	totalSystemMemoryMb: number;
	/** Available system memory reported by os.freemem(), in MB. */
	availableSystemMemoryMb: number;
	/** V8 heap bytes currently used, in MB. */
	heapUsedMb: number;
	/** V8 heap size limit (hard cap before heap OOM), in MB. */
	heapLimitMb: number;
	/** RSS as a fraction of total system memory (0..1). */
	rssPercent: number;
	/** Heap used as a fraction of heap size limit (0..1). */
	heapPercent: number;
	/** System memory used as a fraction of total (0..1). */
	systemUsedPercent: number;
	/**
	 * Composite memory pressure: the worst of `rssPercent`, `heapPercent`,
	 * and `systemUsedPercent`. This is what the gate compares against the
	 * configured threshold.
	 */
	pressure: number;
}

export type MemoryCheckResult =
	| { ok: true; metrics: MemoryMetrics }
	| { ok: false; reason: string; metrics: MemoryMetrics };

const BYTES_PER_MB = 1024 * 1024;

function toMb(bytes: number): number {
	return bytes / BYTES_PER_MB;
}

/**
 * Injectable data sources for testability. In production, the default
 * implementations call the cross-platform Node built-ins.
 */
export interface MemorySources {
	rssBytes: () => number;
	totalSystemBytes: () => number;
	availableSystemBytes: () => number;
	heapUsedBytes: () => number;
	heapLimitBytes: () => number;
}

const defaultSources: MemorySources = {
	rssBytes: () => process.memoryUsage().rss,
	totalSystemBytes: () => os.totalmem(),
	availableSystemBytes: () => os.freemem(),
	heapUsedBytes: () => v8.getHeapStatistics().used_heap_size,
	heapLimitBytes: () => v8.getHeapStatistics().heap_size_limit,
};

export function collectMemoryMetrics(
	sources: MemorySources = defaultSources,
): MemoryMetrics {
	const rssBytes = sources.rssBytes();
	const totalBytes = sources.totalSystemBytes();
	const freeBytes = sources.availableSystemBytes();
	const heapUsed = sources.heapUsedBytes();
	const heapLimit = sources.heapLimitBytes();

	const rssPercent = totalBytes > 0 ? rssBytes / totalBytes : 0;
	const heapPercent = heapLimit > 0 ? heapUsed / heapLimit : 0;
	const systemUsedPercent =
		totalBytes > 0 ? Math.max(0, 1 - freeBytes / totalBytes) : 0;
	const pressure = Math.max(rssPercent, heapPercent, systemUsedPercent);

	return {
		rssMb: toMb(rssBytes),
		totalSystemMemoryMb: toMb(totalBytes),
		availableSystemMemoryMb: toMb(freeBytes),
		heapUsedMb: toMb(heapUsed),
		heapLimitMb: toMb(heapLimit),
		rssPercent,
		heapPercent,
		systemUsedPercent,
		pressure,
	};
}

/**
 * Evaluate the memory gate against current process + system metrics.
 *
 * Uses only cross-platform Node built-ins (os.totalmem, os.freemem,
 * process.memoryUsage, v8.getHeapStatistics), so it behaves the same
 * on Linux and macOS.
 */
/**
 * Resolve the configured threshold from the user-supplied gate value.
 * Returns `undefined` when the gate is disabled (false/omitted).
 */
function resolveThreshold(config?: MemoryGateConfig): number | undefined {
	if (config === undefined || config === false) return undefined;
	if (config === true) return DEFAULT_MEMORY_PRESSURE_THRESHOLD;
	return config;
}

export function checkMemoryHealth(
	config?: MemoryGateConfig,
	sources: MemorySources = defaultSources,
): MemoryCheckResult {
	const metrics = collectMemoryMetrics(sources);
	const threshold = resolveThreshold(config);

	if (threshold === undefined || metrics.pressure <= threshold) {
		return { ok: true, metrics };
	}

	// Identify which dimension drove the rejection so operators can see
	// at a glance whether the bottleneck was process growth, heap usage,
	// or external pressure on the host.
	const dominant =
		metrics.pressure === metrics.rssPercent
			? `RSS ${(metrics.rssPercent * 100).toFixed(1)}% (${metrics.rssMb.toFixed(0)}MB of ${metrics.totalSystemMemoryMb.toFixed(0)}MB)`
			: metrics.pressure === metrics.heapPercent
				? `V8 heap ${(metrics.heapPercent * 100).toFixed(1)}% (${metrics.heapUsedMb.toFixed(0)}MB of ${metrics.heapLimitMb.toFixed(0)}MB)`
				: `system memory ${(metrics.systemUsedPercent * 100).toFixed(1)}% used (${metrics.availableSystemMemoryMb.toFixed(0)}MB free of ${metrics.totalSystemMemoryMb.toFixed(0)}MB)`;

	return {
		ok: false,
		reason: `Memory pressure ${(metrics.pressure * 100).toFixed(1)}% exceeds threshold ${(threshold * 100).toFixed(1)}% — dominant: ${dominant}`,
		metrics,
	};
}

/**
 * Format a user-facing rejection message explaining that the host is
 * temporarily out of capacity. Suitable for posting to Linear/GitHub/
 * GitLab/Slack when the memory gate trips.
 *
 * The technical reason (e.g. "Process RSS at 78.3% of system memory") is
 * intentionally omitted from the user-facing text — it remains in
 * `MemoryCheckResult.reason` for operator logs.
 */
export function formatMemoryPressureMessage(): string {
	return "Cyrus is temporarily out of capacity and can't start this session right now. Please retry shortly.";
}
