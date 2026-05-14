import { exec } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import { getDefaultReposDir } from "cyrus-core";
import type {
	ApiResponse,
	DeleteRepositoryPayload,
	RepositoryPayload,
} from "../types.js";

const execAsync = promisify(exec);

/**
 * Check if a directory contains a git repository
 */
function isGitRepository(path: string): boolean {
	try {
		return existsSync(join(path, ".git"));
	} catch {
		return false;
	}
}

/**
 * Extract repository name from URL
 */
function getRepoNameFromUrl(repoUrl: string): string {
	// Handle URLs like: https://github.com/user/repo.git or git@github.com:user/repo.git
	const match = repoUrl.match(/\/([^/]+?)(\.git)?$/);
	if (match?.[1]) {
		return match[1];
	}
	// Fallback: use last part of URL
	return basename(repoUrl, ".git");
}

/**
 * Extract org/repo format from various Git URL formats.
 * The gh CLI expects "org/repo" format, not full URLs.
 *
 * Supported formats:
 * - https://github.com/org/repo -> org/repo
 * - https://github.com/org/repo.git -> org/repo
 * - git@github.com:org/repo.git -> org/repo
 */
function getOrgRepoFromUrl(repoUrl: string): string {
	// Handle SSH URLs: git@github.com:org/repo.git
	const sshMatch = repoUrl.match(/git@github\.com:([^/]+)\/([^/]+?)(\.git)?$/);
	if (sshMatch?.[1] && sshMatch?.[2]) {
		return `${sshMatch[1]}/${sshMatch[2]}`;
	}

	// Handle HTTPS URLs: https://github.com/org/repo or https://github.com/org/repo.git
	const httpsMatch = repoUrl.match(/github\.com\/([^/]+)\/([^/]+?)(\.git)?$/);
	if (httpsMatch?.[1] && httpsMatch?.[2]) {
		return `${httpsMatch[1]}/${httpsMatch[2]}`;
	}

	// Fallback: return original URL (may still work for some cases)
	return repoUrl;
}

/**
 * Handle repository cloning or verification
 * - Clones repositories to ~/.cyrus/repos/<repo-name> using GitHub CLI (gh)
 * - If repository exists, verify it's a git repo and do nothing
 * - If repository doesn't exist, clone it to ~/.cyrus/repos/<repo-name>
 */
export async function handleRepository(
	payload: RepositoryPayload,
	cyrusHome: string,
): Promise<ApiResponse> {
	try {
		// Validate payload
		if (!payload.repository_url || typeof payload.repository_url !== "string") {
			return {
				success: false,
				error: "Repository URL is required",
				details:
					"Please provide a valid Git repository URL (e.g., https://github.com/user/repo.git)",
			};
		}

		// Use repository name from payload or extract from URL
		const repoName =
			payload.repository_name || getRepoNameFromUrl(payload.repository_url);

		// Construct path within repos directory (defaults to ~/.cyrus/repos, overridable via CYRUS_REPOS_DIR)
		const reposDir = getDefaultReposDir(cyrusHome);
		const repoPath = join(reposDir, repoName);

		// Ensure repos directory exists
		if (!existsSync(reposDir)) {
			try {
				mkdirSync(reposDir, { recursive: true });
			} catch (error) {
				return {
					success: false,
					error: "Failed to create repositories directory",
					details: `Could not create directory at ${reposDir}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		// Check if repository already exists
		if (existsSync(repoPath)) {
			// Verify it's a git repository
			if (isGitRepository(repoPath)) {
				return {
					success: true,
					message: "Repository already exists",
					data: {
						path: repoPath,
						name: repoName,
						action: "verified",
					},
				};
			}

			return {
				success: false,
				error: "Directory exists but is not a Git repository",
				details: `A non-Git directory already exists at ${repoPath}. Please remove it manually or choose a different repository name.`,
			};
		}

		// Clone the repository using gh
		try {
			// gh repo clone expects "org/repo" format, not full URLs
			const orgRepo = getOrgRepoFromUrl(payload.repository_url);
			const cloneCmd = `gh repo clone "${orgRepo}" "${repoPath}"`;
			await execAsync(cloneCmd);

			// Verify the clone was successful
			if (!isGitRepository(repoPath)) {
				return {
					success: false,
					error: "Repository clone verification failed",
					details: `GitHub CLI clone command completed, but the cloned directory at ${repoPath} does not appear to be a valid Git repository.`,
				};
			}

			return {
				success: true,
				message: "Repository cloned successfully",
				data: {
					path: repoPath,
					name: repoName,
					repository_url: payload.repository_url,
					action: "cloned",
				},
			};
		} catch (error) {
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			return {
				success: false,
				error: "Failed to clone repository",
				details: `Could not clone repository from ${payload.repository_url} using GitHub CLI: ${errorMessage}. Please verify the URL is correct, you have access to the repository, and gh is authenticated.`,
			};
		}
	} catch (error) {
		return {
			success: false,
			error: "Repository operation failed",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Handle repository deletion
 * - Removes repository directory from ~/.cyrus/repos/<repo-name>
 * - Removes worktrees from ~/.cyrus/workspaces/<linear-team-key>/<repo-name>
 */
export async function handleRepositoryDelete(
	payload: DeleteRepositoryPayload,
	cyrusHome: string,
): Promise<ApiResponse> {
	try {
		// Validate payload
		if (
			!payload.repository_name ||
			typeof payload.repository_name !== "string"
		) {
			return {
				success: false,
				error: "Repository name is required",
				details:
					"Please provide a valid repository name to delete (e.g., 'my-repo')",
			};
		}

		const repoName = payload.repository_name;
		const reposDir = getDefaultReposDir(cyrusHome);
		const repoPath = join(reposDir, repoName);

		// Check if repository exists
		if (!existsSync(repoPath)) {
			return {
				success: true,
				message: "Repository does not exist (already deleted)",
				data: {
					name: repoName,
					action: "skipped",
				},
			};
		}

		// Remove repository directory
		try {
			rmSync(repoPath, { recursive: true, force: true });
		} catch (error) {
			return {
				success: false,
				error: "Failed to delete repository directory",
				details: `Could not remove directory at ${repoPath}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		// Remove worktrees if linear_team_key is provided
		const deletedWorktrees: string[] = [];
		if (payload.linear_team_key) {
			const workspacesDir = join(cyrusHome, "workspaces");
			const teamWorkspaceDir = join(workspacesDir, payload.linear_team_key);
			const teamRepoWorkspaceDir = join(teamWorkspaceDir, repoName);

			if (existsSync(teamRepoWorkspaceDir)) {
				try {
					rmSync(teamRepoWorkspaceDir, { recursive: true, force: true });
					deletedWorktrees.push(teamRepoWorkspaceDir);
				} catch (error) {
					// Log warning but don't fail - repository was already deleted
					console.warn(
						`Failed to delete worktrees at ${teamRepoWorkspaceDir}: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}
		}

		return {
			success: true,
			message: "Repository deleted successfully",
			data: {
				name: repoName,
				path: repoPath,
				action: "deleted",
				worktrees_deleted: deletedWorktrees,
			},
		};
	} catch (error) {
		return {
			success: false,
			error: "Repository deletion failed",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}
