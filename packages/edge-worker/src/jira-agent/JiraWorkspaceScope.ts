import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import type { RepositoryConfig, Workspace } from "cyrus-core";

/**
 * The physical execution scope of a Jira context: for each routed repository,
 * the repository it belongs to (git common dir) and its own linked worktree.
 * Pinned in the journal before the first run; every later run must find the
 * same scope or refuse, so a configuration change can never resume a session
 * in a different repository or worktree.
 */
export interface JiraScopeEntry {
	repositoryId: string;
	/** Configured repositoryPath, as configured (cheap drift check). */
	configuredPath: string;
	/** Real path of the repository's git common dir. */
	gitCommonDir: string;
	/** Real path of this repository's worktree for the context. */
	worktreePath: string;
}

export interface JiraScope {
	workspacePath: string;
	entries: JiraScopeEntry[];
}

export type ScopeInspection =
	| { ok: true; scope: JiraScope }
	| { ok: false; reason: string };

const git = (cwd: string, args: string[]) =>
	new Promise<string>((resolve, reject) => {
		execFile(
			"git",
			["-C", cwd, ...args],
			{ timeout: 15_000 },
			(error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
		);
	});

async function commonDir(path: string): Promise<string> {
	return realpath(
		await git(path, [
			"rev-parse",
			"--path-format=absolute",
			"--git-common-dir",
		]),
	);
}

/**
 * Check that every routed repository has its own linked worktree in the
 * workspace (the workspace itself for one repository, `repoPaths[id]` for
 * several), that each is the top of a git worktree of THAT repository, and
 * that no two share a worktree. A plain directory left behind by a failed
 * checkout, a missing child, or a worktree of another repository fails.
 */
export async function inspectJiraWorkspace(
	workspace: Workspace,
	repositories: RepositoryConfig[],
): Promise<ScopeInspection> {
	if (!workspace.isGitWorktree)
		return { ok: false, reason: "the workspace is not a git worktree" };
	const entries: JiraScopeEntry[] = [];
	for (const repository of repositories) {
		const path =
			repositories.length === 1
				? workspace.path
				: workspace.repoPaths?.[repository.id];
		if (!path)
			return { ok: false, reason: `no worktree for ${repository.name}` };
		try {
			const worktreePath = await realpath(path);
			const top = await realpath(
				await git(path, ["rev-parse", "--show-toplevel"]),
			);
			if (top !== worktreePath)
				return {
					ok: false,
					reason: `${repository.name} is not checked out as its own worktree`,
				};
			// Never the repository's own (main) checkout: an isolated worktree.
			const main = await realpath(
				await git(repository.repositoryPath, ["rev-parse", "--show-toplevel"]),
			);
			if (main === worktreePath)
				return {
					ok: false,
					reason: `${repository.name} would run in its main checkout, not an isolated worktree`,
				};
			const own = await commonDir(path);
			const expected = await commonDir(repository.repositoryPath);
			if (own !== expected)
				return {
					ok: false,
					reason: `${repository.name}'s worktree belongs to another repository`,
				};
			if (entries.some((e) => e.worktreePath === worktreePath))
				return { ok: false, reason: "two repositories share one worktree" };
			entries.push({
				repositoryId: repository.id,
				configuredPath: repository.repositoryPath,
				gitCommonDir: own,
				worktreePath,
			});
		} catch {
			return {
				ok: false,
				reason: `${repository.name} has no valid git worktree`,
			};
		}
	}
	return {
		ok: true,
		scope: { workspacePath: await realpath(workspace.path), entries },
	};
}

/** Whether a freshly inspected scope is the one pinned for the context. */
export function sameScope(a: JiraScope, b: JiraScope): boolean {
	if (a.workspacePath !== b.workspacePath) return false;
	if (a.entries.length !== b.entries.length) return false;
	return a.entries.every((e, i) => {
		const o = b.entries[i] as JiraScopeEntry;
		return (
			e.repositoryId === o.repositoryId &&
			e.configuredPath === o.configuredPath &&
			e.gitCommonDir === o.gitCommonDir &&
			e.worktreePath === o.worktreePath
		);
	});
}
