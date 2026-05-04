/**
 * Utility functions for processing GitHub webhook payloads
 */

import type {
	GitHubCommentWebhookEvent,
	GitHubIssueCommentPayload,
	GitHubPullRequestReviewCommentPayload,
	GitHubPullRequestReviewPayload,
	GitHubWebhookEvent,
} from "./types.js";

/**
 * Type guard for issue_comment payloads
 */
export function isIssueCommentPayload(
	payload: GitHubWebhookEvent["payload"],
): payload is GitHubIssueCommentPayload {
	return "issue" in payload;
}

/**
 * Type guard for pull_request_review_comment payloads
 */
export function isPullRequestReviewCommentPayload(
	payload: GitHubWebhookEvent["payload"],
): payload is GitHubPullRequestReviewCommentPayload {
	return "pull_request" in payload && !("review" in payload);
}

/**
 * Type guard for pull_request_review payloads
 */
export function isPullRequestReviewPayload(
	payload: GitHubWebhookEvent["payload"],
): payload is GitHubPullRequestReviewPayload {
	return "review" in payload;
}

/**
 * Extract the PR branch name from a GitHub webhook event.
 *
 * For issue_comment: We need to use the issue.pull_request URL to determine the PR,
 * but the branch ref is not directly available in the payload. The caller must
 * fetch it from the PR API endpoint.
 *
 * For pull_request_review_comment: The branch is available in payload.pull_request.head.ref
 */
export function extractPRBranchRef(event: GitHubWebhookEvent): string | null {
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.pull_request.head.ref;
	}
	if (isPullRequestReviewCommentPayload(event.payload)) {
		return event.payload.pull_request.head.ref;
	}
	// For issue_comment, the branch ref is not in the payload
	// The caller needs to fetch it from the PR API
	return null;
}

/**
 * Extract the PR base branch name from a GitHub webhook event.
 *
 * For issue_comment: Not available in the payload; the caller must fetch it
 * from the PR API endpoint (same as extractPRBranchRef).
 *
 * For pull_request_review / pull_request_review_comment: Available via
 * payload.pull_request.base.ref
 */
export function extractPRBaseBranchRef(
	event: GitHubWebhookEvent,
): string | null {
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.pull_request.base.ref;
	}
	if (isPullRequestReviewCommentPayload(event.payload)) {
		return event.payload.pull_request.base.ref;
	}
	// For issue_comment, the base ref is not in the payload
	// The caller needs to fetch it from the PR API
	return null;
}

/**
 * Extract the PR number from a GitHub webhook event
 */
export function extractPRNumber(event: GitHubWebhookEvent): number | null {
	if (isIssueCommentPayload(event.payload)) {
		// For issue_comment on a PR, the issue number IS the PR number
		if (event.payload.issue.pull_request) {
			return event.payload.issue.number;
		}
		return null;
	}

	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.pull_request.number;
	}

	if (isPullRequestReviewCommentPayload(event.payload)) {
		return event.payload.pull_request.number;
	}

	return null;
}

/**
 * Extract the comment body from a GitHub webhook event.
 * For pull_request_review events, returns the review body (or empty string if null).
 */
export function extractCommentBody(event: GitHubCommentWebhookEvent): string {
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.review.body ?? "";
	}
	return event.payload.comment.body;
}

/**
 * Extract the comment author from a GitHub webhook event.
 * For pull_request_review events, returns the review author.
 */
export function extractCommentAuthor(event: GitHubCommentWebhookEvent): string {
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.review.user.login;
	}
	return event.payload.comment.user.login;
}

/**
 * Extract repository full name (owner/repo) from a GitHub webhook event
 */
export function extractRepoFullName(event: GitHubWebhookEvent): string {
	return event.payload.repository.full_name;
}

/**
 * Extract repository owner from a GitHub webhook event
 */
export function extractRepoOwner(event: GitHubWebhookEvent): string {
	return event.payload.repository.owner.login;
}

/**
 * Extract repository name from a GitHub webhook event
 */
export function extractRepoName(event: GitHubWebhookEvent): string {
	return event.payload.repository.name;
}

/**
 * Extract the comment ID from a GitHub webhook event.
 * For pull_request_review events, returns the review ID.
 */
export function extractCommentId(event: GitHubCommentWebhookEvent): number {
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.review.id;
	}
	return event.payload.comment.id;
}

/**
 * Extract the installation ID from a GitHub webhook event (if present)
 */
export function extractInstallationId(
	event: GitHubWebhookEvent,
): number | null {
	return event.payload.installation?.id ?? null;
}

/**
 * Check if an issue_comment webhook is for a pull request (not a plain issue)
 */
export function isCommentOnPullRequest(event: GitHubWebhookEvent): boolean {
	if (isIssueCommentPayload(event.payload)) {
		return !!event.payload.issue.pull_request;
	}
	// pull_request_review_comment and pull_request_review are always on a PR
	return true;
}

/**
 * Extract a unique session identifier for the GitHub webhook event.
 * This is used to create a unique session for each PR + repository combination.
 */
export function extractSessionKey(event: GitHubWebhookEvent): string {
	const repoFullName = extractRepoFullName(event);
	const prNumber = extractPRNumber(event);
	return `github:${repoFullName}#${prNumber}`;
}

/**
 * Strip the @cyrusagent mention from a comment body to get the actual instructions
 */
export function stripMention(
	commentBody: string,
	mentionHandle: string = "@cyrusagent",
): string {
	// Remove the mention and any surrounding whitespace
	return commentBody
		.replace(
			new RegExp(
				`\\s*${mentionHandle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*`,
				"gi",
			),
			" ",
		)
		.trim();
}

/**
 * Extract the PR title from a GitHub webhook event
 */
export function extractPRTitle(event: GitHubWebhookEvent): string | null {
	if (isIssueCommentPayload(event.payload)) {
		return event.payload.issue.title;
	}
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.pull_request.title;
	}
	if (isPullRequestReviewCommentPayload(event.payload)) {
		return event.payload.pull_request.title;
	}
	return null;
}

/**
 * Extract the HTML URL for the comment.
 * For pull_request_review events, returns the review URL.
 */
export function extractCommentUrl(event: GitHubCommentWebhookEvent): string {
	if (isPullRequestReviewPayload(event.payload)) {
		return event.payload.review.html_url;
	}
	return event.payload.comment.html_url;
}
