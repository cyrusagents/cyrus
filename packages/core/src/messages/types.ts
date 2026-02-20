/**
 * Internal Message Bus Types
 *
 * This module defines the unified internal message types that all external
 * webhook sources (Linear, GitHub, Slack, etc.) translate to. This enables
 * the EdgeWorker to process events from any platform using a consistent interface.
 *
 * @module messages/types
 */

import type {
	GitHubPlatformRef,
	LinearPlatformRef,
	SlackPlatformRef,
} from "./platform-refs.js";

// ============================================================================
// MESSAGE ACTION TYPES
// ============================================================================

/**
 * Message action discriminator.
 * This is the primary discriminator for the internal message union type.
 */
export type MessageAction =
	| "session_start" // New session (delegation, PR mention, thread start)
	| "user_prompt" // User message during active session
	| "stop_signal" // Stop processing request
	| "content_update" // Issue/PR content changed
	| "unassign"; // Task unassigned from agent

/**
 * Platform source identifier.
 */
export type MessageSource = "linear" | "github" | "slack";

// ============================================================================
// AUTHOR TYPES
// ============================================================================

/**
 * Message author information.
 */
export interface MessageAuthor {
	/** Platform user ID */
	id: string;
	/** Display name */
	name: string;
	/** Email address (if available) */
	email?: string;
	/** Avatar URL (if available) */
	avatarUrl?: string;
}

// ============================================================================
// COMMON BASE MESSAGE
// ============================================================================

/**
 * Common fields shared by all internal messages.
 */
export interface InternalMessageBase {
	/** Unique message ID (generated from webhook delivery ID or UUID) */
	id: string;
	/** Platform source identifier */
	source: MessageSource;
	/** ISO timestamp when the message was received */
	receivedAt: string;
	/** Workspace/organization identifier */
	organizationId: string;
	/**
	 * Session identifier for grouping related messages.
	 * - Linear: agentSession.id
	 * - GitHub: owner/repo#pr (e.g., "ceedaragents/cyrus#123")
	 * - Slack: channel:thread_ts
	 */
	sessionKey: string;
	/** Work item ID (issue ID, PR ID, etc.) */
	workItemId: string;
	/** Human-readable work item identifier (e.g., "DEF-123", "owner/repo#456") */
	workItemIdentifier: string;
	/** Message author */
	author?: MessageAuthor;
}

// ============================================================================
// SESSION START MESSAGE
// ============================================================================

/**
 * Guidance rule attached to a session start.
 */
export interface GuidanceItem {
	/** Guidance rule ID */
	id: string;
	/** Guidance prompt text */
	prompt: string;
}

/**
 * Linear-specific platform data for session start.
 */
export interface LinearSessionStartPlatformData {
	/** Agent session from Linear */
	agentSession: LinearPlatformRef["agentSession"];
	/** Issue data */
	issue: LinearPlatformRef["issue"];
	/** Initiating comment (if any) */
	comment?: LinearPlatformRef["comment"];
	/** Guidance rules */
	guidance?: GuidanceItem[];
	/** Whether this was triggered by an @ mention */
	isMentionTriggered: boolean;
	/** Linear API token for MCP access */
	linearApiToken?: string;
}

/**
 * GitHub-specific platform data for session start.
 */
export interface GitHubSessionStartPlatformData {
	/** The event type that triggered this session */
	eventType: "issue_comment" | "pull_request_review_comment";
	/** Repository information */
	repository: GitHubPlatformRef["repository"];
	/** Pull request information (if available) */
	pullRequest?: GitHubPlatformRef["pullRequest"];
	/** Issue information (for issue comments) */
	issue?: GitHubPlatformRef["issue"];
	/** The comment that triggered this session */
	comment: GitHubPlatformRef["comment"];
	/** GitHub installation token for API access */
	installationToken?: string;
}

/**
 * Slack-specific platform data for session start.
 */
export interface SlackSessionStartPlatformData {
	/** Channel where the mention occurred */
	channel: SlackPlatformRef["channel"];
	/** Thread information */
	thread: SlackPlatformRef["thread"];
	/** The message that triggered this session */
	message: SlackPlatformRef["message"];
	/** Slack Bot token for API access */
	slackBotToken?: string;
}

/**
 * Session start message - initiates a new agent session.
 * Triggered by: Linear delegation, PR mention, thread start, etc.
 */
export interface SessionStartMessage extends InternalMessageBase {
	action: "session_start";
	/** Initial prompt/request content */
	initialPrompt: string;
	/** Issue/PR title */
	title: string;
	/** Issue/PR description/body (if any) */
	description?: string;
	/** Labels attached to the work item */
	labels?: string[];
	/** Platform-specific data preserved for handlers that need it */
	platformData:
		| LinearSessionStartPlatformData
		| GitHubSessionStartPlatformData
		| SlackSessionStartPlatformData;
}

// ============================================================================
// USER PROMPT MESSAGE
// ============================================================================

/**
 * Linear-specific platform data for user prompt.
 */
export interface LinearUserPromptPlatformData {
	/** Agent activity that contains the prompt */
	agentActivity: LinearPlatformRef["agentActivity"];
	/** Agent session reference */
	agentSession: LinearPlatformRef["agentSession"];
}

/**
 * GitHub-specific platform data for user prompt.
 */
export interface GitHubUserPromptPlatformData {
	/** The event type */
	eventType: "issue_comment" | "pull_request_review_comment";
	/** Repository information */
	repository: GitHubPlatformRef["repository"];
	/** The comment containing the prompt */
	comment: GitHubPlatformRef["comment"];
	/** GitHub installation token for API access */
	installationToken?: string;
}

/**
 * Slack-specific platform data for user prompt.
 */
export interface SlackUserPromptPlatformData {
	/** Channel where the message was sent */
	channel: SlackPlatformRef["channel"];
	/** Thread information */
	thread: SlackPlatformRef["thread"];
	/** The message containing the prompt */
	message: SlackPlatformRef["message"];
	/** Slack Bot token for API access */
	slackBotToken?: string;
}

/**
 * User prompt message - a user message during an active session.
 * Triggered by: Mid-session comments, follow-up questions, etc.
 */
export interface UserPromptMessage extends InternalMessageBase {
	action: "user_prompt";
	/** The user's message content */
	content: string;
	/** Platform-specific data */
	platformData:
		| LinearUserPromptPlatformData
		| GitHubUserPromptPlatformData
		| SlackUserPromptPlatformData;
}

// ============================================================================
// STOP SIGNAL MESSAGE
// ============================================================================

/**
 * Linear-specific platform data for stop signal.
 */
export interface LinearStopSignalPlatformData {
	/** Agent activity with the stop signal */
	agentActivity: LinearPlatformRef["agentActivity"];
	/** Agent session reference */
	agentSession: LinearPlatformRef["agentSession"];
}

/**
 * Stop signal message - request to terminate the current session.
 * Triggered by: User clicks "Stop" in Linear, explicit stop command, etc.
 */
export interface StopSignalMessage extends InternalMessageBase {
	action: "stop_signal";
	/** Reason for stopping (if provided) */
	reason?: string;
	/** Platform-specific data */
	platformData: LinearStopSignalPlatformData;
}

// ============================================================================
// CONTENT UPDATE MESSAGE
// ============================================================================

/**
 * Changes detected in the content update.
 */
export interface ContentChanges {
	/** Previous title (if changed) */
	previousTitle?: string;
	/** New title (if changed) */
	newTitle?: string;
	/** Previous description (if changed) */
	previousDescription?: string;
	/** New description (if changed) */
	newDescription?: string;
	/** Whether attachments changed */
	attachmentsChanged?: boolean;
}

/**
 * Linear-specific platform data for content update.
 */
export interface LinearContentUpdatePlatformData {
	/** Issue data */
	issue: LinearPlatformRef["issue"];
	/** The updatedFrom object from the webhook */
	updatedFrom?: Record<string, unknown>;
}

/**
 * Content update message - work item content was modified.
 * Triggered by: Issue title/description edit, PR body edit, etc.
 */
export interface ContentUpdateMessage extends InternalMessageBase {
	action: "content_update";
	/** What changed */
	changes: ContentChanges;
	/** Platform-specific data */
	platformData: LinearContentUpdatePlatformData;
}

// ============================================================================
// UNASSIGN MESSAGE
// ============================================================================

/**
 * Linear-specific platform data for unassign.
 */
export interface LinearUnassignPlatformData {
	/** Issue that was unassigned */
	issue: LinearPlatformRef["issue"];
	/** URL of the issue */
	issueUrl?: string;
}

/**
 * Unassign message - work item was unassigned from the agent.
 * Triggered by: User unassigns issue, removes agent from PR, etc.
 */
export interface UnassignMessage extends InternalMessageBase {
	action: "unassign";
	/** Platform-specific data */
	platformData: LinearUnassignPlatformData;
}

// ============================================================================
// INTERNAL MESSAGE UNION TYPE
// ============================================================================

/**
 * Discriminated union of all internal message types.
 * Use the `action` field as the discriminator.
 */
export type InternalMessage =
	| SessionStartMessage
	| UserPromptMessage
	| StopSignalMessage
	| ContentUpdateMessage
	| UnassignMessage;
