export * from "./daytona.js";
export * from "./types.js";

import { daytonaStreamAdapter } from "./daytona.js";
import type { NativeStreamAdapter } from "./types.js";

/**
 * Built-in adapters tried in order when a `ComputeSdkRunnerSandbox` is
 * constructed. Currently only Daytona is wired; new adapters get appended
 * here once we validate them against the real provider SDK.
 */
export const BUILT_IN_NATIVE_STREAM_ADAPTERS: readonly NativeStreamAdapter[] = [
	daytonaStreamAdapter,
];

/**
 * Pick the first adapter whose `detect()` returns true for `instance`.
 */
export function resolveNativeStreamAdapter(
	instance: unknown,
	extraAdapters: readonly NativeStreamAdapter[] = [],
): NativeStreamAdapter | undefined {
	if (instance === undefined || instance === null) return undefined;
	for (const adapter of [
		...BUILT_IN_NATIVE_STREAM_ADAPTERS,
		...extraAdapters,
	]) {
		try {
			if (adapter.detect(instance)) return adapter;
		} catch {
			// Bad adapters must not break detection for good ones.
		}
	}
	return undefined;
}
