/**
 * Types for GitHub event transport
 */

import type { InternalMessage } from "cyrus-core";
import type { FastifyInstance } from "fastify";

/**
 * Verification mode for GitHub webhooks forwarded from CYHOST
 * - 'proxy': Use CYRUS_API_KEY Bearer token for authentication (self-hosted)
 * - 'signature': Use x-hub-signature-256 GitHub HMAC-SHA256 signature verification (cloud)
 */
export type GitHubVerificationMode = "proxy" | "signature";

/**
 * Configuration for GitHubEventTransport
 */
export interface GitHubEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'proxy' or 'signature' */
	verificationMode: GitHubVerificationMode;
	/** Secret for verification (CYRUS_API_KEY for proxy, GITHUB_WEBHOOK_SECRET for signature) */
	secret: string;
}

/**
 * Events emitted by GitHubEventTransport
 */
export interface GitHubEventTransportEvents {
	/** Emitted when a GitHub webhook is received and verified (legacy) */
	event: (event: GitHubWebhookEvent) => void;
	/** Emitted when a unified internal message is received */
	message: (message: InternalMessage) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}

/**
 * Processed GitHub webhook event that is emitted to listeners
 */
export interface GitHubWebhookEvent {
	/** The GitHub event type (e.g., 'issue_comment', 'pull_request_review_comment') */
	eventType: GitHubEventType;
	/** Unique webhook delivery ID */
	deliveryId: string;
	/** The full GitHub webhook payload */
	payload: GitHubIssueCommentPayload | GitHubPullRequestReviewCommentPayload;
	/** GitHub installation token forwarded from CYHOST (1-hour expiry) */
	installationToken?: string;
}

/**
 * Supported GitHub webhook event types
 */
export type GitHubEventType = "issue_comment" | "pull_request_review_comment";

// ============================================================================
// GitHub Webhook Payload Types
// ============================================================================
// Based on GitHub's webhook documentation:
// - issue_comment: https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment
// - pull_request_review_comment: https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_comment

/**
 * GitHub user object (minimal)
 */
export interface GitHubUser {
	login: string;
	id: number;
	avatar_url: string;
	html_url: string;
	type: string;
}

/**
 * GitHub repository object (minimal)
 */
export interface GitHubRepository {
	id: number;
	name: string;
	full_name: string;
	html_url: string;
	clone_url: string;
	ssh_url: string;
	default_branch: string;
	owner: GitHubUser;
}

/**
 * GitHub PR reference (head/base)
 */
export interface GitHubPullRequestRef {
	label: string;
	ref: string;
	sha: string;
	repo: GitHubRepository;
}

/**
 * GitHub Pull Request object (minimal, used in issue_comment context)
 */
export interface GitHubPullRequestMinimal {
	url: string;
	html_url: string;
	diff_url: string;
	patch_url: string;
}

/**
 * GitHub Pull Request object (full, used in pull_request_review_comment context)
 */
export interface GitHubPullRequest {
	id: number;
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	url: string;
	head: GitHubPullRequestRef;
	base: GitHubPullRequestRef;
	user: GitHubUser;
}

/**
 * GitHub Issue object (used in issue_comment webhook)
 */
export interface GitHubIssue {
	id: number;
	number: number;
	title: string;
	body: string | null;
	state: string;
	html_url: string;
	url: string;
	user: GitHubUser;
	/** Present when the issue is a PR */
	pull_request?: GitHubPullRequestMinimal;
}

/**
 * GitHub comment object
 */
export interface GitHubComment {
	id: number;
	body: string;
	html_url: string;
	url: string;
	user: GitHubUser;
	created_at: string;
	updated_at: string;
	/** For PR review comments: the file path being commented on */
	path?: string;
	/** For PR review comments: the diff hunk */
	diff_hunk?: string;
	/** For PR review comments: the commit being commented on */
	commit_id?: string;
}

/**
 * GitHub installation object (for GitHub App)
 */
export interface GitHubInstallation {
	id: number;
	node_id: string;
}

/**
 * Payload for issue_comment webhook events
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#issue_comment
 */
export interface GitHubIssueCommentPayload {
	action: "created" | "edited" | "deleted";
	issue: GitHubIssue;
	comment: GitHubComment;
	repository: GitHubRepository;
	sender: GitHubUser;
	installation?: GitHubInstallation;
}

/**
 * Payload for pull_request_review_comment webhook events
 * @see https://docs.github.com/en/webhooks/webhook-events-and-payloads#pull_request_review_comment
 */
export interface GitHubPullRequestReviewCommentPayload {
	action: "created" | "edited" | "deleted";
	comment: GitHubComment;
	pull_request: GitHubPullRequest;
	repository: GitHubRepository;
	sender: GitHubUser;
	installation?: GitHubInstallation;
}
