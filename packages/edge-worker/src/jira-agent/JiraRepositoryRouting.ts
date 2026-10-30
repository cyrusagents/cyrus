import type { RepositoryConfig } from "cyrus-core";
import type { IssueRoutingSource } from "../RepositoryRouter.js";
import type { JiraIssueRef, JiraRouting } from "./JiraAgentJournal.js";

/**
 * Jira adapter for standard Cyrus repository routing (RepositoryRouter.
 * routeIssue). Everything comes from the work item Hosted read as the Jira
 * user; nothing here calls Linear.
 *
 * - `[repo=...]` / `repo=` / `repos=` selectors: the work item description,
 *   then the Jira request text (an @mention comment can carry them too).
 * - Routing labels: the work item's Jira labels, across the workspace's
 *   repositories (Linear team keys do not scope a Jira work item's labels).
 * - Team keys: matched by the issue-key prefix (the Jira project key), the
 *   router's team-prefix rule. There is no Linear team on a Jira work item.
 * - Project keys (Linear project names) have no Jira equivalent: never match.
 */
export function jiraRoutingSource(
	issue: JiraIssueRef,
	requestText: string,
): IssueRoutingSource {
	return {
		issueId: issue.id,
		teamKey: undefined,
		issueIdentifier: issue.key,
		fetchLabels: async () => [...issue.labels],
		fetchDescription: async () =>
			[issue.description, requestText].filter((t) => t.trim()).join("\n"),
		fetchProjectName: async () => undefined,
	};
}

/**
 * A reply to "which repository?" that names exactly one offered repository
 * (name, id, or hosting URL; a pasted Markdown link or `code` is unwrapped).
 * Unlike Linear's selection there is no fallback: anything else is no choice.
 */
export function selectRepositoryFromReply(
	reply: string,
	candidates: RepositoryConfig[],
): RepositoryConfig | null {
	const value = reply
		.trim()
		.replace(/^\[([^\]]+)\]\(<?[^)>]*>?\)$/, "$1")
		.replace(/^`([^`]+)`$/, "$1")
		.trim();
	if (!value) return null;
	const lower = value.toLowerCase();
	const matches = candidates.filter(
		(repo) =>
			repo.id === value ||
			repo.name.toLowerCase() === lower ||
			repo.githubUrl === value ||
			repo.gitlabUrl === value,
	);
	return matches.length === 1 ? (matches[0] as RepositoryConfig) : null;
}

const MAX_LISTED = 20;

/** What the Jira user sees when routing can't decide (A2A input-required). */
export function repositorySelectionGuidance(
	candidates: RepositoryConfig[],
): string {
	const listed = candidates
		.slice(0, MAX_LISTED)
		.map((repo) => `- ${repo.name}`)
		.join("\n");
	const more =
		candidates.length > MAX_LISTED
			? `\n…and ${candidates.length - MAX_LISTED} more.`
			: "";
	return [
		"Which repository should I work in? Reply with one of these names:",
		`${listed}${more}`,
		"To choose up front next time, add [repo=name] to the work item description (repo=a,b for several, [repo=name#branch] for a base branch), or use a routing label your Cyrus admin set up.",
	].join("\n\n");
}

const METHOD_TEXT: Record<string, string> = {
	"description-tag": "the [repo=…] selector",
	"label-based": "a routing label",
	"project-based": "project routing",
	"team-based": "the Jira project key",
	"team-prefix": "the Jira project key",
	"catch-all": "your workspace's default repository",
	"user-selected": "your reply",
	"site-repository": "the Jira site connection",
};

/** First progress line of a routed task, like Linear's routing activity. */
export function describeRouting(
	repositories: RepositoryConfig[],
	routing: JiraRouting,
): string {
	const names = repositories
		.map((repo) => {
			const branch = routing.baseBranches[repo.id];
			return branch ? `${repo.name} (base ${branch})` : repo.name;
		})
		.join(", ");
	const how = METHOD_TEXT[routing.method] ?? "repository routing";
	return `Working in ${names}, chosen by ${how}.`;
}
