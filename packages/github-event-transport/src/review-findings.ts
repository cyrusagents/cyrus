/** Fetch a single submitted review's findings, never PR-wide discussion comments.
 * Kept aligned between Hosted and the independently released runtime.
 */
export interface ReviewFinding {
	id: number;
	path: string;
	line: number | null;
	body: string;
	html_url: string;
}
export interface ReviewFindingsScope {
	owner: string;
	repo: string;
	pullNumber: number;
	reviewId: number;
	authorId: number;
	commitId: string;
}

export async function loadReviewFindings(
	scope: ReviewFindingsScope,
	token: string,
	request: typeof fetch = fetch,
): Promise<ReviewFinding[]> {
	const findings = new Map<number, ReviewFinding>();
	// Bound provider work; fail closed instead of silently accepting a partial batch.
	for (let page = 1; page <= 100; page++) {
		const url = `https://api.github.com/repos/${encodeURIComponent(scope.owner)}/${encodeURIComponent(scope.repo)}/pulls/${scope.pullNumber}/reviews/${scope.reviewId}/comments?per_page=100&page=${page}`;
		const response = await request(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			signal: AbortSignal.timeout(10000),
		});
		if (!response.ok)
			throw new Error(
				`GitHub review findings unavailable (${response.status})`,
			);
		const comments = await response.json();
		if (!Array.isArray(comments))
			throw new Error("Invalid GitHub review findings response");
		for (const comment of comments) {
			if (
				comment?.pull_request_review_id !== scope.reviewId ||
				comment.user?.id !== scope.authorId ||
				comment.commit_id !== scope.commitId ||
				comment.in_reply_to_id != null ||
				!Number.isSafeInteger(comment.id) ||
				comment.id <= 0 ||
				typeof comment.path !== "string" ||
				!comment.path ||
				typeof comment.body !== "string" ||
				!comment.body.trim() ||
				typeof comment.html_url !== "string" ||
				(comment.line == null && comment.subject_type !== "file")
			)
				continue;
			findings.set(comment.id, {
				id: comment.id,
				path: comment.path,
				line: comment.line ?? null,
				body: comment.body,
				html_url: comment.html_url,
			});
		}
		if (comments.length < 100) return [...findings.values()];
	}
	throw new Error("GitHub review findings pagination limit exceeded");
}

export function formatReviewFindings(findings: ReviewFinding[]): string {
	return findings
		.map(
			(finding) =>
				`### ${finding.path}${finding.line === null ? "" : `:${finding.line}`}\n${finding.html_url}\n\n${finding.body}`,
		)
		.join("\n\n");
}
