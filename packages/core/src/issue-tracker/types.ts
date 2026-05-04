/**
 * Platform-agnostic types for issue tracking platforms.
 *
 * These types provide simplified interfaces that match Linear SDK GraphQL types structure.
 * Linear SDK is the source of truth - these types are designed to be compatible subsets
 * of Linear's types, omitting implementation-specific fields while maintaining core
 * data structure compatibility.
 *
 * Following the pattern from AgentEvent.ts, we reference Linear SDK types via JSDoc
 * and re-export Linear enums where they exist. This makes Linear the "source of truth"
 * while keeping interfaces manageable.
 *
 * @module issue-tracker/types
 * @see {@link https://linear.app/docs/graphql/api|Linear GraphQL API Documentation}
 */

import type * as LinearSDK from "@linear/sdk";

// ============================================================================
// TYPE ALIASES - Pick-based selections from Linear SDK
// ============================================================================

/**
 * Pagination connection for list results.
 * Based on Linear SDK's Connection pattern with PageInfo.
 * Linear SDK is the source of truth for pagination patterns.
 *
 * @see {@link LinearSDK.LinearDocument.PageInfo} - Linear's PageInfo type
 */
export interface Connection<T> {
	/** Array of items */
	nodes: T[];
	/** Page info for cursor-based pagination (from Linear SDK) */
	pageInfo?: LinearSDK.LinearDocument.PageInfo;
	/** Total count (if available) */
	totalCount?: number;
}

/**
 * Issue type - Combines Pick selections with custom method signatures.
 * Linear SDK is the source of truth - we use Pick for properties and async getters,
 * but override collection methods to use our simplified Connection<T> type instead
 * of Linear SDK's Connection classes (which have private members).
 *
 * This approach eliminates ALL `as unknown as` casts while maintaining
 * full type safety and compatibility with Linear SDK.
 *
 * @see {@link LinearSDK.Issue} - Linear's complete Issue type
 */
export type Issue = Pick<
	LinearSDK.Issue,
	// Properties (14)
	| "id"
	| "identifier"
	| "title"
	| "description"
	| "url"
	| "branchName"
	| "assigneeId"
	| "stateId"
	| "teamId"
	| "labelIds"
	| "priority"
	| "createdAt"
	| "updatedAt"
	| "archivedAt"
	// Async getters (5)
	| "state"
	| "assignee"
	| "team"
	| "parent"
	| "project"
> & {
	// Collection methods with simplified Connection<T> return types
	labels(
		variables?: Omit<LinearSDK.LinearDocument.Issue_LabelsQueryVariables, "id">,
	): Promise<Connection<Label>>;
	comments(
		variables?: Omit<
			LinearSDK.LinearDocument.Issue_CommentsQueryVariables,
			"id"
		>,
	): Promise<Connection<Comment>>;
	attachments(
		variables?: Omit<
			LinearSDK.LinearDocument.Issue_AttachmentsQueryVariables,
			"id"
		>,
	): Promise<Connection<LinearSDK.Attachment>>;
	children(
		variables?: Omit<
			LinearSDK.LinearDocument.Issue_ChildrenQueryVariables,
			"id"
		>,
	): Promise<Connection<Issue>>;
	// Issue relations method for blocked-by/blocks relationships
	inverseRelations(
		variables?: Omit<
			LinearSDK.LinearDocument.Issue_InverseRelationsQueryVariables,
			"id"
		>,
	): Promise<Connection<IssueRelation>>;
	// Update method with simplified IssuePayload return type
	update(
		input?: LinearSDK.LinearDocument.IssueUpdateInput,
	): Promise<IssuePayload>;
};

/**
 * Comment type - Combines Pick selections with custom method signatures.
 * Uses simplified Connection<T> for collection methods.
 *
 * @see {@link LinearSDK.Comment} - Linear's complete Comment type
 */
export type Comment = Pick<
	LinearSDK.Comment,
	// Properties (4)
	| "id"
	| "body"
	| "createdAt"
	| "updatedAt"
	// Async getters (3)
	| "user"
	| "parent"
	| "issue"
> & {
	// Collection methods with simplified Connection<T> return types
	children(
		variables?: LinearSDK.LinearDocument.Comment_ChildrenQueryVariables,
	): Promise<Connection<Comment>>;
};

/**
 * Label type - Selects properties used in the codebase.
 *
 * @see {@link LinearSDK.IssueLabel} - Linear's complete IssueLabel type
 */
export type Label = Pick<
	LinearSDK.IssueLabel,
	"id" | "name" | "description" | "color"
>;

/**
 * IssueRelation type - Represents a relationship between issues.
 * Used for blocked-by/blocks relationships in Graphite stacking workflows.
 *
 * @see {@link LinearSDK.IssueRelation} - Linear's complete IssueRelation type
 */
export type IssueRelation = Pick<
	LinearSDK.IssueRelation,
	"id" | "type" | "createdAt" | "updatedAt" | "archivedAt"
> & {
	/** The issue whose relationship is being described */
	readonly issue: Promise<Issue> | undefined;
	/** The related issue */
	readonly relatedIssue: Promise<Issue> | undefined;
};

/**
 * Team type - Combines Pick selections with custom method signatures.
 * Uses simplified Connection<T> for collection methods.
 *
 * @see {@link LinearSDK.Team} - Linear's complete Team type
 */
export type Team = Pick<
	LinearSDK.Team,
	// Properties (6)
	"id" | "name" | "key" | "description" | "color" | "displayName"
> & {
	// Collection methods with simplified Connection<T> return types
	states(
		variables?: Omit<LinearSDK.LinearDocument.Team_StatesQueryVariables, "id">,
	): Promise<Connection<WorkflowState>>;
	members(
		variables?: Omit<LinearSDK.LinearDocument.Team_MembersQueryVariables, "id">,
	): Promise<Connection<User>>;
};

/**
 * User type - Selects properties used in the codebase.
 *
 * @see {@link LinearSDK.User} - Linear's complete User type
 */
export type User = Pick<
	LinearSDK.User,
	"id" | "name" | "displayName" | "email" | "gitHubUserId" | "url"
>;

/**
 * WorkflowState type - Selects properties used in the codebase.
 *
 * @see {@link LinearSDK.WorkflowState} - Linear's complete WorkflowState type
 */
export type WorkflowState = Pick<
	LinearSDK.WorkflowState,
	"id" | "name" | "type" | "description" | "color" | "position"
>;

// ============================================================================
// FILTER AND PAGINATION OPTIONS
// ============================================================================

/**
 * Filter options for querying entities.
 */
export interface FilterOptions {
	/** Filter by state type */
	state?: {
		type?: {
			eq?: string;
			neq?: string;
			in?: string[];
			nin?: string[];
		};
	};
	/** Filter by archived status */
	archivedAt?: {
		null?: boolean;
	};
	/** Additional platform-specific filters */
	[key: string]: unknown;
}

/**
 * Pagination options for list operations.
 */
export interface PaginationOptions {
	/** Number of items to fetch */
	first?: number;
	/** Cursor for pagination */
	after?: string;
	/** Cursor for reverse pagination */
	before?: string;
	/** Filter criteria */
	filter?: FilterOptions;
}

/**
 * Standard workflow state types across platforms.
 */
export enum WorkflowStateType {
	Triage = "triage",
	Backlog = "backlog",
	Unstarted = "unstarted",
	Started = "started",
	Completed = "completed",
	Canceled = "canceled",
}

/**
 * Issue priority levels (0 = no priority, 1 = urgent, 2 = high, 3 = normal, 4 = low).
 */
export enum IssuePriority {
	NoPriority = 0,
	Urgent = 1,
	High = 2,
	Normal = 3,
	Low = 4,
}

/**
 * Minimal issue representation for lightweight operations.
 */
export interface IssueMinimal {
	/** Unique issue identifier */
	id: string;
	/** Human-readable identifier */
	identifier: string;
	/** Issue title */
	title: string;
	/** Issue URL */
	url: string;
}

/**
 * Issue with child issues included.
 * Note: This extends Issue but overrides the children property from a method to an array.
 */
export interface IssueWithChildren extends Omit<Issue, "children"> {
	/** Child/sub-issues */
	children: Issue[];
	/** Total count of children */
	childCount: number;
}

/**
 * Comment with attachments metadata.
 */
export interface CommentWithAttachments extends Comment {
	/** Attachment information */
	attachments?: Array<{
		id: string;
		url: string;
		filename: string;
		contentType?: string;
		size?: number;
	}>;
}

/**
 * Simplified IssuePayload type for update operations.
 * Uses Pick to select only the essential properties.
 *
 * @see {@link LinearSDK.IssuePayload} - Linear's complete IssuePayload type
 */
export type IssuePayload = Pick<
	LinearSDK.IssuePayload,
	"success" | "issue" | "lastSyncId"
>;

/**
 * Simplified AgentSession type.
 * Uses Pick to select only the properties we actually use.
 * Relationship getters can return undefined for CLI implementation.
 *
 * @see {@link LinearSDK.AgentSession} - Linear's complete AgentSession type
 */
export type AgentSessionSDKType = Pick<
	LinearSDK.AgentSession,
	| "id"
	| "externalLink"
	| "summary"
	| "status"
	| "type"
	| "createdAt"
	| "updatedAt"
	| "archivedAt"
	| "startedAt"
	| "endedAt"
	| "appUserId"
	| "creatorId"
	| "issueId"
	| "commentId"
> & {
	// Relationship async getters - allow undefined for CLI (matches Linear SDK pattern)
	readonly appUser: Promise<User> | undefined;
	readonly creator: Promise<User> | undefined;
	readonly issue: Promise<Issue> | undefined;
	readonly comment: Promise<Comment> | undefined;
	// Collection method with simplified Connection
	activities(
		variables?: Omit<
			LinearSDK.LinearDocument.AgentSession_ActivitiesQueryVariables,
			"id"
		>,
	): Promise<Connection<LinearSDK.AgentActivity>>;
};

/**
 * Simplified AgentSessionPayload type for session creation operations.
 * Uses Pick to select only the essential properties.
 *
 * @see {@link LinearSDK.AgentSessionPayload} - Linear's complete AgentSessionPayload type
 */
export type AgentSessionPayload = Pick<
	LinearSDK.AgentSessionPayload,
	"success" | "lastSyncId"
> & {
	// AgentSession property with our simplified type
	agentSession?: AgentSessionSDKType;
};

/**
 * Type alias for AgentSession used in IIssueTrackerService interface.
 * Uses Pick to avoid private member issues while matching the SDK type structure.
 * Named differently to avoid nominal typing collision with AgentSessionSDKType.
 *
 * Uses Promise for async properties instead of LinearSDK.LinearFetch.
 *
 * @see {@link LinearSDK.AgentSession} - Linear's AgentSession type
 */
export type IssueTrackerAgentSession = Pick<
	LinearSDK.AgentSession,
	| "id"
	| "externalLink"
	| "summary"
	| "status"
	| "type"
	| "createdAt"
	| "updatedAt"
	| "archivedAt"
	| "startedAt"
	| "endedAt"
	| "appUserId"
	| "creatorId"
	| "issueId"
	| "commentId"
> & {
	// Relationship async getters - use Promise instead of LinearFetch
	readonly appUser: Promise<User> | undefined;
	readonly creator: Promise<User> | undefined;
	readonly issue: Promise<Issue> | undefined;
	readonly comment: Promise<Comment> | undefined;
	// Collection method with simplified Connection
	activities(
		variables?: Omit<
			LinearSDK.LinearDocument.AgentSession_ActivitiesQueryVariables,
			"id"
		>,
	): Promise<Connection<LinearSDK.AgentActivity>>;
};

/**
 * Type alias for AgentSessionPayload used in IIssueTrackerService interface.
 * Uses Pick to avoid private member issues while matching the SDK type structure.
 * Named differently to avoid nominal typing collision with AgentSessionPayload.
 *
 * Uses Promise for agentSession instead of LinearSDK.LinearFetch.
 *
 * @see {@link LinearSDK.AgentSessionPayload} - Linear's AgentSessionPayload type
 */
export type IssueTrackerAgentSessionPayload = Pick<
	LinearSDK.AgentSessionPayload,
	"success" | "lastSyncId"
> & {
	// AgentSession property - use Promise instead of LinearFetch
	agentSession?: Promise<IssueTrackerAgentSession>;
};

/**
 * Agent session status enumeration.
 *
 * Re-exported from Linear SDK. Linear SDK is the source of truth.
 * Note: Linear uses "awaitingInput" while we historically used "awaiting-input".
 * We now use Linear's enum directly for consistency.
 *
 * @see {@link LinearSDK.AgentSessionStatus} - Linear's AgentSessionStatus enum
 */
import { AgentSessionStatus } from "@linear/sdk";

export type { AgentSessionStatus as AgentSessionStatusEnum } from "@linear/sdk";
export { AgentSessionStatus };

/**
 * Agent session type/context enumeration.
 *
 * Re-exported from Linear SDK. Linear SDK is the source of truth.
 *
 * @see {@link LinearSDK.AgentSessionType} - Linear's AgentSessionType enum
 */
import { AgentSessionType } from "@linear/sdk";

export type { AgentSessionType as AgentSessionTypeEnum } from "@linear/sdk";
export { AgentSessionType };

/**
 * Agent session webhook payload type.
 * Used for webhook events and type-safe data structures (strict, non-optional fields).
 *
 * @see {@link LinearSDK.LinearDocument.AgentSession}
 */
export type AgentSession = LinearSDK.LinearDocument.AgentSession;

/**
 * Agent session SDK runtime type.
 * Used when working with Linear SDK API responses (has optional getters).
 *
 * @see {@link LinearSDK.AgentSession}
 */
export type AgentSessionSDK = LinearSDK.AgentSession;

/**
 * Agent activity type enumeration.
 *
 * Re-exported from Linear SDK. Linear SDK is the source of truth.
 * This is aliased as AgentActivityContentType for backward compatibility.
 *
 * @see {@link LinearSDK.AgentActivityType} - Linear's AgentActivityType enum
 */
import { AgentActivityType } from "@linear/sdk";

export type { AgentActivityType as AgentActivityTypeEnum } from "@linear/sdk";
export { AgentActivityType };

/**
 * Legacy alias for AgentActivityType.
 * @deprecated Use AgentActivityType instead
 */
export const AgentActivityContentType = AgentActivityType;
export type AgentActivityContentType = AgentActivityType;

/**
 * Agent activity content type.
 * Used for both webhook events and SDK API responses (union type is the same for both).
 *
 * @see {@link LinearSDK.LinearDocument.AgentActivityContent}
 */
export type AgentActivityContent =
	LinearSDK.LinearDocument.AgentActivityContent;

/**
 * Agent activity signal enumeration.
 *
 * Re-exported from Linear SDK. Linear SDK is the source of truth.
 *
 * @see {@link LinearSDK.AgentActivitySignal} - Linear's AgentActivitySignal enum
 */
import { AgentActivitySignal } from "@linear/sdk";

export type { AgentActivitySignal as AgentActivitySignalEnum } from "@linear/sdk";
export { AgentActivitySignal };

/**
 * Agent activity webhook payload type.
 * Used for webhook events and type-safe data structures (strict, non-optional fields).
 *
 * @see {@link LinearSDK.LinearDocument.AgentActivity}
 */
export type AgentActivity = LinearSDK.LinearDocument.AgentActivity;

/**
 * Agent activity SDK runtime type.
 * Used when working with Linear SDK API responses (has optional getters).
 *
 * @see {@link LinearSDK.AgentActivity}
 */
export type AgentActivitySDK = LinearSDK.AgentActivity;

/**
 * Agent activity create input type.
 * Used for creating agent activities - matches Linear SDK's input structure exactly.
 *
 * @see {@link LinearSDK.LinearDocument.AgentActivityCreateInput}
 */
export type AgentActivityCreateInput =
	LinearSDK.LinearDocument.AgentActivityCreateInput;

/**
 * Agent activity payload type.
 * Returned from createAgentActivity mutation - contains success status and created activity.
 *
 * @see {@link LinearSDK.AgentActivityPayload}
 */
export type AgentActivityPayload = LinearSDK.AgentActivityPayload;

/**
 * File upload request parameters.
 */
export interface FileUploadRequest {
	/** MIME type of the file */
	contentType: string;
	/** File name */
	filename: string;
	/** File size in bytes */
	size: number;
	/** Whether to make the file publicly accessible */
	makePublic?: boolean;
}

/**
 * File upload response with URLs and headers.
 */
export interface FileUploadResponse {
	/** URL to upload the file to */
	uploadUrl: string;
	/** Headers to include in the upload request */
	headers: Record<string, string>;
	/** Asset URL to use in content after upload */
	assetUrl: string;
}

/**
 * Agent session creation input for issue-based sessions.
 */
export interface AgentSessionCreateOnIssueInput {
	/** Issue ID or identifier */
	issueId: string;
	/** Optional external link */
	externalLink?: string;
}

/**
 * Agent session creation input for comment-based sessions.
 */
export interface AgentSessionCreateOnCommentInput {
	/** Comment ID */
	commentId: string;
	/** Optional external link */
	externalLink?: string;
}

/**
 * Agent session creation response.
 */
export interface AgentSessionCreateResponse {
	/** Whether the creation was successful */
	success: boolean;
	/** Created agent session ID */
	agentSessionId: string;
	/** Last sync ID */
	lastSyncId: number;
}

/**
 * Issue creation parameters.
 */
export interface IssueCreateInput {
	/** Team ID or key */
	teamId: string;
	/** Issue title */
	title: string;
	/** Issue description */
	description?: string;
	/** Issue priority (0-4) */
	priority?: IssuePriority;
	/** Initial state ID */
	stateId?: string;
	/** Assignee user ID */
	assigneeId?: string;
	/** Parent issue ID (for sub-issues) */
	parentId?: string;
	/** Label IDs to apply */
	labelIds?: string[];
	/** Additional platform-specific fields */
	[key: string]: unknown;
}

/**
 * Issue update parameters.
 */
export interface IssueUpdateInput {
	/** New issue state ID */
	stateId?: string;
	/** New assignee ID */
	assigneeId?: string;
	/** New title */
	title?: string;
	/** New description */
	description?: string;
	/** New priority */
	priority?: IssuePriority;
	/** New parent ID */
	parentId?: string;
	/** Label IDs to set */
	labelIds?: string[];
	/** Additional platform-specific fields */
	[key: string]: unknown;
}

/**
 * Comment creation parameters.
 */
export interface CommentCreateInput {
	/** Comment body/content */
	body: string;
	/** Parent comment ID (for threaded comments) */
	parentId?: string;
	/**
	 * Asset URLs to attach to the comment (Linear-specific).
	 * These URLs should be obtained from `requestFileUpload()` + upload workflow.
	 * The URLs will be automatically embedded in the comment body as markdown images/links.
	 */
	attachmentUrls?: string[];
	/** Additional platform-specific fields */
	[key: string]: unknown;
}

/**
 * Options for fetching child issues.
 */
export interface FetchChildrenOptions {
	/** Maximum number of children to fetch */
	limit?: number;
	/** Whether to include completed children */
	includeCompleted?: boolean;
	/** Whether to include archived children */
	includeArchived?: boolean;
	/** Additional filter options */
	filter?: FilterOptions;
}

/**
 * Platform configuration for authentication.
 */
export interface PlatformConfig {
	/** Platform type identifier */
	type: "linear" | "github" | string;
	/** Authentication token/API key */
	apiToken: string;
	/** User ID on the platform */
	userId?: string;
	/** User email on the platform */
	userEmail?: string;
	/** Organization/workspace ID */
	organizationId?: string;
	/** Additional platform-specific config */
	metadata?: Record<string, unknown>;
}

/**
 * Routing configuration for repository-based routing.
 */
export interface RoutingConfig {
	/** Team keys to route on */
	teamKeys?: string[];
	/** Project keys to route on */
	projectKeys?: string[];
	/** Label names to route on */
	routingLabels?: string[];
	/** Additional platform-specific routing */
	metadata?: Record<string, unknown>;
}

/**
 * Webhook configuration with signature verification.
 */
export interface WebhookConfigWithSignature {
	/** Verification mode */
	verificationMode: "signature";
	/** Webhook secret (for signature verification) */
	secret: string;
	/** Webhook endpoint URL */
	endpointUrl?: string;
	/** Additional platform-specific config */
	metadata?: Record<string, unknown>;
}

/**
 * Webhook configuration with bearer token verification.
 */
export interface WebhookConfigWithBearerToken {
	/** Verification mode */
	verificationMode: "bearerToken";
	/** API key (for bearer token verification) */
	apiKey: string;
	/** Webhook endpoint URL */
	endpointUrl?: string;
	/** Additional platform-specific config */
	metadata?: Record<string, unknown>;
}

/**
 * Webhook configuration - discriminated union based on verification mode.
 */
export type WebhookConfig =
	| WebhookConfigWithSignature
	| WebhookConfigWithBearerToken;

// ============================================================================
// WEBHOOK PAYLOAD TYPES
// ============================================================================
//
// Platform-agnostic webhook type aliases that map to Linear SDK webhook types.
// This maintains the abstraction boundary - EdgeWorker uses the generic names,
// while the Linear SDK provides the actual webhook payload structures.

/**
 * Platform-agnostic webhook issue data type.
 * Maps to Linear SDK's IssueWebhookPayload or IssueWithDescriptionChildWebhookPayload.
 * The Linear SDK uses different payload types in different contexts.
 */
export type WebhookIssue =
	| LinearSDK.LinearDocument.IssueWebhookPayload
	| LinearSDK.LinearDocument.IssueWithDescriptionChildWebhookPayload;

/**
 * Platform-agnostic webhook comment data type.
 * Maps to Linear SDK's CommentWebhookPayload structure.
 */
export type WebhookComment = LinearSDK.LinearDocument.CommentWebhookPayload;

/**
 * Platform-agnostic webhook agent session data type.
 * Maps to Linear SDK's AgentSessionWebhookPayload structure.
 */
export type WebhookAgentSession =
	LinearSDK.LinearDocument.AgentSessionWebhookPayload;

/**
 * Platform-agnostic agent session created webhook payload.
 * Maps to Linear SDK's AgentSessionEventWebhookPayload.
 */
export type AgentSessionCreatedWebhook =
	LinearSDK.LinearDocument.AgentSessionEventWebhookPayload;

/**
 * Platform-agnostic agent session prompted webhook payload.
 * Maps to Linear SDK's AgentSessionEventWebhookPayload.
 */
export type AgentSessionPromptedWebhook =
	LinearSDK.LinearDocument.AgentSessionEventWebhookPayload;

/**
 * Platform-agnostic issue unassigned webhook payload.
 * Maps to Linear SDK's AppUserNotificationWebhookPayload.
 */
export type IssueUnassignedWebhook =
	LinearSDK.LinearDocument.AppUserNotificationWebhookPayload;

/**
 * Platform-agnostic issue update webhook payload.
 * Maps to Linear SDK's EntityWebhookPayload with issue-specific data.
 *
 * This type is used for Issue update webhooks that include:
 * - `type`: "Issue"
 * - `action`: "create" | "update" | "remove"
 * - `data`: IssueWebhookPayload (current issue state)
 * - `updatedFrom`: JSON object with previous values of changed fields
 *
 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload
 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/unions/DataWebhookPayload
 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload
 */
export type IssueUpdateWebhook =
	LinearSDK.LinearDocument.EntityWebhookPayload & {
		type: "Issue";
		action: "update";
		data: LinearSDK.LinearDocument.IssueWebhookPayload;
		/** Previous values of updated properties. Contains `title`, `description`, and/or `attachments` when those fields changed. */
		updatedFrom?: {
			title?: string;
			description?: string;
			/** Serialized JSON of previous attachments state */
			attachments?: unknown;
			[key: string]: unknown;
		};
	};

/**
 * Platform-agnostic issue state change webhook payload.
 * Maps to Linear SDK's AppUserNotificationWebhookPayload with action "issueStatusChanged".
 *
 * Linear sends this as an AppUserNotification when an issue transitions to a
 * terminal state (completed or canceled). The notification contains the issue
 * data via `notification.issue`.
 */
export type IssueStateChangeWebhook =
	LinearSDK.LinearDocument.AppUserNotificationWebhookPayload;

/**
 * Platform-agnostic union of all webhook types.
 * Maps to Linear SDK's webhook payload union types.
 */
export type Webhook =
	| LinearSDK.LinearDocument.AgentSessionEventWebhookPayload
	| LinearSDK.LinearDocument.AppUserNotificationWebhookPayload
	| LinearSDK.LinearDocument.EntityWebhookPayload;

/**
 * Platform-agnostic guidance rule type.
 * Maps to Linear SDK's GuidanceRuleWebhookPayload.
 */
export type GuidanceRule = LinearSDK.LinearDocument.GuidanceRuleWebhookPayload;

/**
 * Type guard to check if webhook is an agent session created event.
 */
export function isAgentSessionCreatedWebhook(
	webhook: Webhook,
): webhook is AgentSessionCreatedWebhook {
	return webhook.type === "AgentSessionEvent" && webhook.action === "created";
}

/**
 * Type guard to check if webhook is an agent session prompted event.
 */
export function isAgentSessionPromptedWebhook(
	webhook: Webhook,
): webhook is AgentSessionPromptedWebhook {
	return webhook.type === "AgentSessionEvent" && webhook.action === "prompted";
}

/**
 * Type guard to check if webhook is an issue assigned notification.
 */
export function isIssueAssignedWebhook(
	webhook: Webhook,
): webhook is LinearSDK.LinearDocument.AppUserNotificationWebhookPayload {
	return (
		webhook.type === "AppUserNotification" &&
		webhook.action === "issueAssignedToYou"
	);
}

/**
 * Type guard to check if webhook is an issue comment mention notification.
 */
export function isIssueCommentMentionWebhook(
	webhook: Webhook,
): webhook is LinearSDK.LinearDocument.AppUserNotificationWebhookPayload {
	return (
		webhook.type === "AppUserNotification" &&
		webhook.action === "issueCommentMention"
	);
}

/**
 * Type guard to check if webhook is an issue new comment notification.
 */
export function isIssueNewCommentWebhook(
	webhook: Webhook,
): webhook is LinearSDK.LinearDocument.AppUserNotificationWebhookPayload {
	return (
		webhook.type === "AppUserNotification" &&
		webhook.action === "issueNewComment"
	);
}

/**
 * Type guard to check if webhook is an issue unassigned notification.
 */
export function isIssueUnassignedWebhook(
	webhook: Webhook,
): webhook is IssueUnassignedWebhook {
	return (
		webhook.type === "AppUserNotification" &&
		webhook.action === "issueUnassignedFromYou"
	);
}

/**
 * Type guard to check if webhook is an issue update with title, description, or attachments changes.
 *
 * This identifies Issue entity webhooks where the `updatedFrom` field contains
 * previous values for `title`, `description`, and/or `attachments` fields, indicating these
 * fields were modified. Other field changes (like status, assignee, etc.) are ignored.
 *
 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/EntityWebhookPayload
 * @see https://studio.apollographql.com/public/Linear-Webhooks/variant/current/schema/reference/objects/IssueWebhookPayload
 */
export function isIssueTitleOrDescriptionUpdateWebhook(
	webhook: Webhook,
): webhook is IssueUpdateWebhook {
	if (webhook.type !== "Issue" || webhook.action !== "update") {
		return false;
	}

	// Check if updatedFrom contains title, description, or attachments changes
	const entityWebhook =
		webhook as LinearSDK.LinearDocument.EntityWebhookPayload;
	const updatedFrom = entityWebhook.updatedFrom as
		| { title?: string; description?: string; attachments?: unknown }
		| undefined;

	if (!updatedFrom) {
		return false;
	}

	// Only return true if title, description, or attachments was changed (not other fields)
	return (
		"title" in updatedFrom ||
		"description" in updatedFrom ||
		"attachments" in updatedFrom
	);
}

/**
 * Type guard to check if webhook is an issue state ID update (e.g., moved to completed/canceled).
 *
 * This identifies Issue entity webhooks where the `updatedFrom` field contains
 * a previous `stateId`, indicating the issue's workflow state was changed.
 * Used to detect when blocking issues are resolved so parked sessions can be woken up.
 */
export function isIssueStateIdUpdateWebhook(
	webhook: Webhook,
): webhook is IssueUpdateWebhook {
	if (webhook.type !== "Issue" || webhook.action !== "update") {
		return false;
	}

	const entityWebhook =
		webhook as LinearSDK.LinearDocument.EntityWebhookPayload;
	const updatedFrom = entityWebhook.updatedFrom as
		| { stateId?: string }
		| undefined;

	if (!updatedFrom) {
		return false;
	}

	return "stateId" in updatedFrom;
}

/**
 * Type guard to check if webhook is an issue status change notification.
 *
 * Linear sends AppUserNotification webhooks with action "issueStatusChanged"
 * when an issue transitions to a terminal state (completed or canceled).
 */
export function isIssueStateChangeWebhook(
	webhook: Webhook,
): webhook is IssueStateChangeWebhook {
	return (
		webhook.type === "AppUserNotification" &&
		webhook.action === "issueStatusChanged"
	);
}

/**
 * Platform-agnostic issue deleted webhook payload.
 * Maps to Linear SDK's EntityWebhookPayload with type "Issue" and action "remove".
 *
 * Linear sends this when an issue is deleted. The `data` field contains
 * the deleted issue's data (id, identifier, title, etc.).
 */
export type IssueDeletedWebhook =
	LinearSDK.LinearDocument.EntityWebhookPayload & {
		type: "Issue";
		action: "remove";
		data: LinearSDK.LinearDocument.IssueWebhookPayload;
	};

/**
 * Type guard to check if webhook is an issue deleted event.
 *
 * Linear sends Issue entity webhooks with action "remove" when an issue is deleted.
 */
export function isIssueDeletedWebhook(
	webhook: Webhook,
): webhook is IssueDeletedWebhook {
	return webhook.type === "Issue" && webhook.action === "remove";
}

/**
 * Generic result type for operations.
 */
export interface OperationResult<T = unknown> {
	/** Whether the operation was successful */
	success: boolean;
	/** Result data */
	data?: T;
	/** Error message if operation failed */
	error?: string;
	/** Additional metadata */
	metadata?: Record<string, unknown>;
}
