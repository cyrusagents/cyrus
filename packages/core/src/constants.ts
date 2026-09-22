import { join } from "node:path";

/**
 * Shared constants used across Atmiko packages
 */

/**
 * Default directory name for git worktrees
 */
export const DEFAULT_WORKTREES_DIR = "worktrees";

/**
 * Default directory name for cloned repositories
 */
export const DEFAULT_REPOS_DIR = "repos";

/**
 * Resolves the repos directory, preferring ATMIKO_REPOS_DIR env var over the default.
 */
export function getDefaultReposDir(atmikoHome: string): string {
	return (
		process.env.ATMIKO_REPOS_DIR?.trim() || join(atmikoHome, DEFAULT_REPOS_DIR)
	);
}

/**
 * Resolves the worktrees directory, preferring ATMIKO_WORKTREES_DIR env var over the default.
 */
export function getDefaultWorktreesDir(atmikoHome: string): string {
	return (
		process.env.ATMIKO_WORKTREES_DIR?.trim() ||
		join(atmikoHome, DEFAULT_WORKTREES_DIR)
	);
}

/**
 * Default base branch for new repositories
 */
export const DEFAULT_BASE_BRANCH = "main";

/**
 * Default config filename
 */
export const DEFAULT_CONFIG_FILENAME = "config.json";
