import {
	extractPRNumber,
	extractRepoFullName,
	type GitHubCommentWebhookEvent,
	isIssueCommentPayload,
} from "cyrus-github-event-transport";

export const GITHUB_REPLY_INSTRUCTIONS = `## Reply delivery
- Handle only the triggering request above. Other PR comments and reviews are context, not additional assignments; Cyrus schedules those requests separately.
- Cyrus publishes your final answer as the reply to this request. Do not post receipt, progress, or completion comments yourself with gh pr comment, the GitHub API, or MCP tools.
- If the request explicitly requires a formal PR review or an inline review-thread reply, create that requested artifact, but do not add a separate status comment.
- Return one concise final answer describing the concrete outcome and validation. If a stop hook asks you to check shipping, verify it and keep the final answer about the original task, not local tracking housekeeping.`;

/** Only the structured automation envelope can silently retire an obsolete request. */
export function getAutomaticReviewId(
	event: GitHubCommentWebhookEvent,
): number | undefined {
	if (!isIssueCommentPayload(event.payload)) return undefined;
	if (event.payload.comment.user.login.toLowerCase() !== "github-actions[bot]")
		return undefined;
	const reviewUrl = /^Review: (https:\/\/\S+)\s*$/m.exec(
		event.payload.comment.body,
	)?.[1];
	if (!reviewUrl) return undefined;
	try {
		const review = new URL(reviewUrl);
		const source = new URL(event.payload.comment.html_url);
		if (
			review.origin !== source.origin ||
			review.pathname !==
				`/${extractRepoFullName(event)}/pull/${extractPRNumber(event)}` ||
			review.search ||
			review.username ||
			review.password
		)
			return undefined;
		const id = /^#pullrequestreview-([1-9]\d*)$/.exec(review.hash)?.[1];
		if (id && Number.isSafeInteger(Number(id))) return Number(id);
	} catch {
		// Unrecognized input remains a normal request; never infer that it is finished.
	}
	return undefined;
}
