import type { EdgeConfig } from "miko-core";

/**
 * Linear credentials obtained from OAuth flow
 */
export interface LinearCredentials {
	linearToken: string;
	linearWorkspaceId: string;
	linearWorkspaceName: string;
}

/**
 * Workspace information for issue processing
 */
export interface Workspace {
	path: string;
	isGitWorktree: boolean;
}

/**
 * Re-export EdgeConfig from miko-core for convenience
 */
export type { EdgeConfig };
