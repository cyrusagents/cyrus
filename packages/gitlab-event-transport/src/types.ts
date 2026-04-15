/**
 * Types for GitLab event transport
 */

import type { InternalMessage } from "cyrus-core";
import type { FastifyInstance } from "fastify";

/**
 * Verification mode for GitLab webhooks
 * - 'proxy': Use CYRUS_API_KEY Bearer token for authentication (self-hosted via CYHOST)
 * - 'signature': Use X-Gitlab-Token secret token verification (direct webhooks)
 */
export type GitLabVerificationMode = "proxy" | "signature";

/**
 * Configuration for GitLabEventTransport
 */
export interface GitLabEventTransportConfig {
	/** Fastify server instance to mount routes on */
	fastifyServer: FastifyInstance;
	/** Verification mode: 'proxy' or 'signature' */
	verificationMode: GitLabVerificationMode;
	/** Secret for verification (CYRUS_API_KEY for proxy, GITLAB_WEBHOOK_SECRET for signature) */
	secret: string;
	/** Optional IP allowlist for webhook source validation (only used in signature mode) */
	ipAllowlist?: readonly string[];
}

/**
 * Events emitted by GitLabEventTransport
 */
export interface GitLabEventTransportEvents {
	/** Emitted when a GitLab webhook is received and verified (legacy) */
	event: (event: GitLabWebhookEvent) => void;
	/** Emitted when a unified internal message is received */
	message: (message: InternalMessage) => void;
	/** Emitted when an error occurs */
	error: (error: Error) => void;
}

/**
 * Processed GitLab webhook event that is emitted to listeners
 */
export interface GitLabWebhookEvent {
	/** The GitLab event type */
	eventType: GitLabEventType;
	/** The full GitLab webhook payload */
	payload: GitLabNotePayload | GitLabMergeRequestPayload;
	/** GitLab access token forwarded from CYHOST */
	accessToken?: string;
}

/**
 * Supported GitLab webhook event types
 */
export type GitLabEventType = "note" | "merge_request";

// ============================================================================
// GitLab Webhook Payload Types
// ============================================================================
// Based on GitLab webhook documentation:
// - Note events: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#comment-events
// - Merge request events: https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#merge-request-events

/**
 * GitLab user object (minimal)
 */
export interface GitLabUser {
	id: number;
	name: string;
	username: string;
	avatar_url: string;
	email?: string;
}

/**
 * GitLab project object
 */
export interface GitLabProject {
	id: number;
	name: string;
	description: string | null;
	web_url: string;
	git_ssh_url: string;
	git_http_url: string;
	namespace: string;
	path_with_namespace: string;
	default_branch: string;
	homepage: string;
	url: string;
	ssh_url: string;
	http_url: string;
}

/**
 * GitLab merge request object (as embedded in webhook payloads)
 */
export interface GitLabMergeRequest {
	id: number;
	iid: number;
	title: string;
	description: string | null;
	state: string;
	url: string;
	source_branch: string;
	target_branch: string;
	source_project_id: number;
	target_project_id: number;
	author_id: number;
	assignee_id: number | null;
	created_at: string;
	updated_at: string;
	action?: string;
}

/**
 * GitLab note (comment) object attributes
 */
export interface GitLabNoteAttributes {
	id: number;
	note: string;
	noteable_type: "MergeRequest" | "Issue" | "Snippet" | "Commit";
	author_id: number;
	created_at: string;
	updated_at: string;
	project_id: number;
	url: string;
	type: string | null;
	description?: string;
	/** Discussion ID for threaded notes */
	discussion_id?: string;
	/** For diff notes: position data */
	position?: {
		base_sha: string;
		start_sha: string;
		head_sha: string;
		old_path: string;
		new_path: string;
		position_type: string;
		old_line: number | null;
		new_line: number | null;
	};
}

/**
 * Payload for note (comment) webhook events
 * @see https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#comment-events
 */
export interface GitLabNotePayload {
	object_kind: "note";
	event_type: "note";
	user: GitLabUser;
	project: GitLabProject;
	object_attributes: GitLabNoteAttributes;
	/** Present when the note is on a merge request */
	merge_request?: GitLabMergeRequest;
	/** Repository info */
	repository?: {
		name: string;
		url: string;
		description: string | null;
		homepage: string;
	};
}

/**
 * Merge request object_attributes in webhook payload
 */
export interface GitLabMergeRequestAttributes extends GitLabMergeRequest {
	action: string;
}

/**
 * Payload for merge_request webhook events
 * @see https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#merge-request-events
 */
export interface GitLabMergeRequestPayload {
	object_kind: "merge_request";
	event_type: "merge_request";
	user: GitLabUser;
	project: GitLabProject;
	object_attributes: GitLabMergeRequestAttributes;
	/** Repository info */
	repository?: {
		name: string;
		url: string;
		description: string | null;
		homepage: string;
	};
}
