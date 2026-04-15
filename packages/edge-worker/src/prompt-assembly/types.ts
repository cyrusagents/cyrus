/**
 * Type definitions for the unified prompt assembly system
 *
 * This module provides a clear, testable interface for assembling prompts
 * with well-defined inputs and outputs.
 */

import type {
	BaseBranchResolution,
	CyrusAgentSession,
	GuidanceRule,
	Issue,
	RepositoryConfig,
	WebhookAgentSession,
} from "cyrus-core";

/**
 * Output structure from buildPrompt - contains everything needed to start a Claude session
 */
export interface PromptAssembly {
	/** System prompt for Claude runner configuration (e.g., "builder", "debugger") */
	systemPrompt?: string;

	/** The complete user prompt to send to Claude */
	userPrompt: string;

	/** Metadata about what was assembled (for debugging and testing) */
	metadata: {
		/** List of components included in the prompt */
		components: PromptComponent[];

		/** Type of prompt builder used */
		promptType: PromptType;

		/** Whether this was a new session */
		isNewSession: boolean;

		/** Whether the session is actively streaming */
		isStreaming: boolean;
	};
}

/**
 * Components that can be included in a prompt
 */
export type PromptComponent =
	| "issue-context" // Issue title, description, comments, history
	| "user-comment" // User's comment text
	| "attachment-manifest" // List of attachments
	| "guidance-rules"; // Linear agent guidance rules

/**
 * Type of prompt builder used
 */
export type PromptType =
	| "label-based" // System prompt from labels (builder/debugger/etc)
	| "label-based-prompt-command" // /label-based-prompt command
	| "mention" // @mention triggered
	| "fallback" // Default issue context
	| "continuation"; // Existing session continuation

/**
 * Input structure for buildPrompt - all information needed to assemble a prompt
 */
export interface PromptAssemblyInput {
	// ===== Session Context =====
	/** The Cyrus agent session */
	session: CyrusAgentSession;

	/** Full issue details */
	fullIssue: Issue;

	/** Repository configurations (all repos in the session) */
	repositories: RepositoryConfig[];

	/**
	 * @deprecated Use `repositories` instead. Alias for `repositories[0]`.
	 */
	repository: RepositoryConfig;

	// ===== Prompt Content =====
	/** User's comment text (or empty string for initial assignment) */
	userComment: string;

	/** Author of the comment (for multi-player context) */
	commentAuthor?: string;

	/** Timestamp of the comment (for multi-player context) */
	commentTimestamp?: string;

	/** Attachment manifest string (if any attachments) */
	attachmentManifest?: string;

	/** Linear agent guidance rules */
	guidance?: GuidanceRule[];

	// ===== Control Flags =====
	/** Whether this is a new session (vs continuation) */
	isNewSession: boolean;

	/** Whether the Claude runner is actively streaming */
	isStreaming: boolean;

	/** Whether triggered by @mention */
	isMentionTriggered?: boolean;

	/** Whether /label-based-prompt command was used */
	isLabelBasedPromptRequested?: boolean;

	/** Agent session data (for mention-triggered prompts) */
	agentSession?: WebhookAgentSession;

	/** Labels on the issue (for system prompt determination) */
	labels?: string[];

	/** GitHub username of the issue assignee (resolved from Linear gitHubUserId) */
	assigneeGitHubUsername?: string;

	/** Pre-resolved base branches from workspace creation (keyed by repositoryId) */
	resolvedBaseBranches?: Record<string, BaseBranchResolution>;

	/** Linear workspace ID (from webhook.organizationId). When provided, avoids extracting from repo config. */
	linearWorkspaceId?: string;
}

/**
 * Result from building issue context (intermediate step)
 */
export interface IssueContextResult {
	/** The assembled issue context prompt */
	prompt: string;

	/** Template version (if using versioned templates) */
	version?: string;
}
