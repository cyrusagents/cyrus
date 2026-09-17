import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";

// Use real Git: mocking child_process would hide shell expansion regressions.
describe("GitService shell safety", () => {
	let root: string;
	let repoPath: string;
	let workspaceBaseDir: string;
	let repository: RepositoryConfig;
	let service: GitService;

	const git = (cwd: string, ...args: string[]) =>
		execFileSync("git", args, {
			cwd,
			encoding: "utf8",
			stdio: "pipe",
		}).trim();

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "cyrus-git-shell-"));
		repoPath = join(root, "repo");
		// A shell would create a harmless marker inside the temporary repository.
		const shellSyntax =
			process.platform === "win32" ? "$(true)" : "$(>shell-marker)";
		workspaceBaseDir = join(root, `workspaces ${shellSyntax} with spaces`);
		vi.stubEnv("CYRUS_WORKTREES_DIR", workspaceBaseDir);
		vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
		vi.stubEnv(
			"GIT_CONFIG_GLOBAL",
			process.platform === "win32" ? "NUL" : "/dev/null",
		);
		mkdirSync(repoPath);
		git(repoPath, "init", "--initial-branch=main");
		git(repoPath, "config", "user.name", "Cyrus Test");
		git(repoPath, "config", "user.email", "test@example.com");
		git(repoPath, "config", "commit.gpgsign", "false");
		git(repoPath, "config", "core.hooksPath", join(root, "no-hooks"));
		writeFileSync(join(repoPath, "README.md"), "initial\n");
		git(repoPath, "add", "README.md");
		git(repoPath, "commit", "-m", "Initial commit");
		const remote = join(root, "remote.git");
		git(root, "init", "--bare", remote);
		git(repoPath, "remote", "add", "origin", remote);
		git(repoPath, "push", "origin", "main");
		repository = {
			id: "repo-1",
			name: "test-repo",
			repositoryPath: repoPath,
			workspaceBaseDir,
			baseBranch: "main",
		};
		service = new GitService({ cyrusHome: join(root, "cyrus") });
	});

	afterEach(() => {
		rmSync(root, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it("looks up local and remote branch names literally", async () => {
		// `true` is a harmless shell builtin: the unfixed code resolves this to main.
		expect(await service.branchExists("$(true)main", repoPath)).toBe(false);
		const branch = "feature$(true)";
		git(repoPath, "branch", branch);
		expect(await service.branchExists(branch, repoPath)).toBe(true);
		git(repoPath, "push", "origin", branch);
		git(repoPath, "branch", "-D", branch);
		expect(await service.branchExists(branch, repoPath)).toBe(true);
		expect(await service.branchExists("missing$(true)", repoPath)).toBe(false);
		expect(await service.branchExists("--help", repoPath)).toBe(false);
	});

	it.skipIf(process.platform === "win32")(
		"looks up quotes and backticks literally",
		async () => {
			for (const branch of [
				'feature"quote',
				"feature`true`",
				"feature'quote",
			]) {
				git(repoPath, "branch", branch);
				expect(await service.branchExists(branch, repoPath)).toBe(true);
			}
		},
	);

	it.each([
		"remote",
		"local",
		"offline",
		"existing",
	])("creates and removes a worktree with literal refs and paths (%s)", async (mode) => {
		const baseBranch = "base$(true)";
		const branch = "feature$(true)";
		git(repoPath, "switch", "-c", baseBranch);
		writeFileSync(join(repoPath, "BASE.md"), "selected base\n");
		git(repoPath, "add", "BASE.md");
		git(repoPath, "commit", "-m", "Base branch content");
		git(repoPath, "switch", "main");
		if (mode === "remote") {
			git(repoPath, "push", "origin", baseBranch);
		}
		if (mode === "offline") {
			git(repoPath, "remote", "remove", "origin");
		}
		if (mode === "existing") {
			git(repoPath, "branch", branch, baseBranch);
		}
		const issue = {
			id: "issue-1",
			identifier: "TEST-1",
			title: "Shell safety",
			branchName: branch,
		} as Issue;
		const workspace = await service.createGitWorktree(issue, [repository], {
			baseBranchOverrides: new Map([[repository.id, baseBranch]]),
		});
		expect(workspace.isGitWorktree).toBe(true);
		expect(workspace.path).toBe(join(workspaceBaseDir, issue.identifier));
		expect(git(workspace.path, "branch", "--show-current")).toBe(branch);
		expect(readFileSync(join(workspace.path, "README.md"), "utf8")).toBe(
			"initial\n",
		);
		expect(readFileSync(join(workspace.path, "BASE.md"), "utf8")).toBe(
			"selected base\n",
		);
		if (mode === "remote") {
			expect(
				git(workspace.path, "rev-parse", "--abbrev-ref", "@{upstream}"),
			).toBe(`origin/${baseBranch}`);
		}
		expect(existsSync(join(repoPath, "shell-marker"))).toBe(false);
		await service.deleteWorktree(issue.identifier);
		expect(existsSync(join(repoPath, "shell-marker"))).toBe(false);
		expect(git(repoPath, "worktree", "list", "--porcelain")).not.toContain(
			workspace.path,
		);
		expect(
			git(repoPath, "show-ref", "--verify", `refs/heads/${branch}`),
		).toContain(`refs/heads/${branch}`);
	});
});
