import { delimiter, isAbsolute } from "node:path";
import { resolvePath } from "cyrus-core";

/** Env var listing extra Codex-writable paths (comma- or path-delimiter-separated). */
export const SANDBOX_WRITABLE_PATHS_ENV = "CYRUS_SANDBOX_WRITABLE_PATHS";

/**
 * Resolve the operator-whitelisted extra writable paths from
 * `config.sandbox.writablePaths` plus the `CYRUS_SANDBOX_WRITABLE_PATHS` env
 * var. `~/` is expanded; entries that are not absolute after expansion are
 * dropped (a relative path would otherwise resolve against the Cyrus process
 * cwd, not the session worktree).
 */
export function resolveSandboxWritablePaths(
	configPaths: readonly string[] | undefined,
	envValue: string | undefined = process.env[SANDBOX_WRITABLE_PATHS_ENV],
): string[] {
	const envPaths = (envValue ?? "").split(new RegExp(`[,${delimiter}]`));
	const resolved = new Set<string>();
	for (const raw of [...(configPaths ?? []), ...envPaths]) {
		const entry = raw.trim();
		if (!entry) continue;
		if (!entry.startsWith("~/") && !isAbsolute(entry)) continue;
		resolved.add(resolvePath(entry));
	}
	return [...resolved];
}
