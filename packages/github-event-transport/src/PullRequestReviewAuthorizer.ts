import type { GitHubPullRequestReviewPayload, GitHubUser } from "./types.js";

/**
 * Hidden HTML marker that identifies a PR description as Cyrus-authored.
 *
 * Canonical location for the marker — both the marker-injection hook (in
 * cyrus-edge-worker) and the review authorization policy (here) read from
 * this constant so the two sides cannot drift.
 */
export const CYRUS_PR_MARKER = "<!-- generated-by-cyrus -->";

/**
 * Configuration for {@link PullRequestReviewAuthorizer}.
 */
export interface PullRequestReviewAuthorizerConfig {
	/**
	 * Configured Cyrus GitHub bot login (e.g. `cyrusagent` or
	 * `cyrusagent[bot]`). Used to recognise PRs opened by Cyrus.
	 *
	 * When undefined, only the hidden-marker check is performed.
	 */
	botUsername?: string;
}

/**
 * Outcome of a PR-review authorization check.
 */
export interface PullRequestReviewAuthorization {
	authorized: boolean;
	/** Human-readable reason, suitable for debug logging. */
	reason: string;
}

/**
 * Decides whether a `pull_request_review` event from GitHub is allowed to
 * trigger Cyrus.
 *
 * Mirrors the policy enforced by the hosted webhook handler in
 * `cyrus-hosted/apps/app/src/app/api/github/webhook/route.ts`: a review
 * counts as actionable only when either
 *   1. the PR author is the Cyrus bot account, or
 *   2. the PR body contains {@link CYRUS_PR_MARKER}.
 *
 * Loop prevention (ignoring reviews authored *by* the bot) is the caller's
 * responsibility — this policy is purely about PR ownership.
 */
export class PullRequestReviewAuthorizer {
	constructor(
		private readonly config: PullRequestReviewAuthorizerConfig = {},
	) {}

	authorize(
		payload: GitHubPullRequestReviewPayload,
	): PullRequestReviewAuthorization {
		const prUser = payload.pull_request.user;
		const prBody = payload.pull_request.body ?? "";

		if (this.isCyrusBotAuthor(prUser)) {
			return {
				authorized: true,
				reason: `PR author @${prUser.login} matches the configured Cyrus bot account`,
			};
		}

		if (prBody.includes(CYRUS_PR_MARKER)) {
			return {
				authorized: true,
				reason: "PR body contains the hidden Cyrus marker",
			};
		}

		return {
			authorized: false,
			reason: `PR author @${prUser.login} is not the Cyrus bot and PR body lacks the Cyrus marker`,
		};
	}

	/**
	 * True when the PR's author looks like the configured Cyrus bot account.
	 *
	 * GitHub Apps surface as a user whose `type === "Bot"` and whose login is
	 * the App slug with a `[bot]` suffix (e.g. `cyrusagent[bot]`). Self-hosted
	 * deployments using a PAT under a regular user account surface as
	 * `type === "User"` with a plain login. We accept either shape, comparing
	 * logins case-insensitively against the configured bot username (with or
	 * without the `[bot]` suffix).
	 */
	private isCyrusBotAuthor(prUser: GitHubUser): boolean {
		const { botUsername } = this.config;
		if (!botUsername) return false;

		const normalize = (login: string): string =>
			login.toLowerCase().replace(/\[bot\]$/, "");

		return normalize(prUser.login) === normalize(botUsername);
	}
}
