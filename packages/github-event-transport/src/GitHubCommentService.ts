/**
 * Service for posting comments back to GitHub PR conversations.
 *
 * Uses the GitHub REST API with an installation access token
 * to post replies on PR issue comments and PR review comments.
 */

export interface GitHubCommentServiceConfig {
	/** GitHub API base URL (default: https://api.github.com) */
	apiBaseUrl?: string;
}

/**
 * Parameters for posting a reply to a GitHub PR comment
 */
export interface PostCommentParams {
	/** GitHub installation access token */
	token: string;
	/** Repository owner */
	owner: string;
	/** Repository name */
	repo: string;
	/** PR/Issue number */
	issueNumber: number;
	/** Comment body (markdown) */
	body: string;
	/** Link to the triggering comment/review; issue comments have no native reply API. */
	replyToUrl?: string;
}

/**
 * Parameters for posting a reply to a PR review comment
 */
export interface PostReviewCommentReplyParams {
	/** GitHub installation access token */
	token: string;
	/** Repository owner */
	owner: string;
	/** Repository name */
	repo: string;
	/** Pull request number */
	pullNumber: number;
	/** The ID of the review comment to reply to */
	commentId: number;
	/** Reply body (markdown) */
	body: string;
}

/**
 * Response from GitHub API after creating a comment
 */
export interface GitHubCommentResponse {
	id: number;
	html_url: string;
	body: string;
}

/**
 * Parameters for adding a reaction to a GitHub comment
 */
export interface AddReactionParams {
	/** GitHub installation access token */
	token: string;
	/** Repository owner */
	owner: string;
	/** Repository name */
	repo: string;
	/** The ID of the comment to react to */
	commentId: number;
	/** Whether this is a PR review comment (vs an issue comment) */
	isPullRequestReviewComment: boolean;
	/** Reaction content (e.g. "eyes", "+1", "heart") */
	content: string;
}

export type DeleteReactionParams = Omit<AddReactionParams, "content"> & {
	reactionId: number;
};

export interface ReviewResolutionParams {
	token: string;
	owner: string;
	repo: string;
	pullNumber: number;
	reviewId: number;
}

/**
 * Parameters for checking a user's repository permission level.
 */
export interface CollaboratorPermissionParams {
	/** GitHub installation access token */
	token: string;
	/** Repository owner */
	owner: string;
	/** Repository name */
	repo: string;
	/** GitHub login of the user to check */
	username: string;
}

/**
 * Result of a collaborator write-access check.
 */
export type CollaboratorPermissionResult =
	| { allowed: true; permission: string }
	| { allowed: false; permission: string | null; reason: string };

/** Legacy permission values that grant push (write) or higher. */
const WRITE_OR_HIGHER = new Set(["admin", "maintain", "write"]);

type ReviewThreadsResponse = {
	data?: {
		repository?: {
			pullRequest?: {
				reviewThreads: {
					pageInfo: { hasNextPage: boolean; endCursor: string | null };
					nodes: Array<{
						isResolved: boolean;
						comments: {
							nodes: Array<{ pullRequestReview?: { id: string } | null }>;
						};
					}>;
				};
			};
		};
	};
	errors?: Array<{ message: string }>;
};

export class GitHubCommentService {
	private apiBaseUrl: string;

	constructor(config?: GitHubCommentServiceConfig) {
		this.apiBaseUrl = config?.apiBaseUrl ?? "https://api.github.com";
	}

	/**
	 * A queued Codex notification can become obsolete while another task runs.
	 * Verify the exact review and every page of its threads before skipping it.
	 */
	async isReviewFullyResolved(
		params: ReviewResolutionParams,
	): Promise<boolean> {
		const { token, owner, repo, pullNumber, reviewId } = params;
		const headers = {
			Authorization: `Bearer ${token}`,
			Accept: "application/vnd.github+json",
			"Content-Type": "application/json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		const reviewResponse = await fetch(
			`${this.apiBaseUrl}/repos/${owner}/${repo}/pulls/${pullNumber}/reviews/${reviewId}`,
			{ headers, signal: AbortSignal.timeout(10_000) },
		);
		if (!reviewResponse.ok)
			throw new Error(`Cannot read GitHub review: ${reviewResponse.status}`);
		const review = (await reviewResponse.json()) as {
			node_id?: string;
			user?: { login?: string };
			state?: string;
		};
		if (
			!review.node_id ||
			review.user?.login?.replace(/\[bot\]$/i, "").toLowerCase() !==
				"chatgpt-codex-connector" ||
			review.state?.toUpperCase() !== "COMMENTED"
		)
			return false;
		const base = this.apiBaseUrl.replace(/\/$/, "");
		const graphqlUrl = base.endsWith("/api/v3")
			? `${base.slice(0, -7)}/api/graphql`
			: `${base}/graphql`;
		const query = `query ($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
			repository(owner: $owner, name: $repo) {
				pullRequest(number: $number) {
					reviewThreads(first: 100, after: $cursor) {
						pageInfo { hasNextPage endCursor }
						nodes { isResolved comments(first: 1) { nodes { pullRequestReview { id } } } }
					}
				}
			}
		}`;
		let cursor: string | null = null;
		const seenCursors = new Set<string>();
		let matched = 0;
		for (;;) {
			const response = await fetch(graphqlUrl, {
				method: "POST",
				headers,
				body: JSON.stringify({
					query,
					variables: { owner, repo, number: pullNumber, cursor },
				}),
				signal: AbortSignal.timeout(10_000),
			});
			if (!response.ok)
				throw new Error(
					`Cannot read GitHub review threads: ${response.status}`,
				);
			const page = (await response.json()) as ReviewThreadsResponse;
			if (page.errors?.length)
				throw new Error("GitHub review thread query failed");
			const threads = page.data?.repository?.pullRequest?.reviewThreads;
			if (!threads) return false;
			for (const thread of threads.nodes) {
				const threadReviewId = thread.comments.nodes[0]?.pullRequestReview?.id;
				if (!threadReviewId) return false;
				if (threadReviewId !== review.node_id) continue;
				if (!thread.isResolved) return false;
				matched++;
			}
			if (!threads.pageInfo.hasNextPage) return matched > 0;
			cursor = threads.pageInfo.endCursor;
			if (!cursor || seenCursors.has(cursor))
				throw new Error("Incomplete GitHub review thread pagination");
			seenCursors.add(cursor);
		}
	}

	/**
	 * Post a comment on a PR/Issue (top-level comment).
	 * Used for replying to issue_comment webhooks.
	 *
	 * @see https://docs.github.com/en/rest/issues/comments#create-an-issue-comment
	 */
	async postIssueComment(
		params: PostCommentParams,
	): Promise<GitHubCommentResponse> {
		const { token, owner, repo, issueNumber, replyToUrl } = params;
		const body = replyToUrl
			? `[In reply to this request](${replyToUrl})\n\n${params.body}`
			: params.body;
		const url = `${this.apiBaseUrl}/repos/${owner}/${repo}/issues/${issueNumber}/comments`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({ body }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[GitHubCommentService] Failed to post issue comment: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		return (await response.json()) as GitHubCommentResponse;
	}

	/**
	 * Post a reply to a PR review comment (inline reply).
	 * Used for replying to pull_request_review_comment webhooks.
	 *
	 * @see https://docs.github.com/en/rest/pulls/comments#create-a-reply-for-a-review-comment
	 */
	async postReviewCommentReply(
		params: PostReviewCommentReplyParams,
	): Promise<GitHubCommentResponse> {
		const { token, owner, repo, pullNumber, commentId, body } = params;
		const url = `${this.apiBaseUrl}/repos/${owner}/${repo}/pulls/${pullNumber}/comments/${commentId}/replies`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({ body }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[GitHubCommentService] Failed to post review comment reply: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		return (await response.json()) as GitHubCommentResponse;
	}

	/**
	 * Add a reaction to a comment.
	 *
	 * @see https://docs.github.com/en/rest/reactions/reactions#create-reaction-for-an-issue-comment
	 * @see https://docs.github.com/en/rest/reactions/reactions#create-reaction-for-a-pull-request-review-comment
	 */
	async addReaction(params: AddReactionParams): Promise<number> {
		const {
			token,
			owner,
			repo,
			commentId,
			isPullRequestReviewComment,
			content,
		} = params;

		const segment = isPullRequestReviewComment ? "pulls" : "issues";
		const url = `${this.apiBaseUrl}/repos/${owner}/${repo}/${segment}/comments/${commentId}/reactions`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: "application/vnd.github+json",
				"Content-Type": "application/json",
				"X-GitHub-Api-Version": "2022-11-28",
			},
			body: JSON.stringify({ content }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[GitHubCommentService] Failed to add reaction: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}
		return ((await response.json()) as { id: number }).id;
	}

	/** Remove the exact reaction returned by addReaction, never another user's reaction. */
	async deleteReaction(params: DeleteReactionParams): Promise<void> {
		const {
			token,
			owner,
			repo,
			commentId,
			reactionId,
			isPullRequestReviewComment,
		} = params;
		const segment = isPullRequestReviewComment ? "pulls" : "issues";
		const response = await fetch(
			`${this.apiBaseUrl}/repos/${owner}/${repo}/${segment}/comments/${commentId}/reactions/${reactionId}`,
			{
				method: "DELETE",
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
			},
		);
		if (!response.ok && response.status !== 404) {
			throw new Error(
				`[GitHubCommentService] Failed to delete reaction: ${response.status} ${response.statusText}`,
			);
		}
	}

	/**
	 * Check whether a user has write (push) or higher access on a repository.
	 *
	 * Uses GET /repos/{owner}/{repo}/collaborators/{username}/permission with the
	 * same installation token used for reactions/comments. Treats admin, maintain,
	 * and write (and permissions.push === true) as allowed; 404 / read / none /
	 * triage / API errors as denied.
	 *
	 * @see https://docs.github.com/en/rest/collaborators/collaborators#get-repository-permissions-for-a-user
	 */
	async hasRepoWriteAccess(
		params: CollaboratorPermissionParams,
	): Promise<CollaboratorPermissionResult> {
		const { token, owner, repo, username } = params;
		const url = `${this.apiBaseUrl}/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`;

		let response: Response;
		try {
			response = await fetch(url, {
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/vnd.github+json",
					"X-GitHub-Api-Version": "2022-11-28",
				},
				signal: AbortSignal.timeout(10_000),
			});
		} catch (error) {
			return {
				allowed: false,
				permission: null,
				reason: `request_failed: ${error instanceof Error ? error.message : String(error)}`,
			};
		}

		if (response.status === 404) {
			return {
				allowed: false,
				permission: null,
				reason: "not_a_collaborator",
			};
		}

		if (!response.ok) {
			return {
				allowed: false,
				permission: null,
				reason: `api_error_${response.status}`,
			};
		}

		const data = (await response.json()) as {
			permission?: string;
			role_name?: string;
			permissions?: { push?: boolean };
		};
		const permission = (data.permission ?? "none").toLowerCase();
		const hasPush =
			data.permissions?.push === true || WRITE_OR_HIGHER.has(permission);

		if (hasPush) {
			return { allowed: true, permission };
		}

		return {
			allowed: false,
			permission,
			reason: "insufficient_permission",
		};
	}
}
