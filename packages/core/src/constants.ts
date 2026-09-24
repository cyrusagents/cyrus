import { join } from "node:path";

/**
 * Shared constants used across Miko packages
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
 * Resolves the repos directory, preferring MIKO_REPOS_DIR env var over the default.
 */
export function getDefaultReposDir(mikoHome: string): string {
	return (
		process.env.MIKO_REPOS_DIR?.trim() || join(mikoHome, DEFAULT_REPOS_DIR)
	);
}

/**
 * Resolves the worktrees directory, preferring MIKO_WORKTREES_DIR env var over the default.
 */
export function getDefaultWorktreesDir(mikoHome: string): string {
	return (
		process.env.MIKO_WORKTREES_DIR?.trim() ||
		join(mikoHome, DEFAULT_WORKTREES_DIR)
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
