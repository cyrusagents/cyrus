import { execSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve as pathResolve } from "node:path";

import type {
	BaseBranchResolution,
	Issue,
	RepoSetupHookEventHandler,
	RepositoryConfig,
	Workspace,
} from "cyrus-core";
import { createLogger, getDefaultWorktreesDir, type ILogger } from "cyrus-core";
import {
	RepoHookScriptRunner,
	SETUP_TIMEOUT_MS,
	TEARDOWN_TIMEOUT_MS,
} from "./RepoHookScriptRunner.js";
import { WorktreeIncludeService } from "./WorktreeIncludeService.js";

export interface CreateGitWorktreeOptions {
	globalSetupScript?: string;
	/** Called for repository setup hook lifecycle events. Global setup hooks do not emit events. */
	onRepoSetupHookEvent?: RepoSetupHookEventHandler;
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
	/**
	 * Full set of configured repositories, used only to drop read-only
	 * reference symlinks to the sibling repos a single-repo session can already
	 * read (those sharing the routed repo's `readParentDirectory` parent). Pass
	 * the complete active-repo list; the routed repo is filtered out. Omit to
	 * disable cross-repo linking. See {@link GitService.linkCrossRepoSiblings}.
	 */
	crossRepoSiblingRepositories?: RepositoryConfig[];
}

export interface GitServiceOptions {
	cyrusHome?: string;
}

/**
 * Worktree-relative directory that holds read-only reference symlinks to
 * sibling repositories a single-repo session can already read. Named (not
 * dot-prefixed) so a plain `ls` surfaces it, and git-excluded so it never
 * pollutes `git status`.
 */
export const CROSS_REPO_DIR = "cross-repo";

export interface DeleteWorktreeOptions {
	/**
	 * Repositories involved with this issue's workspace. When provided, each
	 * repo's `cyrus-teardown.sh` (if present) is invoked before worktree removal,
	 * with `cwd` set to that repo's worktree subdirectory.
	 *
	 * In the single-repo layout, the worktree subdirectory is the workspace root.
	 * In multi-repo layouts, it is `<workspace>/<repository.name>/`.
	 */
	repositories?: RepositoryConfig[];
}

/**
 * Result of provisioning a single repo worktree (git checks, fetch, `worktree
 * add`, `.worktreeinclude` copy) without yet running its setup scripts. This
 * splits the parallelizable provision phase from the sequential setup phase so
 * the multi-repo path can overlap independent provisioning work.
 */
interface ProvisionedWorktree {
	workspace: Workspace;
	/**
	 * Path where setup scripts (global + per-repo) should run. Only set when a
	 * fresh worktree was actually created; left undefined on reuse/fallback
	 * paths, which must not re-run setup — mirroring the prior early-return
	 * behavior.
	 */
	setupPath?: string;
}

/**
 * Service responsible for Git worktree operations
 */
export class GitService {
	private logger: ILogger;
	private worktreeIncludeService: WorktreeIncludeService;
	private cyrusHome: string;
	private hookScriptRunner: RepoHookScriptRunner;

	constructor(options?: GitServiceOptions, logger?: ILogger) {
		this.logger = logger ?? createLogger({ component: "GitService" });
		this.worktreeIncludeService = new WorktreeIncludeService(this.logger);
		this.cyrusHome = options?.cyrusHome ?? join(homedir(), ".cyrus");
		this.hookScriptRunner = new RepoHookScriptRunner(this.logger);
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
	 * Resolve mutable Git metadata directories for an entire workspace,
	 * including every repository in a multi-repo session.
	 *
	 * For single-repo workspaces `workspace.path` is itself the worktree, so
	 * resolving from it is sufficient. For multi-repo workspaces, however,
	 * `workspace.path` is a plain parent container (not a git repo) and each
	 * repository lives in a sub-worktree under `workspace.repoPaths`. Each of
	 * those sub-worktrees has its own linked git metadata (for example
	 * `<mainRepo>/.git/worktrees/<name>/`) that must be writable by sandboxes —
	 * resolving only from the container would miss them entirely, breaking
	 * `git add`/`git merge`/etc. with "Operation not permitted".
	 */
	public getGitMetadataDirectoriesForWorkspace(workspace: Workspace): string[] {
		const candidateWorkingDirs = new Set<string>([
			workspace.path,
			...Object.values(workspace.repoPaths ?? {}),
		]);

		const resolvedDirectories = new Set<string>();
		for (const workingDir of candidateWorkingDirs) {
			for (const metadataDir of this.getGitMetadataDirectories(workingDir)) {
				resolvedDirectories.add(metadataDir);
			}
		}

		return [...resolvedDirectories];
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
			onRepoSetupHookEvent,
			workspaceBaseDir: overrideBaseDir,
			baseBranchOverrides,
			crossRepoSiblingRepositories,
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
				await this.runSetupScript(
					globalSetupScript,
					"global",
					workspacePath,
					issue,
				);
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
			const workspace = await this.createSingleRepoWorktree(
				issue,
				repositories[0]!,
				globalSetupScript,
				undefined,
				overrideValue,
				onRepoSetupHookEvent,
			);
			if (workspace.isGitWorktree && crossRepoSiblingRepositories) {
				this.linkCrossRepoSiblings(
					workspace.path,
					repositories[0]!,
					crossRepoSiblingRepositories,
				);
			}
			return workspace;
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
			await this.runSetupScript(globalSetupScript, "global", parentPath, issue);
		}

		const repoPaths: Record<string, string> = {};
		const resolvedBaseBranches: Record<string, BaseBranchResolution> = {};

		// Split provisioning (parallelizable) from setup (must stay sequential).
		// Provisioning is grouped by distinct repositoryPath: configs sharing a
		// repositoryPath race on the same `.git/worktrees` metadata, so they are
		// serialized within their group while distinct repos provision
		// concurrently. Setup scripts run sequentially afterwards — user scripts
		// commonly `pnpm install` against the shared global virtual store and
		// concurrent installs corrupt it (PR #36).
		const groups = new Map<string, RepositoryConfig[]>();
		for (const repository of repositories) {
			const group = groups.get(repository.repositoryPath);
			if (group) {
				group.push(repository);
			} else {
				groups.set(repository.repositoryPath, [repository]);
			}
		}
		const groupList = Array.from(groups.values());

		const provisionedById = new Map<string, ProvisionedWorktree>();
		const buildFallback = (
			repository: RepositoryConfig,
		): ProvisionedWorktree => {
			const repoSubPath = join(parentPath, repository.name);
			mkdirSync(repoSubPath, { recursive: true });
			return { workspace: { path: repoSubPath, isGitWorktree: false } };
		};

		const settled = await Promise.allSettled(
			groupList.map(async (group) => {
				const provisionedInGroup: Array<{
					repository: RepositoryConfig;
					provisioned: ProvisionedWorktree;
				}> = [];
				// Serialize within a group: same repositoryPath => shared
				// `.git/worktrees`, so concurrent `worktree add` calls would race.
				for (const repository of group) {
					const repoSubPath = join(parentPath, repository.name);
					this.logger.info(
						`Creating worktree for repo '${repository.name}' at ${repoSubPath}`,
					);
					try {
						const provisioned = await this.provisionSingleRepoWorktree(
							issue,
							repository,
							repoSubPath, // override workspace path for N-repo layout
							baseBranchOverrides?.get(repository.id),
						);
						provisionedInGroup.push({ repository, provisioned });
					} catch (error) {
						// Preserve per-repo fallback-dir-on-error semantics: one repo's
						// failure still yields a fallback dir and never aborts the others.
						this.logger.error(
							`Failed to create worktree for repo '${repository.name}': ${(error as Error).message}`,
						);
						provisionedInGroup.push({
							repository,
							provisioned: buildFallback(repository),
						});
					}
				}
				return provisionedInGroup;
			}),
		);

		settled.forEach((result, index) => {
			if (result.status === "fulfilled") {
				for (const { repository, provisioned } of result.value) {
					provisionedById.set(repository.id, provisioned);
				}
			} else {
				// A whole group promise rejecting is unexpected (per-repo errors are
				// caught above), but fall back defensively so every repo still gets a dir.
				this.logger.error(
					`Worktree provisioning group failed: ${(result.reason as Error)?.message}`,
				);
				for (const repository of groupList[index]!) {
					provisionedById.set(repository.id, buildFallback(repository));
				}
			}
		});

		// Collect paths + resolved base branches in original repository order.
		for (const repository of repositories) {
			const provisioned = provisionedById.get(repository.id);
			if (!provisioned) continue;
			repoPaths[repository.id] = provisioned.workspace.path;
			if (provisioned.workspace.resolvedBaseBranches) {
				Object.assign(
					resolvedBaseBranches,
					provisioned.workspace.resolvedBaseBranches,
				);
			}
		}

		// Run setup scripts sequentially in original repository order. The global
		// setup script already ran once at the parent level above, so only the
		// per-repo setup runs here (globalSetupScript intentionally omitted).
		for (const repository of repositories) {
			const provisioned = provisionedById.get(repository.id);
			if (provisioned?.setupPath) {
				await this.runWorktreeSetup(
					provisioned.setupPath,
					issue,
					repository.name,
					undefined, // global setup already ran at the parent level
					onRepoSetupHookEvent,
				);
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
	 * Provision a single git worktree for one repository: git checks, base-branch
	 * fetch, `git worktree add`, and `.worktreeinclude` copy. This is the
	 * parallelizable half of worktree creation — it does NOT run setup scripts.
	 * The caller runs those separately (see {@link runWorktreeSetup}) so setup can
	 * stay sequential even when provisioning is overlapped across repos.
	 *
	 * @param workspacePathOverride - Override the workspace path (used for N-repo subdirectories)
	 */
	private async provisionSingleRepoWorktree(
		issue: Issue,
		repository: RepositoryConfig,
		workspacePathOverride?: string,
		baseBranchOverride?: string,
	): Promise<ProvisionedWorktree> {
		this.logger.info(
			`provisionSingleRepoWorktree for ${repository.name} (id=${repository.id}): baseBranchOverride=${baseBranchOverride ?? "undefined"}`,
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
						// Reuse path: no setupPath — setup must not re-run.
						return {
							workspace: {
								path: workspacePath,
								isGitWorktree: true,
								resolvedBaseBranches: { [repository.id]: resolution },
							},
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
					// Reuse path: no setupPath — setup must not re-run.
					return {
						workspace: {
							path: existingWorktreePath,
							isGitWorktree: true,
							resolvedBaseBranches: { [repository.id]: resolution },
						},
					};
				}
			}

			// Fetch only the base branch(es) we may branch from, instead of every
			// remote ref and tag. `git fetch origin` (all refs) can add several
			// seconds to the critical path before the first model response on repos
			// with many branches or tags; worktree creation only ever needs the
			// resolved base branch, with the repo default as a fallback. Fetch each
			// individually so a missing branch doesn't abort the others, and treat
			// the remote as usable if any fetch succeeds. See DEV-164.
			const baseBranchesToFetch = Array.from(
				new Set([baseBranch, repository.baseBranch].filter(Boolean)),
			);
			this.logger.debug(
				`Fetching base branch(es) from remote: ${baseBranchesToFetch.join(", ")}`,
			);
			let hasRemote = false;
			for (const branch of baseBranchesToFetch) {
				try {
					execSync(`git fetch origin --no-tags "${branch}"`, {
						cwd: repository.repositoryPath,
						stdio: "pipe",
					});
					hasRemote = true;
				} catch (e) {
					this.logger.warn(
						`Warning: git fetch of base branch "${branch}" failed:`,
						(e as Error).message,
					);
				}
			}
			if (!hasRemote) {
				this.logger.warn(
					"Warning: git fetch failed for all base branches, proceeding with local branch",
				);
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

			// Provisioning complete. Setup scripts (global + per-repo) are run
			// separately by the caller via runWorktreeSetup, so the multi-repo
			// path can overlap provisioning while keeping setup sequential.
			return {
				workspace: {
					path: workspacePath,
					isGitWorktree: true,
					resolvedBaseBranches: { [repository.id]: resolution },
				},
				setupPath: workspacePath,
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
				// Reuse path: no setupPath — setup must not re-run.
				return {
					workspace: {
						path: worktreeMatch[1],
						isGitWorktree: true,
						resolvedBaseBranches: { [repository.id]: fallbackResolution },
					},
				};
			}

			// Fall back to regular directory if git worktree fails
			const fallbackPath =
				workspacePathOverride ??
				join(repository.workspaceBaseDir, issue.identifier);
			mkdirSync(fallbackPath, { recursive: true });
			// Fallback dir is not a worktree: no setupPath.
			return {
				workspace: {
					path: fallbackPath,
					isGitWorktree: false,
					resolvedBaseBranches: { [repository.id]: fallbackResolution },
				},
			};
		}
	}

	/**
	 * Run setup scripts for a freshly provisioned worktree: the global setup
	 * script (if configured and not already run at the parent level) followed by
	 * the per-repo setup script. Kept separate from provisioning so callers can
	 * run setup sequentially — user setup scripts commonly `pnpm install` against
	 * the shared global virtual store, and concurrent installs corrupt it.
	 */
	private async runWorktreeSetup(
		setupPath: string,
		issue: Issue,
		repositoryName: string,
		globalSetupScript?: string,
		onRepoSetupHookEvent?: RepoSetupHookEventHandler,
	): Promise<void> {
		// First, run the global setup script if configured
		if (globalSetupScript) {
			await this.runSetupScript(globalSetupScript, "global", setupPath, issue);
		}

		// Then, check for repository setup scripts (cross-platform)
		await this.runRepoSetupScript(
			setupPath,
			issue,
			repositoryName,
			onRepoSetupHookEvent,
		);
	}

	/**
	 * Create a single git worktree for one repository (provision + setup).
	 * Used by createGitWorktree for the single-repo case; the multi-repo case
	 * drives {@link provisionSingleRepoWorktree} and {@link runWorktreeSetup}
	 * directly so it can overlap provisioning across repos.
	 *
	 * @param workspacePathOverride - Override the workspace path (used for N-repo subdirectories)
	 */
	private async createSingleRepoWorktree(
		issue: Issue,
		repository: RepositoryConfig,
		globalSetupScript?: string,
		workspacePathOverride?: string,
		baseBranchOverride?: string,
		onRepoSetupHookEvent?: RepoSetupHookEventHandler,
	): Promise<Workspace> {
		const { workspace, setupPath } = await this.provisionSingleRepoWorktree(
			issue,
			repository,
			workspacePathOverride,
			baseBranchOverride,
		);
		if (setupPath) {
			await this.runWorktreeSetup(
				setupPath,
				issue,
				repository.name,
				globalSetupScript,
				onRepoSetupHookEvent,
			);
		}
		return workspace;
	}

	/**
	 * Drop read-only reference symlinks to the sibling repositories a single-repo
	 * session can already read — those sharing the routed repo's readable parent
	 * directory via `readParentDirectory`. Without this the agent only sees its
	 * own worktree and never discovers that sibling checkouts (e.g. an indexer
	 * service) are readable at their absolute paths, so it falls back to guessing
	 * their contracts. See DEV-167.
	 *
	 * Links live under `<worktree>/cross-repo/<repo-name>` and the directory is
	 * added to the worktree's git exclude so it never shows up in `git status` or
	 * gets committed. Access stays read-only in practice: writes are confined to
	 * the worktree by the sandbox, which binds the sibling checkouts read-only —
	 * the same guarantee `readParentDirectory` already relies on.
	 *
	 * Failures are logged and swallowed: a missing sibling link must never abort
	 * worktree creation.
	 */
	private linkCrossRepoSiblings(
		workspacePath: string,
		routedRepository: RepositoryConfig,
		candidateRepositories: RepositoryConfig[],
	): void {
		// No parent-directory read grant → the agent cannot read siblings at all,
		// so a symlink would only dangle into denied space. Nothing to do.
		if (!routedRepository.readParentDirectory) {
			return;
		}

		// `readParentDirectory` grants read access to exactly the routed repo's
		// parent, so only siblings that share that parent are reachable.
		const readableParent = dirname(routedRepository.repositoryPath);
		const siblings = candidateRepositories.filter(
			(repo) =>
				repo.id !== routedRepository.id &&
				repo.isActive !== false &&
				dirname(repo.repositoryPath) === readableParent &&
				existsSync(repo.repositoryPath),
		);
		if (siblings.length === 0) {
			return;
		}

		const linkDir = join(workspacePath, CROSS_REPO_DIR);
		try {
			mkdirSync(linkDir, { recursive: true });
		} catch (error) {
			this.logger.warn(
				`Failed to create cross-repo link directory at ${linkDir}:`,
				(error as Error).message,
			);
			return;
		}

		for (const sibling of siblings) {
			// Bring the sibling's checkout up to its latest default branch first,
			// so the reference shows current code rather than a stale checkout.
			this.refreshSiblingDefaultBranch(sibling);

			const linkPath = join(linkDir, sibling.name);
			// Idempotent, and never clobber an existing entry (e.g. a name
			// collision between two configured repos).
			if (existsSync(linkPath)) {
				continue;
			}
			try {
				symlinkSync(sibling.repositoryPath, linkPath, "dir");
				this.logger.debug(
					`Linked sibling repo '${sibling.name}' -> ${linkPath}`,
				);
			} catch (error) {
				this.logger.warn(
					`Failed to symlink sibling repo '${sibling.name}':`,
					(error as Error).message,
				);
			}
		}

		this.excludeFromGitStatus(workspacePath, CROSS_REPO_DIR);
	}

	/**
	 * Best-effort: bring a sibling repo's canonical checkout up to the latest
	 * `origin/<baseBranch>` before it is exposed as a cross-repo read reference,
	 * so the agent sees current default-branch code rather than a stale checkout.
	 *
	 * Only fast-forwards when the checkout is already on its default branch with a
	 * clean working tree; anything else (detached HEAD, a feature branch, local
	 * edits, or divergence that fails `--ff-only`) is left untouched. Every step
	 * is swallowed on failure — freshness is a nicety, never a reason to abort or
	 * mutate unexpected state. A no-remote repo simply keeps its current commit.
	 */
	private refreshSiblingDefaultBranch(repo: RepositoryConfig): void {
		const { name, repositoryPath, baseBranch } = repo;
		try {
			execSync(`git fetch origin --no-tags "${baseBranch}"`, {
				cwd: repositoryPath,
				stdio: "pipe",
				timeout: 30_000,
			});
		} catch {
			// No reachable remote / branch — leave the checkout as-is.
			return;
		}

		try {
			const currentBranch = execSync("git rev-parse --abbrev-ref HEAD", {
				cwd: repositoryPath,
				encoding: "utf-8",
			}).trim();
			if (currentBranch !== baseBranch) {
				this.logger.debug(
					`Sibling repo '${name}' is on '${currentBranch}', not '${baseBranch}'; leaving its cross-repo reference untouched`,
				);
				return;
			}

			const dirty = execSync("git status --porcelain", {
				cwd: repositoryPath,
				encoding: "utf-8",
			}).trim();
			if (dirty.length > 0) {
				this.logger.debug(
					`Sibling repo '${name}' has local changes; skipping default-branch refresh`,
				);
				return;
			}

			execSync(`git merge --ff-only "origin/${baseBranch}"`, {
				cwd: repositoryPath,
				stdio: "pipe",
				timeout: 30_000,
			});
		} catch (error) {
			this.logger.warn(
				`Failed to refresh sibling repo '${name}' to latest '${baseBranch}':`,
				(error as Error).message,
			);
		}
	}

	/**
	 * Add a root-anchored `entry` to the worktree's git exclude file, once.
	 * `git rev-parse --git-path info/exclude` resolves the correct file even for
	 * linked worktrees. Best-effort: failures are logged and swallowed.
	 */
	private excludeFromGitStatus(workspacePath: string, entry: string): void {
		const line = `/${entry}/`;
		try {
			const gitPath = execSync("git rev-parse --git-path info/exclude", {
				cwd: workspacePath,
				encoding: "utf-8",
			}).trim();
			const excludePath = isAbsolute(gitPath)
				? gitPath
				: join(workspacePath, gitPath);
			mkdirSync(dirname(excludePath), { recursive: true });
			const existing = existsSync(excludePath)
				? readFileSync(excludePath, "utf-8")
				: "";
			if (existing.split("\n").some((l) => l.trim() === line)) {
				return;
			}
			const prefix =
				existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
			writeFileSync(excludePath, `${existing}${prefix}${line}\n`);
		} catch (error) {
			this.logger.warn(
				`Failed to add '${line}' to git exclude for ${workspacePath}:`,
				(error as Error).message,
			);
		}
	}

	/**
	 * Delete worktrees for a given issue identifier.
	 *
	 * Removes all git worktrees under the workspace directory for the issue,
	 * handling both single-repo and multi-repo layouts since the issue identifier
	 * directory is the root in both cases.
	 *
	 * If `options.repositories` is supplied, each repo's per-repo
	 * `cyrus-teardown.sh` (if present in its repo root) is invoked **before**
	 * the worktrees are removed, with `cwd` set to that repo's worktree
	 * subdirectory. A failure in one repo's teardown does not block the others
	 * or the final `rmSync`.
	 *
	 * @param issueIdentifier - The issue identifier (e.g., "DEF-123")
	 * @param options - Optional teardown wiring (see {@link DeleteWorktreeOptions})
	 */
	async deleteWorktree(
		issueIdentifier: string,
		options: DeleteWorktreeOptions = {},
	): Promise<void> {
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

		// Find all git worktrees that are within this workspace path.
		// In multi-repo layouts, there may be subdirectories that are each worktrees.
		const worktreePaths = this.findWorktreesUnderPath(workspacePath);

		// Run per-repo teardown scripts before any worktree is torn down.
		// Each repo's script runs with cwd set to its own worktree subdirectory.
		await this.runTeardownsForIssue({
			issueIdentifier,
			workspacePath,
			repositories: options.repositories,
		});

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
	 * Run per-repo teardown scripts for each repository whose worktree is about
	 * to be removed. Prefers the explicit `repositories` list passed by the
	 * caller (source-of-truth from the session manager); falls back to inferring
	 * the repo mapping from `worktreePaths` (filesystem-driven) — i.e. matches
	 * each worktree subdirectory to a configured `RepositoryConfig` by
	 * `repository.repositoryPath`.
	 *
	 * Each repo's teardown runs with `cwd` set to its own worktree subdirectory.
	 * Failures are isolated: one repo failing does not skip subsequent repos
	 * and does not block worktree deletion.
	 */
	private async runTeardownsForIssue(opts: {
		issueIdentifier: string;
		workspacePath: string;
		repositories?: RepositoryConfig[];
	}): Promise<void> {
		const { issueIdentifier, workspacePath, repositories } = opts;

		// Build the worktree cwd list. Prefer the explicit list from the caller.
		const targets: string[] = [];

		if (repositories && repositories.length > 0) {
			if (repositories.length === 1) {
				// Single-repo layout: workspace root IS the worktree.
				targets.push(workspacePath);
			} else {
				// Multi-repo layout: each repo's worktree is a named subdir.
				for (const repo of repositories) {
					targets.push(join(workspacePath, repo.name));
				}
			}
		}

		if (targets.length === 0) {
			// No repos provided — nothing to do. The filesystem-driven fallback
			// would require the caller to provide a repository registry, which
			// the EdgeWorker is the source of truth for. Without it we skip
			// teardown rather than guessing.
			return;
		}

		for (const workspacePath of targets) {
			try {
				await this.runRepoTeardownScript(workspacePath, issueIdentifier);
			} catch (error) {
				// runRepoTeardownScript already swallows execSync failures and
				// logs them; this catch is defensive against unexpected throws
				// (e.g. unreadable directory) so one bad repo cannot abort the loop.
				this.logger.error(
					`Unexpected error running teardown for ${workspacePath}: ${(error as Error).message}`,
				);
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
	private async runRepoSetupScript(
		workspacePath: string,
		issue: Issue,
		repositoryName?: string,
		onRepoSetupHookEvent?: RepoSetupHookEventHandler,
	): Promise<void> {
		await this.hookScriptRunner.runRepoHookScript({
			hook: "setup",
			workspacePath,
			env: {
				LINEAR_ISSUE_ID: issue.id,
				LINEAR_ISSUE_IDENTIFIER: issue.identifier,
				LINEAR_ISSUE_TITLE: issue.title || "",
			},
			timeoutMs: SETUP_TIMEOUT_MS,
			repositoryName,
			issueIdentifier: issue.identifier,
			onRepoSetupHookEvent,
		});
	}

	/**
	 * Find and run a repository-specific teardown script (cyrus-teardown.sh/.ps1/.cmd/.bat).
	 *
	 * Mirrors {@link runRepoSetupScript} but is invoked from {@link deleteWorktree}
	 * immediately before the worktree subdirectory is removed. Only
	 * `LINEAR_ISSUE_IDENTIFIER` is guaranteed in the teardown environment because
	 * the terminal-state message bus path does not carry the full Issue object.
	 */
	private async runRepoTeardownScript(
		workspacePath: string,
		issueIdentifier: string,
	): Promise<void> {
		await this.hookScriptRunner.runRepoHookScript({
			hook: "teardown",
			workspacePath,
			env: {
				LINEAR_ISSUE_IDENTIFIER: issueIdentifier,
			},
			timeoutMs: TEARDOWN_TIMEOUT_MS,
		});
	}

	/**
	 * Find and run a global setup script (path resolved from EdgeConfig).
	 * Kept as a thin wrapper to preserve the existing call sites.
	 */
	private async runSetupScript(
		scriptPath: string,
		scriptType: "global" | "repository",
		workspacePath: string,
		issue: Issue,
	): Promise<void> {
		await this.hookScriptRunner.runHookScript({
			scriptPath,
			hook: "setup",
			originLabel: scriptType,
			cwd: workspacePath,
			env: {
				LINEAR_ISSUE_ID: issue.id,
				LINEAR_ISSUE_IDENTIFIER: issue.identifier,
				LINEAR_ISSUE_TITLE: issue.title || "",
			},
			timeoutMs: SETUP_TIMEOUT_MS,
		});
	}
}
