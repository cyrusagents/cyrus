/**
 * GitLab Message Translator
 *
 * Translates GitLab webhook events into unified internal messages for the
 * internal message bus.
 *
 * @module gitlab-event-transport/GitLabMessageTranslator
 */

import { randomUUID } from "node:crypto";
import type {
	GitLabPlatformRef,
	GitLabSessionStartPlatformData,
	GitLabUserPromptPlatformData,
	IMessageTranslator,
	SessionStartMessage,
	TranslationContext,
	TranslationResult,
	UserPromptMessage,
} from "atmiko-core";
import type {
	GitLabMergeRequestPayload,
	GitLabNotePayload,
	GitLabWebhookEvent,
} from "./types.js";

/**
 * Translates GitLab webhook events into internal messages.
 *
 * Note: GitLab webhooks can result in either:
 * - SessionStartMessage: First mention/comment that starts a session
 * - UserPromptMessage: Follow-up comments in an existing session
 *
 * The distinction between session start vs user prompt is determined by
 * the EdgeWorker based on whether an active session exists for the MR.
 */
export class GitLabMessageTranslator
	implements IMessageTranslator<GitLabWebhookEvent>
{
	/**
	 * Check if this translator can handle the given event.
	 */
	canTranslate(event: unknown): event is GitLabWebhookEvent {
		if (!event || typeof event !== "object") {
			return false;
		}

		const e = event as Record<string, unknown>;

		return (
			typeof e.eventType === "string" &&
			(e.eventType === "note" || e.eventType === "merge_request") &&
			e.payload !== null &&
			typeof e.payload === "object"
		);
	}

	/**
	 * Translate a GitLab webhook event into an internal message.
	 *
	 * By default, creates a SessionStartMessage. The EdgeWorker will
	 * determine if this should actually be a UserPromptMessage based
	 * on whether an active session exists.
	 */
	translate(
		event: GitLabWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "note") {
			return this.translateNote(event, context);
		}

		if (event.eventType === "merge_request") {
			return this.translateMergeRequest(event, context);
		}

		return {
			success: false,
			reason: `Unsupported GitLab event type: ${event.eventType}`,
		};
	}

	/**
	 * Translate note event to SessionStartMessage.
	 */
	private translateNote(
		event: GitLabWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitLabNotePayload;
		const { project, user, object_attributes, merge_request } = payload;

		if (!merge_request) {
			return {
				success: false,
				reason: "Note is not on a merge request",
			};
		}

		const organizationId = context?.organizationId || String(project.id);

		const sessionKey = `${project.path_with_namespace}!${merge_request.iid}`;
		const workItemIdentifier = `${project.path_with_namespace}!${merge_request.iid}`;

		const platformData: GitLabSessionStartPlatformData = {
			eventType: event.eventType,
			project: this.buildProjectRef(project),
			mergeRequest: this.buildMergeRequestRef(merge_request, project),
			note: this.buildNoteRef(object_attributes, user),
			accessToken: event.accessToken,
		};

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "gitlab",
			action: "session_start",
			receivedAt: object_attributes.created_at,
			organizationId,
			sessionKey,
			workItemId: String(merge_request.id),
			workItemIdentifier,
			author: {
				id: String(user.id),
				name: user.username,
				avatarUrl: user.avatar_url,
			},
			initialPrompt: object_attributes.note,
			title: merge_request.title,
			description: merge_request.description ?? undefined,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Translate merge_request event to SessionStartMessage.
	 */
	private translateMergeRequest(
		event: GitLabWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitLabMergeRequestPayload;
		const { project, user, object_attributes } = payload;

		const organizationId = context?.organizationId || String(project.id);

		const sessionKey = `${project.path_with_namespace}!${object_attributes.iid}`;
		const workItemIdentifier = `${project.path_with_namespace}!${object_attributes.iid}`;

		const platformData: GitLabSessionStartPlatformData = {
			eventType: event.eventType,
			project: this.buildProjectRef(project),
			mergeRequest: this.buildMergeRequestRefFromAttributes(
				object_attributes,
				project,
			),
			note: {
				id: 0,
				body: `MR action: ${object_attributes.action}`,
				noteableType: "MergeRequest",
				author: {
					username: user.username,
					id: user.id,
					avatarUrl: user.avatar_url,
				},
				createdAt: object_attributes.updated_at,
			},
			accessToken: event.accessToken,
		};

		const message: SessionStartMessage = {
			id: randomUUID(),
			source: "gitlab",
			action: "session_start",
			receivedAt: object_attributes.updated_at,
			organizationId,
			sessionKey,
			workItemId: String(object_attributes.id),
			workItemIdentifier,
			author: {
				id: String(user.id),
				name: user.username,
				avatarUrl: user.avatar_url,
			},
			initialPrompt: `MR ${object_attributes.action}: ${object_attributes.title}`,
			title: object_attributes.title,
			description: object_attributes.description ?? undefined,
			platformData,
		};

		return { success: true, message };
	}

	/**
	 * Create a UserPromptMessage from a GitLab event.
	 * This is called by EdgeWorker when it determines the message
	 * is a follow-up to an existing session.
	 */
	translateAsUserPrompt(
		event: GitLabWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		if (event.eventType === "note") {
			return this.translateNoteAsUserPrompt(event, context);
		}

		return {
			success: false,
			reason: `Unsupported GitLab event type for user prompt: ${event.eventType}`,
		};
	}

	/**
	 * Translate note as UserPromptMessage.
	 */
	private translateNoteAsUserPrompt(
		event: GitLabWebhookEvent,
		context?: TranslationContext,
	): TranslationResult {
		const payload = event.payload as GitLabNotePayload;
		const { project, user, object_attributes, merge_request } = payload;

		if (!merge_request) {
			return {
				success: false,
				reason: "Note is not on a merge request",
			};
		}

		const organizationId = context?.organizationId || String(project.id);

		const sessionKey = `${project.path_with_namespace}!${merge_request.iid}`;

		const platformData: GitLabUserPromptPlatformData = {
			eventType: event.eventType,
			project: this.buildProjectRef(project),
			note: this.buildNoteRef(object_attributes, user),
			accessToken: event.accessToken,
		};

		const message: UserPromptMessage = {
			id: randomUUID(),
			source: "gitlab",
			action: "user_prompt",
			receivedAt: object_attributes.created_at,
			organizationId,
			sessionKey,
			workItemId: String(merge_request.id),
			workItemIdentifier: `${project.path_with_namespace}!${merge_request.iid}`,
			author: {
				id: String(user.id),
				name: user.username,
				avatarUrl: user.avatar_url,
			},
			content: object_attributes.note,
			platformData,
		};

		return { success: true, message };
	}

	// ============================================================================
	// HELPER METHODS
	// ============================================================================

	/**
	 * Build project reference from webhook data.
	 */
	private buildProjectRef(
		project: GitLabNotePayload["project"],
	): GitLabPlatformRef["project"] {
		return {
			id: project.id,
			name: project.name,
			pathWithNamespace: project.path_with_namespace,
			webUrl: project.web_url,
			defaultBranch: project.default_branch,
		};
	}

	/**
	 * Build merge request reference from the embedded MR object in note payloads.
	 */
	private buildMergeRequestRef(
		mr: NonNullable<GitLabNotePayload["merge_request"]>,
		project: GitLabNotePayload["project"],
	): GitLabPlatformRef["mergeRequest"] {
		return {
			id: mr.id,
			iid: mr.iid,
			title: mr.title,
			description: mr.description,
			state: mr.state,
			webUrl: mr.url || `${project.web_url}/-/merge_requests/${mr.iid}`,
			sourceBranch: mr.source_branch,
			targetBranch: mr.target_branch,
			author: {
				username: "", // Not available in embedded MR object
				id: mr.author_id,
			},
		};
	}

	/**
	 * Build merge request reference from merge_request event attributes.
	 */
	private buildMergeRequestRefFromAttributes(
		attrs: GitLabMergeRequestPayload["object_attributes"],
		project: GitLabMergeRequestPayload["project"],
	): GitLabPlatformRef["mergeRequest"] {
		return {
			id: attrs.id,
			iid: attrs.iid,
			title: attrs.title,
			description: attrs.description,
			state: attrs.state,
			webUrl: attrs.url || `${project.web_url}/-/merge_requests/${attrs.iid}`,
			sourceBranch: attrs.source_branch,
			targetBranch: attrs.target_branch,
			author: {
				username: "", // Not directly in attributes; would need user lookup
				id: attrs.author_id,
			},
		};
	}

	/**
	 * Build note reference from webhook data.
	 */
	private buildNoteRef(
		attrs: GitLabNotePayload["object_attributes"],
		user: GitLabNotePayload["user"],
	): GitLabPlatformRef["note"] {
		return {
			id: attrs.id,
			body: attrs.note,
			noteableType: attrs.noteable_type,
			author: {
				username: user.username,
				id: user.id,
				avatarUrl: user.avatar_url,
			},
			createdAt: attrs.created_at,
			position: attrs.position
				? {
						newPath: attrs.position.new_path,
						oldPath: attrs.position.old_path,
						newLine: attrs.position.new_line ?? undefined,
					}
				: undefined,
			discussionId: attrs.discussion_id,
		};
	}
}
