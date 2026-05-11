import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import type { RepositoryConfig } from "./config-types.js";
import { resolvePath } from "./config-types.js";
import {
	type EnvironmentConfig,
	EnvironmentConfigSchema,
} from "./environment-schema.js";

/**
 * Relative directory (under cyrusHome) where environment configs live.
 */
export const ENVIRONMENTS_DIRNAME = "environments";

/**
 * Error thrown when an environment config cannot be loaded or validated.
 */
export class EnvironmentLoadError extends Error {
	constructor(
		message: string,
		public readonly cause?: unknown,
	) {
		super(message);
		this.name = "EnvironmentLoadError";
	}
}

/**
 * Absolute path to the environments directory.
 */
export function getEnvironmentsDir(cyrusHome: string): string {
	return join(resolvePath(cyrusHome), ENVIRONMENTS_DIRNAME);
}

/**
 * Resolve the on-disk path for a given environment name.
 * Environment names must be safe filename stems (no path separators, no `..`).
 */
export function getEnvironmentPath(
	cyrusHome: string,
	environmentName: string,
): string {
	assertSafeEnvironmentName(environmentName);
	return join(getEnvironmentsDir(cyrusHome), `${environmentName}.json`);
}

/**
 * Validate that an environment name is a simple filename stem.
 * Rejects path separators, `..`, and empty strings.
 */
export function assertSafeEnvironmentName(name: string): void {
	if (!name || name.length === 0) {
		throw new EnvironmentLoadError("Environment name must not be empty");
	}
	if (
		name.includes("/") ||
		name.includes("\\") ||
		name === "." ||
		name === ".." ||
		name.includes("..")
	) {
		throw new EnvironmentLoadError(
			`Invalid environment name: ${JSON.stringify(name)}`,
		);
	}
}

/**
 * Load and validate an environment config by name.
 * Returns `null` if no environment file exists (caller decides whether that's
 * an error); throws `EnvironmentLoadError` for malformed JSON or schema
 * validation failures.
 */
export function loadEnvironment(
	cyrusHome: string,
	environmentName: string,
): EnvironmentConfig | null {
	const path = getEnvironmentPath(cyrusHome, environmentName);
	if (!existsSync(path)) {
		return null;
	}

	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch (err) {
		throw new EnvironmentLoadError(
			`Failed to read environment file: ${path}`,
			err,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new EnvironmentLoadError(
			`Environment file is not valid JSON: ${path}`,
			err,
		);
	}

	const result = EnvironmentConfigSchema.safeParse(parsed);
	if (!result.success) {
		throw new EnvironmentLoadError(
			`Environment config failed validation (${path}): ${result.error.message}`,
			result.error,
		);
	}

	const config = result.data;
	if (!config.name) {
		config.name = environmentName;
	}
	return config;
}

/**
 * Look up a configured repository by its canonical `name`
 * (case-insensitive). Environment configs reference repos by the
 * user-visible repository name rather than the internal `id`, so this
 * is the single match rule used by both resolvers below.
 */
function findRepoByName(
	name: string,
	allRepos: RepositoryConfig[],
): RepositoryConfig | undefined {
	const target = name.toLowerCase();
	return allRepos.find((r) => r.name.toLowerCase() === target);
}

/**
 * Resolve an environment's `gitWorktrees` field to the concrete
 * `RepositoryConfig[]` that should be worktree'd for a session.
 *
 * - When the environment is absent or omits `gitWorktrees`, returns the
 *   caller-supplied fallback (the routed repositories) unchanged.
 * - When `gitWorktrees` is an empty array, returns an empty list — the
 *   caller should create a no-worktree workspace.
 * - Entries are matched against `repository.name` (case-insensitive).
 *   Unknown names are silently skipped; order follows `gitWorktrees`.
 */
export function resolveEnvironmentWorktreeRepos(
	env: EnvironmentConfig | null | undefined,
	fallback: RepositoryConfig[],
	allRepos: RepositoryConfig[],
): RepositoryConfig[] {
	if (!env || env.gitWorktrees === undefined) {
		return fallback;
	}
	const resolved: RepositoryConfig[] = [];
	for (const name of env.gitWorktrees) {
		const repo = findRepoByName(name, allRepos);
		if (repo) resolved.push(repo);
	}
	return resolved;
}

/**
 * Resolve an environment's `repositories` field to the concrete
 * `repositoryPath` values that should be added to the session's
 * `allowedDirectories` for read-only access. Entries are matched
 * against `repository.name` (case-insensitive). Unknown names are
 * silently skipped. Duplicates (already present in the worktree list)
 * are the caller's responsibility to deduplicate.
 */
export function resolveEnvironmentReadOnlyRepoPaths(
	env: EnvironmentConfig | null | undefined,
	allRepos: RepositoryConfig[],
): string[] {
	if (!env?.repositories?.length) return [];
	const paths: string[] = [];
	for (const name of env.repositories) {
		const repo = findRepoByName(name, allRepos);
		if (repo) paths.push(repo.repositoryPath);
	}
	return paths;
}

/**
 * List all environment names available on disk (filename stems without `.json`).
 * Returns an empty list if the directory does not exist.
 */
export function listEnvironmentNames(cyrusHome: string): string[] {
	const dir = getEnvironmentsDir(cyrusHome);
	if (!existsSync(dir)) return [];
	try {
		return readdirSync(dir)
			.filter((f) => f.endsWith(".json"))
			.map((f) => basename(f, ".json"))
			.sort();
	} catch {
		return [];
	}
}
