/**
 * AgentEvent type alias for webhook event payloads.
 *
 * This module provides a platform-agnostic type alias for webhook events.
 * The implementation uses Linear's webhook payload types, but this is hidden
 * from consuming code through the type alias.
 *
 * @module issue-tracker/AgentEvent
 */

import type { LinearWebhookPayload } from "@linear/sdk/webhooks";

/**
 * Platform-agnostic webhook event type.
 *
 * This type represents webhook events from the issue tracking platform.
 * Currently backed by Linear's webhook payload type, but abstracted for
 * future multi-platform support.
 *
 * @example
 * ```typescript
 * import { AgentEvent } from '@miko/core/issue-tracker';
 *
 * function handleWebhook(event: AgentEvent) {
 *   // Process the webhook event
 *   console.log('Received event:', event.action);
 * }
 * ```
 *
 * @remarks
 * This type alias hides the Linear-specific implementation detail while
 * maintaining full type safety. When adding support for other platforms,
 * this can be converted to a union type or more sophisticated abstraction.
 *
 * @see {@link LinearWebhookPayload} for the underlying Linear type structure
 */
export type AgentEvent = LinearWebhookPayload;

/**
 * Type guard to check if an event is an issue assignment event.
 *
 * @param event - The webhook event to check
 * @returns True if the event is an issue assignment
 *
 * @example
 * ```typescript
 * if (isIssueAssignedEvent(event)) {
 *   console.log('Issue assigned:', event.notification.issue.identifier);
 * }
 * ```
 */
export function isIssueAssignedEvent(
	event: AgentEvent,
): event is Extract<AgentEvent, { action: "issueAssignedToYou" }> {
	return (
		event.type === "AppUserNotification" &&
		event.action === "issueAssignedToYou"
	);
}

/**
 * Type guard to check if an event is an issue unassignment event.
 *
 * @param event - The webhook event to check
 * @returns True if the event is an issue unassignment
 *
 * @example
 * ```typescript
 * if (isIssueUnassignedEvent(event)) {
 *   console.log('Issue unassigned:', event.notification.issue.identifier);
 * }
 * ```
 */
export function isIssueUnassignedEvent(
	event: AgentEvent,
): event is Extract<AgentEvent, { action: "issueUnassignedFromYou" }> {
	return (
		event.type === "AppUserNotification" &&
		event.action === "issueUnassignedFromYou"
	);
}

/**
 * Type guard to check if an event is a comment mention event.
 *
 * @param event - The webhook event to check
 * @returns True if the event is a comment mention
 *
 * @example
 * ```typescript
 * if (isCommentMentionEvent(event)) {
 *   console.log('Mentioned in comment:', event.notification.comment.body);
 * }
 * ```
 */
export function isCommentMentionEvent(
	event: AgentEvent,
): event is Extract<AgentEvent, { action: "issueCommentMention" }> {
	return (
		event.type === "AppUserNotification" &&
		event.action === "issueCommentMention"
	);
}

/**
 * Type guard to check if an event is a new comment event.
 *
 * @param event - The webhook event to check
 * @returns True if the event is a new comment
 *
 * @example
 * ```typescript
 * if (isNewCommentEvent(event)) {
 *   console.log('New comment:', event.notification.comment.body);
 * }
 * ```
 */
export function isNewCommentEvent(
	event: AgentEvent,
): event is Extract<AgentEvent, { action: "issueNewComment" }> {
	return (
		event.type === "AppUserNotification" && event.action === "issueNewComment"
	);
}

/**
 * Type guard to check if an event is an agent session created event.
 *
 * @param event - The webhook event to check
 * @returns True if the event is an agent session creation
 *
 * @example
 * ```typescript
 * if (isAgentSessionCreatedEvent(event)) {
 *   console.log('Agent session created:', event.agentSession.id);
 * }
 * ```
 */
export function isAgentSessionCreatedEvent(
	event: AgentEvent,
): event is Extract<
	AgentEvent,
	{ type: "AgentSessionEvent"; action: "created" }
> {
	return event.type === "AgentSessionEvent" && event.action === "created";
}

/**
 * Type guard to check if an event is an agent session prompted event.
 *
 * @param event - The webhook event to check
 * @returns True if the event is an agent session prompt
 *
 * @example
 * ```typescript
 * if (isAgentSessionPromptedEvent(event)) {
 *   console.log('Agent session prompted:', event.agentActivity.content.body);
 * }
 * ```
 */
export function isAgentSessionPromptedEvent(
	event: AgentEvent,
): event is Extract<
	AgentEvent,
	{ type: "AgentSessionEvent"; action: "prompted" }
> {
	return event.type === "AgentSessionEvent" && event.action === "prompted";
}
