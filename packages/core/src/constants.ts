import { join } from "node:path";

/**
 * Shared constants used across Cyrus packages
 */

/**
 * Default proxy URL for Cyrus hosted services
 */
export const DEFAULT_PROXY_URL = "https://cyrus-proxy.ceedar.workers.dev";

/**
 * Default directory name for git worktrees
 */
export const DEFAULT_WORKTREES_DIR = "worktrees";

/**
 * Default directory name for cloned repositories
 */
export const DEFAULT_REPOS_DIR = "repos";

/**
 * Resolves the repos directory, preferring CYRUS_REPOS_DIR env var over the default.
 */
export function getDefaultReposDir(cyrusHome: string): string {
	return (
		process.env.CYRUS_REPOS_DIR?.trim() || join(cyrusHome, DEFAULT_REPOS_DIR)
	);
}

/**
 * Resolves the worktrees directory, preferring CYRUS_WORKTREES_DIR env var over the default.
 */
export function getDefaultWorktreesDir(cyrusHome: string): string {
	return (
		process.env.CYRUS_WORKTREES_DIR?.trim() ||
		join(cyrusHome, DEFAULT_WORKTREES_DIR)
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

/**
 * Linear posts this auto-generated root comment when an agent session is
 * created via delegation. The full root body is
 * `"This thread is for an agent session with <agent-name>"`, where the agent
 * name varies per workspace (e.g. "cyrus", "cyrustester"), so we match on the
 * stable prefix only.
 *
 * Used to distinguish delegation-triggered sessions (where the first comment
 * is this marker and the initial prompt should come from the issue
 * description) from @ mention-triggered sessions (where the comment body *is*
 * the prompt).
 */
export const AGENT_SESSION_THREAD_MARKER_PREFIX =
	"This thread is for an agent session";

/**
 * Linear posts this auto-generated root comment when a comment thread is
 * mirrored to an email chain. Match the exact body to detect replies inside
 * these synced threads so we can inject them into the active agent session.
 */
export const EMAIL_SYNCED_THREAD_MARKER =
	"This comment thread is synced to a corresponding email chain. All replies are displayed in both locations.";
