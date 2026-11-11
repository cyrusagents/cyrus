/**
 * Resolve a review author to an App ID, never a bot-user or installation ID.
 * GitHub's Bot node binds the signed webhook's numeric user ID to an App URL.
 * The App REST endpoint supplies the stable app ID. No username-only fallback.
 * Keep this contract aligned with the separately released Cyrus runtime.
 */
export interface ReviewAuthor {
	id: number;
	node_id?: string;
	login: string;
	type: string;
}

export async function resolveReviewAppId(
	author: ReviewAuthor,
	token: string,
	request: typeof fetch = fetch,
): Promise<number | null> {
	if (author.type !== "Bot" || !author.node_id || !token) return null;
	const headers = {
		Authorization: `Bearer ${token}`,
		Accept: "application/vnd.github+json",
		"X-GitHub-Api-Version": "2022-11-28",
		"Content-Type": "application/json",
	};
	const response = await request("https://api.github.com/graphql", {
		method: "POST",
		headers,
		signal: AbortSignal.timeout(10000),
		body: JSON.stringify({
			query:
				"query ReviewBot($id: ID!) { node(id: $id) { __typename ... on Bot { databaseId login url } } }",
			variables: { id: author.node_id },
		}),
	});
	if (!response.ok) return null;
	const result = (await response.json()) as {
		errors?: unknown[];
		data?: {
			node?: {
				__typename: string;
				databaseId: number;
				login: string;
				url: string;
			};
		};
	};
	const bot = result.data?.node;
	if (
		result.errors?.length ||
		bot?.__typename !== "Bot" ||
		bot.databaseId !== author.id ||
		`${bot.login.replace(/\[bot\]$/, "")}[bot]` !== author.login
	)
		return null;
	const match = /^https:\/\/github\.com\/apps\/([a-z0-9-]+)$/.exec(bot.url);
	if (!match || author.login !== `${match[1]}[bot]`) return null;
	const appResponse = await request(`https://api.github.com/apps/${match[1]}`, {
		headers,
		signal: AbortSignal.timeout(10000),
	});
	if (!appResponse.ok) return null;
	const app = (await appResponse.json()) as { id: number; slug: string };
	return app.slug === match[1] && Number.isSafeInteger(app.id) && app.id > 0
		? app.id
		: null;
}

export interface GitHubReviewAppPolicy {
	installationId: string;
	organization: string;
	appIds: number[];
	includeSuggestions?: boolean;
}

export function allowedReviewAppIds(
	policies: GitHubReviewAppPolicy[] | undefined,
	installationId: string | undefined,
	owner: { login: string; type: string },
	suggestions = false,
): number[] {
	if (owner.type !== "Organization" || !installationId) return [];
	return (
		policies?.find(
			(policy) =>
				policy.installationId === installationId &&
				policy.organization.toLowerCase() === owner.login.toLowerCase() &&
				(!suggestions || policy.includeSuggestions === true),
		)?.appIds ?? []
	);
}
