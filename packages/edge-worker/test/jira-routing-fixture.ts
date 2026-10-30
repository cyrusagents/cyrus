import type { ILogger, RepositoryConfig } from "cyrus-core";
import { jiraRoutingSource } from "../src/jira-agent/JiraRepositoryRouting.js";
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
		) => router.routeIssue(jiraRoutingSource(issue, text), candidates),
	};
}
