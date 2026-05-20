import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve as pathResolve } from "node:path";

import type {
	BaseBranchResolution,
	Issue,
	RepositoryConfig,
	Workspace,
} from "cyrus-core";
import { createLogger, getDefaultWorktreesDir, type ILogger } from "cyrus-core";
import { WorktreeIncludeService } from "./WorktreeIncludeService.js";

export interface CreateGitWorktreeOptions {
	globalSetupScript?: string;
	/**
	 * Override workspace base directory. Required for 0-repo workspaces.
	 * For 1+ repos, defaults to the first repository's workspaceBaseDir.
	 */
	workspaceBaseDir?: string;
	/**
	 * Per-repo base branch overrides from [repo=name#branch] syntax.
	 * Takes highest priority over graphite, parent, and default base branches.
	 */
	baseBranchOverrides?: Map<string, string>;
}

export interface GitServiceOptions {
	cyrusHome?: string;
}

/**
 * Per-call options for {@link GitService.deleteWorktree}.
 */
export interface DeleteWorktreeOptions {
	/**
	 * Optional path to a global teardown script. When provided, the script is
	 * executed inside the issue's worktree directory before any filesystem
	 * removal. Failures are logged but do not block deletion.
	 */
	globalTeardownScript?: string;
}

/**
 * Hook script timeout for the setup phase (5 minutes). Setup may need to
 * install dependencies, so it gets a longer budget than teardown.
 */
const SETUP_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Hook script timeout for the teardown phase (2 minutes). Teardown is intended
 * for lightweight cleanup; if it cannot finish in 2 minutes it is killed.
 */
const TEARDOWN_TIMEOUT_MS = 2 * 60 * 1000;

/**
 * Service responsible for Git worktree operations
 */
export class GitService {
	private logger: ILogger;
	private worktreeIncludeService: WorktreeIncludeService;
	private cyrusHome: string;

	constructor(options?: GitServiceOptions, logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "GitService" });
		this.worktreeIncludeService = new WorktreeIncludeService(this.logger);
		this.cyrusHome = options?.cyrusHome ?? join(homedir(), ".cyrus");
	}

	/**
	 * Check if a branch exists locally or remotely
	 */
	async branchExists(branchName: string, repoPath: string): Promise<boolean> {
		try {
			// Check if branch exists locally
			execSync(`git rev-parse --verify "${branchName}"`, {
				cwd: repoPath,
				stdio: "pipe",
			});
			return true;
		} catch {
			// Branch doesn't exist locally, check remote
			try {
				const remoteOutput = execSync(
					`git ls-remote --heads origin "${branchName}"`,
					{
						cwd: repoPath,
						stdio: "pipe",
					},
				);
				// Check if output is non-empty (branch actually exists on remote)
				return remoteOutput && remoteOutput.toString().trim().length > 0;
			} catch {
				return false;
			}
		}
	}

	/**
	 * Sanitize branch name by removing characters invalid in git refs.
	 * Git branch names cannot contain: space, ~, ^, :, ?, *, [, \, backtick,
	 * consecutive dots (..), ASCII control chars, or start/end with dot or slash.
	 * See `git check-ref-format` for the full specification.
	 */
	public sanitizeBranchName(name: string): string {
		if (!name) return name;
		return name
			.replace(/[`~^:?*[\]\\@{}\s]/g, "-") // replace invalid chars with dash
			.replace(/\.{2,}/g, ".") // collapse consecutive dots
			.replace(/\/{2,}/g, "/") // collapse consecutive slashes
			.replace(/\.lock(\/|$)/g, "$1") // remove .lock component
			.replace(/^[.\-/]+/, "") // strip leading dots, dashes, slashes
			.replace(/[.\-/]+$/, "") // strip trailing dots, dashes, slashes
			.replace(/-{2,}/g, "-"); // collapse consecutive dashes
	}

	/**
	 * Resolve mutable Git metadata directories for a repository/worktree.
	 * This includes linked worktree metadata paths (for example
	 * `.git/worktrees/<name>/FETCH_HEAD`) that must be writable by sandboxes.
	 */
	public getGitMetadataDirectories(workingDirectory: string): string[] {
		const resolvedDirectories = new Set<string>();
		const revParse = (
			flag: "--git-dir" | "--git-common-dir",
		): string | null => {
			try {
				const output = execSync(`git rev-parse ${flag}`, {
					cwd: workingDirectory,
					encoding: "utf8",
					stdio: "pipe",
				}).trim();
				return output ? pathResolve(workingDirectory, output) : null;
			} catch {
				return null;
			}
		};

		const gitDir = revParse("--git-dir");
		if (gitDir) {
			resolvedDirectories.add(gitDir);
		}

		const gitCommonDir = revParse("--git-common-dir");
		if (gitCommonDir) {
			resolvedDirectories.add(gitCommonDir);
		}

		return [...resolvedDirectories];
	}

	/**
	 * Run a setup script with proper error handling and logging.
	 * Thin wrapper that delegates to {@link runHookScript} for shared behavior
	 * across setup and teardown hooks.
	 */
	private runSetupScript(
		scriptPath: string,
		scriptType: "global" | "repository",
		workspacePath: string,
		issue: Issue,
	): void {
		const label = scriptType === "global" ? "global setup" : "repository setup";
		this.runHookScript({
			scriptPath,
			label,
			workspacePath,
			env: {
				LINEAR_ISSUE_ID: issue.id,
				LINEAR_ISSUE_IDENTIFIER: issue.identifier,
				LINEAR_ISSUE_TITLE: issue.title || "",
			},
			timeoutMs: SETUP_TIMEOUT_MS,
			postFailureMessage: "   Continuing with worktree creation...",
		});
	}

	/**
	 * Shared hook script runner used by both setup and teardown paths.
	 *
	 * Behavior:
	 * - Expands a leading `~` in `scriptPath` to the user's home directory.
	 * - Skips with a warning if the script does not exist or (on Unix) lacks
	 *   the owner-execute bit.
	 * - Runs the script with `cwd=workspacePath`, `stdio="inherit"`, and the
	 *   provided env merged onto `process.env`.
	 * - On failure logs the error (including SIGTERM-as-timeout) and returns
	 *   normally — failures are non-blocking by design.
	 */
	private runHookScript(opts: {
		scriptPath: string;
		label: string;
		workspacePath: string;
		env: Record<string, string>;
		timeoutMs: number;
		postFailureMessage?: string;
	}): void {
		const { scriptPath, label, workspacePath, env, timeoutMs } = opts;

		// Expand ~ to home directory
		const expandedPath = scriptPath.replace(/^~/, homedir());

		// Check if script exists
		if (!existsSync(expandedPath)) {
			this.logger.warn(`⚠️  ${label} script not found: ${scriptPath}`);
			return;
		}

		// Check if script is executable (Unix only)
		if (process.platform !== "win32") {
			try {
				const stats = statSync(expandedPath);
				// Check if file has execute permission for the owner
				if (!(stats.mode & 0o100)) {
					this.logger.warn(
						`⚠️  ${label} script is not executable: ${scriptPath}`,
					);
					this.logger.warn(`   Run: chmod +x "${expandedPath}"`);
					return;
				}
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				this.logger.warn(
					`⚠️  Cannot check permissions for ${label} script: ${message}`,
				);
				return;
			}
		}

		const scriptName = basename(expandedPath);
		this.logger.info(`ℹ️  Running ${label} script: ${scriptName}`);

		try {
			// Determine the command based on the script extension and platform
			let command: string;
			const isWindows = process.platform === "win32";

			if (scriptPath.endsWith(".ps1")) {
				command = `powershell -ExecutionPolicy Bypass -File "${expandedPath}"`;
			} else if (scriptPath.endsWith(".cmd") || scriptPath.endsWith(".bat")) {
				command = `"${expandedPath}"`;
			} else if (isWindows) {
				// On Windows, try to run with bash if available (Git Bash/WSL)
				command = `bash "${expandedPath}"`;
			} else {
				// On Unix, run directly with bash
				command = `bash "${expandedPath}"`;
			}

			execSync(command, {
				cwd: workspacePath,
				stdio: "inherit",
				env: {
					...process.env,
					...env,
				},
				timeout: timeoutMs,
			});

			this.logger.info(`✅ ${label} script completed successfully`);
		} catch (error) {
			const timeoutMinutes = Math.round(timeoutMs / 60000);
			const signal =
				error && typeof error === "object" && "signal" in error
					? (error as { signal?: NodeJS.Signals | null }).signal
					: undefined;
			const errorMessage =
				signal === "SIGTERM"
					? `Script execution timed out (exceeded ${timeoutMinutes} minute${timeoutMinutes === 1 ? "" : "s"})`
					: error instanceof Error
						? error.message
						: String(error);

			this.logger.error(`❌ ${label} script failed: ${errorMessage}`);

			if (opts.postFailureMessage) {
				this.logger.info(opts.postFailureMessage);
			}
		}
	}

	/**
	 * Find an existing worktree by its checked-out branch name.
	 * Parses `git worktree list --porcelain` output and returns the worktree path
	 * if a worktree is found with the given branch checked out, or null otherwise.
	 */
	findWorktreeByBranch(branchName: string, repoPath: string): string | null {
		try {
			const output = execSync("git worktree list --porcelain", {
				cwd: repoPath,
				encoding: "utf-8",
			});

			const blocks = output.split("\n\n");
			for (const block of blocks) {
				const lines = block.split("\n");
				let worktreePath: string | null = null;
				let branchRef: string | null = null;

				for (const line of lines) {
					if (line.startsWith("worktree ")) {
						worktreePath = line.slice("worktree ".length);
					} else if (line.startsWith("branch ")) {
						branchRef = line.slice("branch refs/heads/".length);
					}
				}

				if (worktreePath && branchRef === branchName) {
					return worktreePath;
				}
			}

			return null;
		} catch {
			return null;
		}
	}

	/**
	 * Determine the base branch for an issue with full resolution info.
	 *
	 * Priority order:
	 * 0. Explicit override from [repo=name#branch] syntax
	 * 1. Graphite blocked-by relationship
	 * 2. Parent issue branch
	 * 3. Repository default base branch
	 *
	 * @param baseBranchOverride Optional override from [repo=name#branch] syntax (highest priority)
	 */
	async determineBaseBranch(
		issue: Issue,
		repository: RepositoryConfig,
		baseBranchOverride?: string,
	): Promise<BaseBranchResolution> {
		// Priority 0: Explicit override from [repo=name#branch] syntax
		if (baseBranchOverride) {
			this.logger.info(
				`Using commit-ish override '${baseBranchOverride}' as base branch for ${issue.identifier} in repo ${repository.name}`,
			);
			return {
				branch: baseBranchOverride,
				source: "commit-ish",
				detail: `[repo=...#${baseBranchOverride}]`,
			};
		}

		// Priority 1: Check graphite blocked-by relationship
		try {
			const isGraphiteIssue = await this.hasGraphiteLabel(issue, repository);

			if (isGraphiteIssue) {
				const blockingIssues = await this.fetchBlockingIssues(issue);

				if (blockingIssues.length > 0) {
					const blockingIssue = blockingIssues[0]!;
					this.logger.info(
						`Issue ${issue.identifier} has graphite label and is blocked by ${blockingIssue.identifier}`,
					);

					const blockingRawBranchName =
						blockingIssue.branchName ||
						`${blockingIssue.identifier}-${(blockingIssue.title ?? "")
							.toLowerCase()
							.replace(/\s+/g, "-")
							.substring(0, 30)}`;
					const blockingBranchName = this.sanitizeBranchName(
						blockingRawBranchName,
					);

					const blockingBranchExists = await this.branchExists(
						blockingBranchName,
						repository.repositoryPath,
					);

					if (blockingBranchExists) {
						this.logger.info(
							`Using blocking issue branch '${blockingBranchName}' as base for Graphite-stacked issue ${issue.identifier}`,
						);
						return {
							branch: blockingBranchName,
							source: "graphite-blocked-by",
							detail: `blocked by ${blockingIssue.identifier}`,
						};
					}
					this.logger.info(
						`Blocking issue branch '${blockingBranchName}' not found, falling back to parent/default`,
					);
				}
			}
		} catch (_error) {
			this.logger.info(
				`Failed to check graphite label for ${issue.identifier}, falling back to parent/default`,
			);
		}

		// Priority 2: Check parent issue
		try {
			const parent = await (issue as any).parent;
			if (parent) {
				this.logger.info(
					`Issue ${issue.identifier} has parent: ${parent.identifier}`,
				);

				const parentRawBranchName =
					parent.branchName ||
					`${parent.identifier}-${parent.title
						?.toLowerCase()
						.replace(/\s+/g, "-")
						.substring(0, 30)}`;
				const parentBranchName = this.sanitizeBranchName(parentRawBranchName);

				const parentBranchExists = await this.branchExists(
					parentBranchName,
					repository.repositoryPath,
				);

				if (parentBranchExists) {
					this.logger.info(
						`Using parent issue branch '${parentBranchName}' as base for sub-issue ${issue.identifier}`,
					);
					return {
						branch: parentBranchName,
						source: "parent-issue",
						detail: `parent ${parent.identifier}`,
					};
				}
				this.logger.info(
					`Parent branch '${parentBranchName}' not found, using default base branch '${repository.baseBranch}'`,
				);
			}
		} catch (_error) {
			this.logger.info(
				`No parent issue found for ${issue.identifier}, using default base branch '${repository.baseBranch}'`,
			);
		}

		// Priority 3: Repository default
		return {
			branch: repository.baseBranch,
			source: "default",
		};
	}

	/**
	 * Check if an issue has the graphite label
	 */
	async hasGraphiteLabel(
		issue: Issue,
		repository: RepositoryConfig,
	): Promise<boolean> {
		const graphiteConfig = repository.labelPrompts?.graphite;
		const graphiteLabels = Array.isArray(graphiteConfig)
			? graphiteConfig
			: (graphiteConfig?.labels ?? ["graphite"]);

		const issueLabels = await this.fetchIssueLabels(issue);
		return graphiteLabels.some((label: string) => issueLabels.includes(label));
	}

	/**
	 * Fetch issues that block this issue (i.e., issues this one is "blocked by").
	 * Uses the inverseRelations field with type "blocks".
	 */
	async fetchBlockingIssues(issue: Issue): Promise<Issue[]> {
		try {
			const inverseRelations = await issue.inverseRelations();
			if (!inverseRelations?.nodes) {
				return [];
			}

			const blockingIssues: Issue[] = [];

			for (const relation of inverseRelations.nodes) {
				if (relation.type === "blocks") {
					const blockingIssue = await relation.issue;
					if (blockingIssue) {
						blockingIssues.push(blockingIssue);
					}
				}
			}

			this.logger.debug(
				`Issue ${issue.identifier} is blocked by ${blockingIssues.length} issue(s): ${blockingIssues.map((i) => i.identifier).join(", ") || "none"}`,
			);

			return blockingIssues;
		} catch (error) {
			this.logger.error(
				`Failed to fetch blocking issues for ${issue.identifier}:`,
				error,
			);
			return [];
		}
	}

	/**
	 * Fetch label names for an issue
	 */
	async fetchIssueLabels(issue: Issue): Promise<string[]> {
		try {
			const labels = await issue.labels();
			return labels.nodes.map((label) => label.name);
		} catch (error) {
			this.logger.error(`Failed to fetch labels for issue ${issue.id}:`, error);
			return [];
		}
	}

	/**
	 * Create a workspace for an issue with 0, 1, or N repositories.
	 *
	 * - **0 repos**: Creates a plain folder at `workspaceBaseDir/ISSUE-ID/` (no git worktree)
	 * - **1 repo**: Git worktree directly at `repo.workspaceBaseDir/ISSUE-ID/` (preserves current behavior)
	 * - **N repos**: Parent folder at `workspaceBaseDir/ISSUE-ID/` with per-repo worktree subdirs
	 */
	async createGitWorktree(
		issue: Issue,
		repositories: RepositoryConfig[],
		options?: CreateGitWorktreeOptions,
	): Promise<Workspace> {
		const {
			globalSetupScript,
			workspaceBaseDir: overrideBaseDir,
			baseBranchOverrides,
		} = options ?? {};

		if (repositories.length === 0) {
			// 0 repos: create a plain folder (no git worktree)
			const baseDir = overrideBaseDir;
			if (!baseDir) {
				throw new Error(
					"workspaceBaseDir is required in options when no repositories are provided",
				);
			}
			const workspacePath = join(baseDir, issue.identifier);
			mkdirSync(workspacePath, { recursive: true });
			this.logger.info(
				`Created plain workspace (no repos) at ${workspacePath}`,
			);

			// Run global setup script if configured
			if (globalSetupScript) {
				this.runSetupScript(globalSetupScript, "global", workspacePath, issue);
			}

			return {
				path: workspacePath,
				isGitWorktree: false,
			};
		}

		if (repositories.length === 1) {
			// 1 repo: preserve exact current behavior
			const repoId = repositories[0]!.id;
			const overrideValue = baseBranchOverrides?.get(repoId);
			this.logger.info(
				`createGitWorktree: baseBranchOverrides=${baseBranchOverrides ? `Map(size=${baseBranchOverrides.size})` : "undefined"}, repoId=${repoId}, overrideValue=${overrideValue ?? "undefined"}`,
			);
			return this.createSingleRepoWorktree(
				issue,
				repositories[0]!,
				globalSetupScript,
				undefined,
				overrideValue,
			);
		}

		// N repos: parent folder with per-repo subdirectories
		const baseDir = overrideBaseDir ?? repositories[0]!.workspaceBaseDir;
		const parentPath = join(baseDir, issue.identifier);
		mkdirSync(parentPath, { recursive: true });
		this.logger.info(
			`Creating multi-repo workspace at ${parentPath} for ${repositories.length} repositories`,
		);

		// Run global setup script once in the parent directory
		if (globalSetupScript) {
			this.runSetupScript(globalSetupScript, "global", parentPath, issue);
		}

		const repoPaths: Record<string, string> = {};
		const resolvedBaseBranches: Record<string, BaseBranchResolution> = {};

		for (const repository of repositories) {
			const repoSubPath = join(parentPath, repository.name);
			this.logger.info(
				`Creating worktree for repo '${repository.name}' at ${repoSubPath}`,
			);

			try {
				const repoWorkspace = await this.createSingleRepoWorktree(
					issue,
					repository,
					undefined, // global setup already ran
					repoSubPath, // override workspace path for N-repo layout
					baseBranchOverrides?.get(repository.id),
				);
				repoPaths[repository.id] = repoWorkspace.path;
				if (repoWorkspace.resolvedBaseBranches) {
					Object.assign(
						resolvedBaseBranches,
						repoWorkspace.resolvedBaseBranches,
					);
				}
			} catch (error) {
				this.logger.error(
					`Failed to create worktree for repo '${repository.name}': ${(error as Error).message}`,
				);
				// Create fallback directory for this repo
				mkdirSync(repoSubPath, { recursive: true });
				repoPaths[repository.id] = repoSubPath;
			}
		}

		return {
			path: parentPath,
			isGitWorktree: true,
			repoPaths,
			resolvedBaseBranches,
		};
	}

	/**
	 * Create a single git worktree for one repository.
	 * This is the core worktree creation logic, used by createGitWorktree for both
	 * single-repo and multi-repo cases.
	 *
	 * @param workspacePathOverride - Override the workspace path (used for N-repo subdirectories)
	 */
	private async createSingleRepoWorktree(
		issue: Issue,
		repository: RepositoryConfig,
		globalSetupScript?: string,
		workspacePathOverride?: string,
		baseBranchOverride?: string,
	): Promise<Workspace> {
		this.logger.info(
			`createSingleRepoWorktree for ${repository.name} (id=${repository.id}): baseBranchOverride=${baseBranchOverride ?? "undefined"}`,
		);
		// Build a fallback resolution for error paths where determineBaseBranch hasn't run
		const fallbackResolution: BaseBranchResolution = baseBranchOverride
			? {
					branch: baseBranchOverride,
					source: "commit-ish",
					detail: `[repo=...#${baseBranchOverride}]`,
				}
			: { branch: repository.baseBranch, source: "default" };

		try {
			// Verify this is a git repository
			try {
				execSync("git rev-parse --git-dir", {
					cwd: repository.repositoryPath,
					stdio: "pipe",
				});
			} catch (_e) {
				this.logger.error(
					`${repository.repositoryPath} is not a git repository`,
				);
				throw new Error("Not a git repository");
			}

			// Use Linear's preferred branch name, or generate one if not available
			const rawBranchName =
				issue.branchName ||
				`${issue.identifier}-${issue.title
					?.toLowerCase()
					.replace(/\s+/g, "-")
					.substring(0, 30)}`;
			const branchName = this.sanitizeBranchName(rawBranchName);
			const workspacePath =
				workspacePathOverride ??
				join(repository.workspaceBaseDir, issue.identifier);

			// Ensure workspace directory's parent exists
			mkdirSync(
				workspacePathOverride
					? join(workspacePath, "..")
					: repository.workspaceBaseDir,
				{ recursive: true },
			);

			// Determine base branch early (commit-ish > graphite > parent > default)
			// This runs before worktree existence checks so all return paths have the resolution
			const resolution = await this.determineBaseBranch(
				issue,
				repository,
				baseBranchOverride,
			);
			const baseBranch = resolution.branch;

			// Check if worktree already exists
			try {
				const worktrees = execSync("git worktree list --porcelain", {
					cwd: repository.repositoryPath,
					encoding: "utf-8",
				});

				// Use exact line match to avoid substring false positives
				// (e.g., "/path/CYSV-56" matching "/path/CYSV-56/cyrus")
				const worktreeLines = worktrees
					.split("\n")
					.filter((line) => line.startsWith("worktree "))
					.map((line) => line.substring("worktree ".length));

				if (worktreeLines.includes(workspacePath)) {
					// Verify the worktree is actually valid on disk (not a stale entry
					// from a previous cleanup that deleted the directory)
					if (this.isGitWorktree(workspacePath)) {
						this.logger.info(
							`Worktree already exists at ${workspacePath}, using existing`,
						);
						return {
							path: workspacePath,
							isGitWorktree: true,
							resolvedBaseBranches: { [repository.id]: resolution },
						};
					}
					// Stale worktree entry — prune and continue with creation
					this.logger.info(
						`Stale worktree entry found for ${workspacePath}, pruning and recreating`,
					);
					try {
						execSync("git worktree prune", {
							cwd: repository.repositoryPath,
							stdio: "pipe",
						});
					} catch {
						// Prune failed, continue anyway
					}
				}
			} catch (_e) {
				// git worktree command failed, continue with creation
			}

			// Check if branch already exists
			let createBranch = true;
			try {
				execSync(`git rev-parse --verify "${branchName}"`, {
					cwd: repository.repositoryPath,
					stdio: "pipe",
				});
				createBranch = false;
			} catch (_e) {
				// Branch doesn't exist, we'll create it
			}

			// If the branch already exists, check if it's already checked out in another worktree
			if (!createBranch) {
				const existingWorktreePath = this.findWorktreeByBranch(
					branchName,
					repository.repositoryPath,
				);
				if (existingWorktreePath && existingWorktreePath !== workspacePath) {
					this.logger.info(
						`Branch "${branchName}" is already checked out in worktree at ${existingWorktreePath}, reusing existing worktree`,
					);
					return {
						path: existingWorktreePath,
						isGitWorktree: true,
						resolvedBaseBranches: { [repository.id]: resolution },
					};
				}
			}

			// Fetch latest changes from remote
			this.logger.debug("Fetching latest changes from remote...");
			let hasRemote = true;
			try {
				execSync("git fetch origin", {
					cwd: repository.repositoryPath,
					stdio: "pipe",
				});
			} catch (e) {
				this.logger.warn(
					"Warning: git fetch failed, proceeding with local branch:",
					(e as Error).message,
				);
				hasRemote = false;
			}

			// Create the worktree - use determined base branch
			let worktreeCmd: string;
			if (createBranch) {
				if (hasRemote) {
					// Check if the base branch exists remotely
					let useRemoteBranch = false;
					try {
						const remoteOutput = execSync(
							`git ls-remote --heads origin "${baseBranch}"`,
							{
								cwd: repository.repositoryPath,
								stdio: "pipe",
							},
						);
						// Check if output is non-empty (branch actually exists on remote)
						useRemoteBranch =
							remoteOutput && remoteOutput.toString().trim().length > 0;
						if (!useRemoteBranch) {
							this.logger.info(
								`Base branch '${baseBranch}' not found on remote, checking locally...`,
							);
						}
					} catch {
						// Base branch doesn't exist remotely, use local or fall back to default
						this.logger.info(
							`Base branch '${baseBranch}' not found on remote, checking locally...`,
						);
					}

					if (useRemoteBranch) {
						// Use remote version of base branch with --track to set upstream
						const remoteBranch = `origin/${baseBranch}`;
						this.logger.info(
							`Creating git worktree at ${workspacePath} from ${remoteBranch} (tracking ${baseBranch})`,
						);
						worktreeCmd = `git worktree add --track -b "${branchName}" "${workspacePath}" "${remoteBranch}"`;
					} else {
						// Check if base branch exists locally
						try {
							execSync(`git rev-parse --verify "${baseBranch}"`, {
								cwd: repository.repositoryPath,
								stdio: "pipe",
							});
							// Use local base branch (can't track since remote doesn't have it)
							this.logger.info(
								`Creating git worktree at ${workspacePath} from local ${baseBranch}`,
							);
							worktreeCmd = `git worktree add -b "${branchName}" "${workspacePath}" "${baseBranch}"`;
						} catch {
							// Base branch doesn't exist locally either, fall back to remote default with --track
							this.logger.info(
								`Base branch '${baseBranch}' not found locally, falling back to remote ${repository.baseBranch} (tracking ${repository.baseBranch})`,
							);
							const defaultRemoteBranch = `origin/${repository.baseBranch}`;
							worktreeCmd = `git worktree add --track -b "${branchName}" "${workspacePath}" "${defaultRemoteBranch}"`;
						}
					}
				} else {
					// No remote, use local branch (no tracking since no remote)
					this.logger.info(
						`Creating git worktree at ${workspacePath} from local ${baseBranch}`,
					);
					worktreeCmd = `git worktree add -b "${branchName}" "${workspacePath}" "${baseBranch}"`;
				}
			} else {
				// Branch already exists, just check it out
				this.logger.info(
					`Creating git worktree at ${workspacePath} with existing branch ${branchName}`,
				);
				worktreeCmd = `git worktree add "${workspacePath}" "${branchName}"`;
			}

			execSync(worktreeCmd, {
				cwd: repository.repositoryPath,
				stdio: "pipe",
			});

			// Copy files specified in .worktreeinclude that are also in .gitignore
			// This runs before setup scripts so they can access these files
			await this.worktreeIncludeService.copyIgnoredFiles(
				repository.repositoryPath,
				workspacePath,
			);

			// First, run the global setup script if configured
			if (globalSetupScript) {
				this.runSetupScript(globalSetupScript, "global", workspacePath, issue);
			}

			// Then, check for repository setup scripts (cross-platform)
			this.runRepoSetupScript(repository.repositoryPath, workspacePath, issue);

			return {
				path: workspacePath,
				isGitWorktree: true,
				resolvedBaseBranches: { [repository.id]: resolution },
			};
		} catch (error) {
			const errorMessage = (error as Error).message;
			this.logger.error("Failed to create git worktree:", errorMessage);

			// Check if the error is "branch already checked out in another worktree"
			// Git error format: "fatal: 'branch-name' is already used by worktree at '/path/to/worktree'"
			const worktreeMatch = errorMessage.match(
				/already used by worktree at '([^']+)'/,
			);
			if (worktreeMatch?.[1] && existsSync(worktreeMatch[1])) {
				this.logger.info(
					`Reusing existing worktree at ${worktreeMatch[1]} (branch already checked out)`,
				);
				return {
					path: worktreeMatch[1],
					isGitWorktree: true,
					resolvedBaseBranches: { [repository.id]: fallbackResolution },
				};
			}

			// Fall back to regular directory if git worktree fails
			const fallbackPath =
				workspacePathOverride ??
				join(repository.workspaceBaseDir, issue.identifier);
			mkdirSync(fallbackPath, { recursive: true });
			return {
				path: fallbackPath,
				isGitWorktree: false,
				resolvedBaseBranches: { [repository.id]: fallbackResolution },
			};
		}
	}

	/**
	 * Delete worktrees for a given issue identifier.
	 *
	 * Removes all git worktrees under the workspace directory for the issue,
	 * handling both single-repo and multi-repo layouts since the issue identifier
	 * directory is the root in both cases.
	 *
	 * @param issueIdentifier - The issue identifier (e.g., "DEF-123")
	 * @param options - Optional per-call options (e.g., global teardown script)
	 */
	deleteWorktree(
		issueIdentifier: string,
		options?: DeleteWorktreeOptions,
	): void {
		const workspacePath = join(
			getDefaultWorktreesDir(this.cyrusHome),
			issueIdentifier,
		);

		if (!existsSync(workspacePath)) {
			this.logger.info(
				`Worktree directory does not exist for ${issueIdentifier}, nothing to delete`,
			);
			return;
		}

		this.logger.info(
			`Deleting worktree directory for ${issueIdentifier} at ${workspacePath}`,
		);

		// Run global teardown script before any filesystem removal so it can
		// still read .env.local / local DBs / setup-script artifacts. Failures
		// are logged but do not block deletion (handled inside runHookScript).
		if (options?.globalTeardownScript) {
			this.runHookScript({
				scriptPath: options.globalTeardownScript,
				label: "global teardown",
				workspacePath,
				env: {
					LINEAR_ISSUE_IDENTIFIER: issueIdentifier,
				},
				timeoutMs: TEARDOWN_TIMEOUT_MS,
			});
		}

		// Find all git worktrees that are within this workspace path.
		// In multi-repo layouts, there may be subdirectories that are each worktrees.
		const worktreePaths = this.findWorktreesUnderPath(workspacePath);

		// Collect parent repository paths so we can prune stale entries after deletion
		const parentRepoPaths = new Set<string>();

		for (const wtPath of worktreePaths) {
			try {
				this.logger.info(`Removing git worktree: ${wtPath}`);
				// Derive the main repository path from the worktree's .git file
				// so we can run the command from a valid git context.
				const mainRepoPath = this.getMainRepoFromWorktree(wtPath);
				if (mainRepoPath) {
					parentRepoPaths.add(mainRepoPath);
				}
				// Fall back to the worktree path itself (git reads its .git file to find the parent)
				const cwd = mainRepoPath ?? wtPath;
				execSync(`git worktree remove --force "${wtPath}"`, {
					cwd,
					stdio: "pipe",
					timeout: 30_000,
				});
			} catch (error) {
				this.logger.warn(
					`Failed to remove git worktree at ${wtPath}: ${(error as Error).message}`,
				);
				// Continue with directory deletion even if git worktree remove fails
			}
		}

		// Remove the entire workspace directory
		try {
			rmSync(workspacePath, { recursive: true, force: true });
			this.logger.info(`Deleted worktree directory for ${issueIdentifier}`);
		} catch (error) {
			this.logger.error(
				`Failed to delete worktree directory for ${issueIdentifier}: ${(error as Error).message}`,
			);
		}

		// Prune stale worktree entries from parent repositories.
		// If git worktree remove failed above, the filesystem directory was still deleted
		// by rmSync, leaving stale entries in git's internal tracking.
		for (const repoPath of parentRepoPaths) {
			try {
				execSync("git worktree prune", {
					cwd: repoPath,
					stdio: "pipe",
					timeout: 10_000,
				});
			} catch {
				// Best-effort: prune failure is not critical
			}
		}
	}

	/**
	 * Find all git worktree paths that are located under a given directory.
	 * Checks the directory itself and its immediate subdirectories (for multi-repo layouts).
	 */
	private findWorktreesUnderPath(dirPath: string): string[] {
		const worktrees: string[] = [];

		// Check if the directory itself is a git worktree
		if (this.isGitWorktree(dirPath)) {
			worktrees.push(dirPath);
			return worktrees;
		}

		// Check immediate subdirectories (multi-repo layout: each repo is a subdirectory)
		try {
			const entries = readdirSync(dirPath, { withFileTypes: true });
			for (const entry of entries) {
				if (entry.isDirectory()) {
					const subPath = join(dirPath, entry.name);
					if (this.isGitWorktree(subPath)) {
						worktrees.push(subPath);
					}
				}
			}
		} catch {
			// Directory listing failed, skip
		}

		return worktrees;
	}

	/**
	 * Check if a directory is a git worktree (has a .git file, not a .git directory).
	 */
	private isGitWorktree(dirPath: string): boolean {
		try {
			const gitPath = join(dirPath, ".git");
			if (!existsSync(gitPath)) {
				return false;
			}
			const stats = statSync(gitPath);
			// Worktrees have a .git file (not directory) that points to the main repo
			return stats.isFile();
		} catch {
			return false;
		}
	}

	/**
	 * Extract the main repository path from a worktree's .git file.
	 * Worktree .git files contain "gitdir: /path/to/main-repo/.git/worktrees/<name>".
	 * Returns the main repository directory, or null if it cannot be determined.
	 */
	private getMainRepoFromWorktree(worktreePath: string): string | null {
		try {
			const gitFilePath = join(worktreePath, ".git");
			if (!existsSync(gitFilePath)) return null;
			const stats = statSync(gitFilePath);
			if (!stats.isFile()) return null;

			const content = readFileSync(gitFilePath, "utf-8").trim();
			const match = content.match(/^gitdir:\s+(.+)$/);
			if (!match?.[1]) return null;

			// gitdir points to main-repo/.git/worktrees/<name>
			// Resolve to absolute path (may be relative), then go up 3 levels
			const gitDir = pathResolve(worktreePath, match[1]);
			const mainRepoDir = pathResolve(gitDir, "..", "..", "..");
			return existsSync(mainRepoDir) ? mainRepoDir : null;
		} catch {
			return null;
		}
	}

	/**
	 * Find and run a repository-specific setup script (cyrus-setup.sh/.ps1/.cmd/.bat)
	 */
	private runRepoSetupScript(
		repositoryPath: string,
		workspacePath: string,
		issue: Issue,
	): void {
		const isWindows = process.platform === "win32";
		const setupScripts = [
			{
				file: "cyrus-setup.sh",
				platform: "unix",
			},
			{
				file: "cyrus-setup.ps1",
				platform: "windows",
			},
			{
				file: "cyrus-setup.cmd",
				platform: "windows",
			},
			{
				file: "cyrus-setup.bat",
				platform: "windows",
			},
		];

		// Find the first available setup script for the current platform
		const availableScript = setupScripts.find((script) => {
			const scriptPath = join(repositoryPath, script.file);
			const isCompatible = isWindows
				? script.platform === "windows"
				: script.platform === "unix";
			return existsSync(scriptPath) && isCompatible;
		});

		// Fallback: on Windows, try bash if no Windows scripts found (for Git Bash/WSL users)
		const fallbackScript =
			!availableScript && isWindows
				? setupScripts.find((script) => {
						const scriptPath = join(repositoryPath, script.file);
						return script.platform === "unix" && existsSync(scriptPath);
					})
				: null;

		const scriptToRun = availableScript || fallbackScript;

		if (scriptToRun) {
			const scriptPath = join(repositoryPath, scriptToRun.file);
			this.runSetupScript(scriptPath, "repository", workspacePath, issue);
		}
	}
}
