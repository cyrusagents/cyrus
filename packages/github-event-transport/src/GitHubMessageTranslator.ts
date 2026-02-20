/**
 * GitHub Message Translator
 *
 * Translates GitHub webhook events into unified internal messages for the
 * internal message bus.
 *
 * @module github-event-transport/GitHubMessageTranslator
 */

import { randomUUID } from "node:crypto";
import type {
	GitHubPlatformRef,
	GitHubSessionStartPlatformData,
	GitHubUserPromptPlatformData,
	IMessageTranslator,
	SessionStartMessage,
	TranslationContext,
	TranslationResult,
	UserPromptMessage,
} from "cyrus-core";
import type {
	GitHubIssueCommentPayload,
	GitHubPullRequestReviewCommentPayload,
	GitHubWebhookEvent,
} from "./types.js";

/**
 * Translates GitHub webhook events into internal messages.
 *
 * Note: GitHub webhooks can result in either:
 * - SessionStartMessage: First mention/comment that starts a session
 * - UserPromptMessage: Follow-up comments in an existing session
 *
 * The distinction between session start vs user prompt is determined by
 * the EdgeWorker based on whether an active session exists for the PR.
 */
export class GitHubMessageTranslator
	implements IMessageTranslator<GitHubWebhookEvent>
{
	/**
	 * Check if this translator can handle the given event.
	 */
	canTranslate(event: unknown): event is GitHubWebhookEvent {
		if (!event || typeof event !== "object") {
			return false;
		}

		const e = event as Record<string, unknown>;

		// GitHub webhook events have eventType, deliveryId, and payload
		return (
			typeof e.eventType === "string" &&
			(e.eventType === "issue_comment" ||
				e.eventType === "pull_request_review_comment") &&
			typeof e.deliveryId === "string" &&
			e.payload !== null &&
			typeof e.payload === "object"
		);
	}

	/**
	 * Translate a GitHub webhook event into an internal message.
	 *
	 * By default, creates a SessionStartMessage. The EdgeWorker will
	 * determine if this should actually be a UserPromptMessage based
	 * on whether an active session exists.
	 */
	translate(
		event: GitHubWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "issue_comment") {
			return this.translateIssueComment(event, context);
		}

		if (event.eventType === "pull_request_review_comment") {
			return this.translatePullRequestReviewComment(event, context);
		}

		return {
			success: false,
			reason: `Unsupported GitHub event type: ${event.eventType}`,
		};
	}

	/**
	 * Translate issue_comment event to SessionStartMessage.
	 */
	private translateIssueComment(
		event: GitHubWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitHubIssueCommentPayload;
		const { issue, comment, repository, sender } = payload;

		// Determine organization ID (use installation ID if available, else repo owner)
		const organizationId =
			context?.organizationId ||
			String(payload.installation?.id || repository.owner.id);

		// Build session key: owner/repo#number
		const sessionKey = `${repository.full_name}#${issue.number}`;

		// Build work item identifier
		const workItemIdentifier = `${repository.full_name}#${issue.number}`;

		// Build platform data
		const platformData: GitHubSessionStartPlatformData = {
			eventType: event.eventType,
			repository: this.buildRepositoryRef(repository),
			issue: this.buildIssueRef(issue),
			pullRequest: issue.pull_request
				? this.buildPullRequestFromIssue(issue, repository)
				: undefined,
			comment: this.buildCommentRef(comment),
			installationToken: event.installationToken,
		};

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "github",
			action: "session_start",
			receivedAt: comment.created_at,
			organizationId,
			sessionKey,
			workItemId: String(issue.id),
			workItemIdentifier,
			author: {
				id: String(sender.id),
				name: sender.login,
				avatarUrl: sender.avatar_url,
			},
			initialPrompt: comment.body,
			title: issue.title,
			description: issue.body ?? undefined,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate pull_request_review_comment event to SessionStartMessage.
	 */
	private translatePullRequestReviewComment(
		event: GitHubWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitHubPullRequestReviewCommentPayload;
		const { pull_request, comment, repository, sender } = payload;

		// Determine organization ID
		const organizationId =
			context?.organizationId ||
			String(payload.installation?.id || repository.owner.id);

		// Build session key: owner/repo#number
		const sessionKey = `${repository.full_name}#${pull_request.number}`;

		// Build work item identifier
		const workItemIdentifier = `${repository.full_name}#${pull_request.number}`;

		// Build platform data
		const platformData: GitHubSessionStartPlatformData = {
			eventType: event.eventType,
			repository: this.buildRepositoryRef(repository),
			pullRequest: this.buildPullRequestRef(pull_request),
			comment: this.buildCommentRef(comment),
			installationToken: event.installationToken,
		};

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "github",
			action: "session_start",
			receivedAt: comment.created_at,
			organizationId,
			sessionKey,
			workItemId: String(pull_request.id),
			workItemIdentifier,
			author: {
				id: String(sender.id),
				name: sender.login,
				avatarUrl: sender.avatar_url,
			},
			initialPrompt: comment.body,
			title: pull_request.title,
			description: pull_request.body ?? undefined,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Create a UserPromptMessage from a GitHub event.
	 * This is called by EdgeWorker when it determines the message
	 * is a follow-up to an existing session.
	 */
	translateAsUserPrompt(
		event: GitHubWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "issue_comment") {
			return this.translateIssueCommentAsUserPrompt(event, context);
		}

		if (event.eventType === "pull_request_review_comment") {
			return this.translatePullRequestReviewCommentAsUserPrompt(event, context);
		}

		return {
			success: false,
			reason: `Unsupported GitHub event type: ${event.eventType}`,
		};
	}

	/**
	 * Translate issue_comment as UserPromptMessage.
	 */
	private translateIssueCommentAsUserPrompt(
		event: GitHubWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitHubIssueCommentPayload;
		const { issue, comment, repository, sender } = payload;

		const organizationId =
			context?.organizationId ||
			String(payload.installation?.id || repository.owner.id);

		const sessionKey = `${repository.full_name}#${issue.number}`;

		const platformData: GitHubUserPromptPlatformData = {
			eventType: event.eventType,
			repository: this.buildRepositoryRef(repository),
			comment: this.buildCommentRef(comment),
			installationToken: event.installationToken,
		};

		const message: UserPromptMessage = {
			id: randomUUID(),
			source: "github",
			action: "user_prompt",
			receivedAt: comment.created_at,
			organizationId,
			sessionKey,
			workItemId: String(issue.id),
			workItemIdentifier: `${repository.full_name}#${issue.number}`,
			author: {
				id: String(sender.id),
				name: sender.login,
				avatarUrl: sender.avatar_url,
			},
			content: comment.body,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate pull_request_review_comment as UserPromptMessage.
	 */
	private translatePullRequestReviewCommentAsUserPrompt(
		event: GitHubWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitHubPullRequestReviewCommentPayload;
		const { pull_request, comment, repository, sender } = payload;

		const organizationId =
			context?.organizationId ||
			String(payload.installation?.id || repository.owner.id);

		const sessionKey = `${repository.full_name}#${pull_request.number}`;

		const platformData: GitHubUserPromptPlatformData = {
			eventType: event.eventType,
			repository: this.buildRepositoryRef(repository),
			comment: this.buildCommentRef(comment),
			installationToken: event.installationToken,
		};

		const message: UserPromptMessage = {
			id: randomUUID(),
			source: "github",
			action: "user_prompt",
			receivedAt: comment.created_at,
			organizationId,
			sessionKey,
			workItemId: String(pull_request.id),
			workItemIdentifier: `${repository.full_name}#${pull_request.number}`,
			author: {
				id: String(sender.id),
				name: sender.login,
				avatarUrl: sender.avatar_url,
			},
			content: comment.body,
			platformData,
		};

		return { success: true, message };
	}

	// ============================================================================
	// HELPER METHODS
	// ============================================================================

	/**
	 * Build repository reference from webhook data.
	 */
	private buildRepositoryRef(
		repo: GitHubIssueCommentPayload["repository"],
	): GitHubPlatformRef["repository"] {
		return {
			id: repo.id,
			name: repo.name,
			fullName: repo.full_name,
			htmlUrl: repo.html_url,
			cloneUrl: repo.clone_url,
			sshUrl: repo.ssh_url,
			defaultBranch: repo.default_branch,
			owner: {
				login: repo.owner.login,
				id: repo.owner.id,
			},
		};
	}

	/**
	 * Build issue reference from webhook data.
	 */
	private buildIssueRef(
		issue: GitHubIssueCommentPayload["issue"],
	): GitHubPlatformRef["issue"] {
		return {
			id: issue.id,
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state,
			htmlUrl: issue.html_url,
			user: {
				login: issue.user.login,
				id: issue.user.id,
			},
			isPullRequest: !!issue.pull_request,
		};
	}

	/**
	 * Build pull request reference from issue data (for issue comments on PRs).
	 */
	private buildPullRequestFromIssue(
		issue: GitHubIssueCommentPayload["issue"],
		_repo: GitHubIssueCommentPayload["repository"],
	): GitHubPlatformRef["pullRequest"] {
		// When we have an issue_comment on a PR, we only have minimal PR data
		// The full PR details are not in the webhook payload
		return {
			id: issue.id,
			number: issue.number,
			title: issue.title,
			body: issue.body,
			state: issue.state,
			htmlUrl: issue.html_url,
			headRef: "", // Not available in issue_comment payload
			headSha: "", // Not available in issue_comment payload
			baseRef: "", // Not available in issue_comment payload
			user: {
				login: issue.user.login,
				id: issue.user.id,
			},
		};
	}

	/**
	 * Build pull request reference from webhook data.
	 */
	private buildPullRequestRef(
		pr: GitHubPullRequestReviewCommentPayload["pull_request"],
	): GitHubPlatformRef["pullRequest"] {
		return {
			id: pr.id,
			number: pr.number,
			title: pr.title,
			body: pr.body,
			state: pr.state,
			htmlUrl: pr.html_url,
			headRef: pr.head.ref,
			headSha: pr.head.sha,
			baseRef: pr.base.ref,
			user: {
				login: pr.user.login,
				id: pr.user.id,
			},
		};
	}

	/**
	 * Build comment reference from webhook data.
	 */
	private buildCommentRef(
		comment: GitHubIssueCommentPayload["comment"],
	): GitHubPlatformRef["comment"] {
		return {
			id: comment.id,
			body: comment.body,
			htmlUrl: comment.html_url,
			user: {
				login: comment.user.login,
				id: comment.user.id,
				avatarUrl: comment.user.avatar_url,
			},
			createdAt: comment.created_at,
			path: comment.path,
			diffHunk: comment.diff_hunk,
		};
	}
}
