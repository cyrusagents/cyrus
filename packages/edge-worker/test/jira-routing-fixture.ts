import type { ILogger, RepositoryConfig, Workspace } from "cyrus-core";
import { jiraRoutingSource } from "../src/jira-agent/JiraRepositoryRouting.js";
import type { ScopeInspection } from "../src/jira-agent/JiraWorkspaceScope.js";
import { RepositoryRouter } from "../src/RepositoryRouter.js";

const quiet = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => quiet,
} as unknown as ILogger;

const linearOnly = () => {
	throw new Error("Jira routing must not call Linear services");
};

/**
 * The real RepositoryRouter, wired exactly as EdgeWorker wires it for Jira:
 * any Linear dependency it reached would throw.
 */
export function standardJiraRouting(list: () => RepositoryConfig[]) {
	const router = new RepositoryRouter(
		{
			fetchIssueLabels: linearOnly,
			fetchIssueDescription: linearOnly,
			hasActiveSession: linearOnly,
			getIssueTracker: linearOnly,
		},
		quiet,
	);
	return {
		listRepositories: list,
		routeRepositories: (
			issue: Parameters<typeof jiraRoutingSource>[0],
			text: string,
			candidates: RepositoryConfig[],
		) =>
			router.routeIssue(jiraRoutingSource(issue, text), candidates, {
				strict: true,
			}),
		inspectWorkspace: fakeInspect,
	};
}

/**
 * Synthetic scope for fake workspaces: each repository's configured path is
 * its identity and its worktree is the workspace (or `repoPaths[id]`).
 * Real git checks are covered by JiraWorkspaceScope tests.
 */
export async function fakeInspect(
	workspace: Workspace,
	repositories: RepositoryConfig[],
): Promise<ScopeInspection> {
	if (!workspace.isGitWorktree)
		return { ok: false, reason: "the workspace is not a git worktree" };
	return {
		ok: true,
		scope: {
			workspacePath: workspace.path,
			entries: repositories.map((r) => ({
				repositoryId: r.id,
				configuredPath: r.repositoryPath,
				gitCommonDir: `${r.repositoryPath}/.git`,
				worktreePath:
					repositories.length === 1
						? workspace.path
						: (workspace.repoPaths?.[r.id] ?? `${workspace.path}/${r.id}`),
			})),
		},
	};
}
