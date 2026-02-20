/**
 * Shared test fixtures for GitHub event transport tests
 */
import type {
	GitHubComment,
	GitHubIssue,
	GitHubIssueCommentPayload,
	GitHubPullRequest,
	GitHubPullRequestReviewCommentPayload,
	GitHubRepository,
	GitHubUser,
	GitHubWebhookEvent,
} from "../src/types.js";

export const testUser: GitHubUser = {
	login: "testuser",
	id: 12345,
	avatar_url: "https://avatars.githubusercontent.com/u/12345",
	html_url: "https://github.com/testuser",
	type: "User",
};

export const testRepository: GitHubRepository = {
	id: 67890,
	name: "my-repo",
	full_name: "testorg/my-repo",
	html_url: "https://github.com/testorg/my-repo",
	clone_url: "https://github.com/testorg/my-repo.git",
	ssh_url: "git@github.com:testorg/my-repo.git",
	default_branch: "main",
	owner: {
		login: "testorg",
		id: 11111,
		avatar_url: "https://avatars.githubusercontent.com/u/11111",
		html_url: "https://github.com/testorg",
		type: "Organization",
	},
};

export const testComment: GitHubComment = {
	id: 999,
	body: "@cyrusagent Please fix the failing tests",
	html_url: "https://github.com/testorg/my-repo/pull/42#issuecomment-999",
	url: "https://api.github.com/repos/testorg/my-repo/issues/comments/999",
	user: testUser,
	created_at: "2025-01-15T10:30:00Z",
	updated_at: "2025-01-15T10:30:00Z",
};

export const testReviewComment: GitHubComment = {
	id: 888,
	body: "@cyrusagent This function needs better error handling",
	html_url: "https://github.com/testorg/my-repo/pull/42#discussion_r888",
	url: "https://api.github.com/repos/testorg/my-repo/pulls/comments/888",
	user: testUser,
	created_at: "2025-01-15T10:30:00Z",
	updated_at: "2025-01-15T10:30:00Z",
	path: "src/index.ts",
	diff_hunk: "@@ -10,3 +10,5 @@ function foo() {",
	commit_id: "abc123def456",
};

export const testIssue: GitHubIssue = {
	id: 42001,
	number: 42,
	title: "Fix failing tests",
	body: "Some tests are failing in CI",
	state: "open",
	html_url: "https://github.com/testorg/my-repo/pull/42",
	url: "https://api.github.com/repos/testorg/my-repo/issues/42",
	user: testUser,
	pull_request: {
		url: "https://api.github.com/repos/testorg/my-repo/pulls/42",
		html_url: "https://github.com/testorg/my-repo/pull/42",
		diff_url: "https://github.com/testorg/my-repo/pull/42.diff",
		patch_url: "https://github.com/testorg/my-repo/pull/42.patch",
	},
};

export const testPlainIssue: GitHubIssue = {
	id: 43001,
	number: 43,
	title: "A plain issue (not a PR)",
	body: "This is a regular issue, not a pull request",
	state: "open",
	html_url: "https://github.com/testorg/my-repo/issues/43",
	url: "https://api.github.com/repos/testorg/my-repo/issues/43",
	user: testUser,
	// No pull_request field => this is a plain issue
};

export const testPullRequest: GitHubPullRequest = {
	id: 42002,
	number: 42,
	title: "Fix failing tests",
	body: "Fixes test failures in CI",
	state: "open",
	html_url: "https://github.com/testorg/my-repo/pull/42",
	url: "https://api.github.com/repos/testorg/my-repo/pulls/42",
	head: {
		label: "testuser:fix-tests",
		ref: "fix-tests",
		sha: "abc123",
		repo: testRepository,
	},
	base: {
		label: "testorg:main",
		ref: "main",
		sha: "def456",
		repo: testRepository,
	},
	user: testUser,
};

export const issueCommentPayload: GitHubIssueCommentPayload = {
	action: "created",
	issue: testIssue,
	comment: testComment,
	repository: testRepository,
	sender: testUser,
	installation: { id: 55555, node_id: "MDIzOk" },
};

export const prReviewCommentPayload: GitHubPullRequestReviewCommentPayload = {
	action: "created",
	comment: testReviewComment,
	pull_request: testPullRequest,
	repository: testRepository,
	sender: testUser,
	installation: { id: 55555, node_id: "MDIzOk" },
};

export const issueCommentEvent: GitHubWebhookEvent = {
	eventType: "issue_comment",
	deliveryId: "delivery-001",
	payload: issueCommentPayload,
};

export const prReviewCommentEvent: GitHubWebhookEvent = {
	eventType: "pull_request_review_comment",
	deliveryId: "delivery-002",
	payload: prReviewCommentPayload,
};

/**
 * Create an issue_comment event on a plain issue (not a PR)
 */
export const plainIssueCommentEvent: GitHubWebhookEvent = {
	eventType: "issue_comment",
	deliveryId: "delivery-003",
	payload: {
		action: "created",
		issue: testPlainIssue,
		comment: testComment,
		repository: testRepository,
		sender: testUser,
	},
};
