/**
 * Internal Message Bus
 *
 * This module exports all types and utilities for the internal message bus
 * that provides a unified interface for handling events from multiple
 * webhook sources (Linear, GitHub, Slack, etc.).
 *
 * @module messages
 */

// Translator interface
export type {
	IMessageTranslator,
	TranslationContext,
	TranslationResult,
} from "./IMessageTranslator.js";

// Platform reference types
export type {
	GitHubPlatformRef,
	LinearPlatformRef,
	SlackPlatformRef,
} from "./platform-refs.js";

// Type guards
export {
	hasGitHubSessionStartPlatformData,
	hasGitHubUserPromptPlatformData,
	hasLinearSessionStartPlatformData,
	hasLinearUserPromptPlatformData,
	hasSlackSessionStartPlatformData,
	hasSlackUserPromptPlatformData,
	isContentUpdateMessage,
	isGitHubMessage,
	isLinearMessage,
	isSessionStartMessage,
	isSlackMessage,
	isStopSignalMessage,
	isUnassignMessage,
	isUserPromptMessage,
} from "./type-guards.js";
// Core message types
export type {
	ContentChanges,
	ContentUpdateMessage,
	GitHubSessionStartPlatformData,
	GitHubUserPromptPlatformData,
	GuidanceItem,
	InternalMessage,
	InternalMessageBase,
	LinearContentUpdatePlatformData,
	// Platform-specific data types
	LinearSessionStartPlatformData,
	LinearStopSignalPlatformData,
	LinearUnassignPlatformData,
	LinearUserPromptPlatformData,
	MessageAction,
	MessageAuthor,
	MessageSource,
	SessionStartMessage,
	// Slack platform data types
	SlackSessionStartPlatformData,
	SlackUserPromptPlatformData,
	StopSignalMessage,
	UnassignMessage,
	UserPromptMessage,
} from "./types.js";
