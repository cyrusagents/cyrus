/**
 * Type Guards for Internal Messages
 *
 * This module provides type guard functions for discriminating between
 * different internal message types based on the `action` field.
 *
 * @module messages/type-guards
 */

import type {
	ContentUpdateMessage,
	GitHubSessionStartPlatformData,
	GitHubUserPromptPlatformData,
	InternalMessage,
	LinearSessionStartPlatformData,
	LinearUserPromptPlatformData,
	SessionStartMessage,
	SlackSessionStartPlatformData,
	SlackUserPromptPlatformData,
	StopSignalMessage,
	UnassignMessage,
	UserPromptMessage,
} from "./types.js";

// ============================================================================
// MESSAGE TYPE GUARDS
// ============================================================================

/**
 * Type guard for SessionStartMessage.
 */
export function isSessionStartMessage(
	message: InternalMessage,
): message is SessionStartMessage {
	return message.action === "session_start";
}

/**
 * Type guard for UserPromptMessage.
 */
export function isUserPromptMessage(
	message: InternalMessage,
): message is UserPromptMessage {
	return message.action === "user_prompt";
}

/**
 * Type guard for StopSignalMessage.
 */
export function isStopSignalMessage(
	message: InternalMessage,
): message is StopSignalMessage {
	return message.action === "stop_signal";
}

/**
 * Type guard for ContentUpdateMessage.
 */
export function isContentUpdateMessage(
	message: InternalMessage,
): message is ContentUpdateMessage {
	return message.action === "content_update";
}

/**
 * Type guard for UnassignMessage.
 */
export function isUnassignMessage(
	message: InternalMessage,
): message is UnassignMessage {
	return message.action === "unassign";
}

// ============================================================================
// SOURCE-SPECIFIC TYPE GUARDS
// ============================================================================

/**
 * Type guard to check if message is from Linear.
 */
export function isLinearMessage(message: InternalMessage): boolean {
	return message.source === "linear";
}

/**
 * Type guard to check if message is from GitHub.
 */
export function isGitHubMessage(message: InternalMessage): boolean {
	return message.source === "github";
}

/**
 * Type guard to check if message is from Slack.
 */
export function isSlackMessage(message: InternalMessage): boolean {
	return message.source === "slack";
}

// ============================================================================
// PLATFORM DATA TYPE GUARDS
// ============================================================================

/**
 * Type guard for Linear platform data in SessionStartMessage.
 */
export function hasLinearSessionStartPlatformData(
	message: SessionStartMessage,
): message is SessionStartMessage & {
	platformData: LinearSessionStartPlatformData;
} {
	return message.source === "linear";
}

/**
 * Type guard for GitHub platform data in SessionStartMessage.
 */
export function hasGitHubSessionStartPlatformData(
	message: SessionStartMessage,
): message is SessionStartMessage & {
	platformData: GitHubSessionStartPlatformData;
} {
	return message.source === "github";
}

/**
 * Type guard for Linear platform data in UserPromptMessage.
 */
export function hasLinearUserPromptPlatformData(
	message: UserPromptMessage,
): message is UserPromptMessage & {
	platformData: LinearUserPromptPlatformData;
} {
	return message.source === "linear";
}

/**
 * Type guard for GitHub platform data in UserPromptMessage.
 */
export function hasGitHubUserPromptPlatformData(
	message: UserPromptMessage,
): message is UserPromptMessage & {
	platformData: GitHubUserPromptPlatformData;
} {
	return message.source === "github";
}

/**
 * Type guard for Slack platform data in SessionStartMessage.
 */
export function hasSlackSessionStartPlatformData(
	message: SessionStartMessage,
): message is SessionStartMessage & {
	platformData: SlackSessionStartPlatformData;
} {
	return message.source === "slack";
}

/**
 * Type guard for Slack platform data in UserPromptMessage.
 */
export function hasSlackUserPromptPlatformData(
	message: UserPromptMessage,
): message is UserPromptMessage & {
	platformData: SlackUserPromptPlatformData;
} {
	return message.source === "slack";
}
