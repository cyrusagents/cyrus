/**
 * Issue Tracker Abstraction Layer
 *
 * This module provides a platform-agnostic interface for issue tracking operations.
 * It decouples the Cyrus codebase from Linear-specific implementations, enabling
 * support for multiple issue tracking platforms (Linear, GitHub, Jira, etc.).
 *
 * @module issue-tracker
 *
 * @example
 * Basic usage:
 * ```typescript
 * import { IIssueTrackerService, Issue, Comment } from '@cyrus/core/issue-tracker';
 *
 * // Use the service interface (implementation provided elsewhere)
 * async function processIssue(service: IIssueTrackerService, issueId: string) {
 *   const issue = await service.fetchIssue(issueId);
 *   const comments = await service.fetchComments(issue.id);
 *   // ... process the issue
 * }
 * ```
 *
 * @example
 * Working with webhook events:
 * ```typescript
 * import {
 *   AgentEvent,
 *   isIssueAssignedEvent,
 *   isNewCommentEvent
 * } from '@cyrus/core/issue-tracker';
 *
 * function handleWebhook(event: AgentEvent) {
 *   if (isIssueAssignedEvent(event)) {
 *     console.log('Issue assigned:', event.notification.issue.identifier);
 *   } else if (isNewCommentEvent(event)) {
 *     console.log('New comment:', event.notification.comment.body);
 *   }
 * }
 * ```
 */

// ============================================================================
// MAIN INTERFACE
// ============================================================================

export type {
	AgentPlanStep,
	AgentPlanStepStatus,
	IIssueTrackerService,
} from "./IIssueTrackerService.js";

// ============================================================================
// EVENT TRANSPORT
// ============================================================================

export type {
	AgentEventTransportConfig,
	AgentEventTransportEvents,
	IAgentEventTransport,
} from "./IAgentEventTransport.js";

// ============================================================================
// CORE TYPES
// ============================================================================

// Explicitly re-export key types for documentation
export type {
	AgentActivityCreateInput,
	AgentActivityPayload,
} from "./types.js";
// Export all types and enums from types.ts
export * from "./types.js";

// ============================================================================
// WEBHOOK EVENT TYPES
// ============================================================================

export type { AgentEvent } from "./AgentEvent.js";
export {
	isAgentSessionCreatedEvent,
	isAgentSessionPromptedEvent,
	isCommentMentionEvent,
	isIssueAssignedEvent,
	isIssueUnassignedEvent,
	isNewCommentEvent,
} from "./AgentEvent.js";

// ============================================================================
// ADAPTERS
// ============================================================================

// CLI adapters for F1 testing framework
export * from "./adapters/index.js";

// Linear adapters have been moved to cyrus-linear-event-transport package
// Import them directly from that package instead of from cyrus-core

// ============================================================================
// MODULE METADATA
// ============================================================================

/**
 * Version of the issue tracker abstraction layer.
 */
export const VERSION = "1.0.0";

/**
 * Supported platform types.
 */
export const SUPPORTED_PLATFORMS = ["linear", "cli"] as const;

/**
 * Type for supported platform identifiers.
 */
export type SupportedPlatform = (typeof SUPPORTED_PLATFORMS)[number];
