/**
 * Platform-specific Reference Types
 *
 * These types define the platform-specific data structures that are preserved
 * in the platformData field of internal messages. They provide type-safe access
 * to the original webhook payload data when handlers need platform-specific details.
 *
 * @module messages/platform-refs
 */

import type * as LinearSDK from "@linear/sdk";

// ============================================================================
// LINEAR PLATFORM REFERENCES
// ============================================================================

/**
 * Linear platform reference types.
 * These map to Linear SDK types used in webhook payloads.
 */
export interface LinearPlatformRef {
	/** Agent session data from webhook */
	agentSession: {
		/** Session ID */
		id: string;
		/** Session status */
		status: string;
		/** Session type */
		type?: string;
		/** External link */
		externalLink?: string;
		/** Creator ID */
		creatorId?: string;
		/** Comment that triggered the session (if any) */
		comment?: {
			id: string;
			body?: string;
		};
		/** Issue associated with the session */
		issue: LinearPlatformRef["issue"];
	};

	/** Issue data from webhook */
	issue: {
		/** Issue ID */
		id: string;
		/** Human-readable identifier (e.g., "DEF-123") */
		identifier: string;
		/** Issue title */
		title: string;
		/** Issue description */
		description?: string;
		/** Issue URL */
		url: string;
		/** Branch name */
		branchName?: string;
		/** Team associated with the issue */
		team?: {
			id: string;
			name?: string;
			key?: string;
		};
		/** Project associated with the issue */
		project?: {
			id: string;
			name?: string;
			key?: string;
		};
		/** Labels attached to the issue */
		labels?: Array<{
			id: string;
			name: string;
		}>;
	};

	/** Comment data from webhook */
	comment: {
		/** Comment ID */
		id: string;
		/** Comment body */
		body?: string;
		/** Comment author */
		user?: {
			id: string;
			name?: string;
			displayName?: string;
			email?: string;
		};
	};

	/** Agent activity data from webhook */
	agentActivity: {
		/** Activity ID */
		id: string;
		/** Activity type */
		type?: string;
		/** Activity signal (e.g., "stop") */
		signal?: LinearSDK.AgentActivitySignal;
		/** Activity content */
		content?: {
			/** Content type */
			type?: string;
			/** Content body (for user prompts) */
			body?: string;
		};
	};
}

// ============================================================================
// GITHUB PLATFORM REFERENCES
// ============================================================================

/**
 * GitHub platform reference types.
 * These map to GitHub webhook payload structures.
 */
export interface GitHubPlatformRef {
	/** Repository data from webhook */
	repository: {
		/** Repository ID */
		id: number;
		/** Repository name */
		name: string;
		/** Full repository name (owner/repo) */
		fullName: string;
		/** Repository HTML URL */
		htmlUrl: string;
		/** Clone URL */
		cloneUrl: string;
		/** SSH URL */
		sshUrl: string;
		/** Default branch */
		defaultBranch: string;
		/** Repository owner */
		owner: {
			login: string;
			id: number;
		};
	};

	/** Pull request data from webhook */
	pullRequest: {
		/** PR ID */
		id: number;
		/** PR number */
		number: number;
		/** PR title */
		title: string;
		/** PR body */
		body: string | null;
		/** PR state */
		state: string;
		/** PR HTML URL */
		htmlUrl: string;
		/** Head branch ref */
		headRef: string;
		/** Head branch SHA */
		headSha: string;
		/** Base branch ref */
		baseRef: string;
		/** PR author */
		user: {
			login: string;
			id: number;
		};
	};

	/** Issue data from webhook (used for issue comments) */
	issue: {
		/** Issue ID */
		id: number;
		/** Issue number */
		number: number;
		/** Issue title */
		title: string;
		/** Issue body */
		body: string | null;
		/** Issue state */
		state: string;
		/** Issue HTML URL */
		htmlUrl: string;
		/** Issue author */
		user: {
			login: string;
			id: number;
		};
		/** Present when the issue is actually a PR */
		isPullRequest: boolean;
	};

	/** Comment data from webhook */
	comment: {
		/** Comment ID */
		id: number;
		/** Comment body */
		body: string;
		/** Comment HTML URL */
		htmlUrl: string;
		/** Comment author */
		user: {
			login: string;
			id: number;
			avatarUrl: string;
		};
		/** Comment creation timestamp */
		createdAt: string;
		/** For PR review comments: the file path */
		path?: string;
		/** For PR review comments: the diff hunk */
		diffHunk?: string;
	};
}

// ============================================================================
// SLACK PLATFORM REFERENCES (Future)
// ============================================================================

/**
 * Slack platform reference types.
 * Placeholder for future Slack integration.
 */
export interface SlackPlatformRef {
	/** Channel data */
	channel: {
		/** Channel ID */
		id: string;
		/** Channel name */
		name?: string;
	};

	/** Thread data */
	thread: {
		/** Thread timestamp */
		ts: string;
		/** Parent message timestamp */
		parentTs?: string;
	};

	/** Message data */
	message: {
		/** Message timestamp */
		ts: string;
		/** Message text */
		text: string;
		/** Message author */
		user: {
			id: string;
			name?: string;
		};
	};
}
