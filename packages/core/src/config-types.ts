import { homedir } from "node:os";
import { resolve } from "node:path";
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { Workspace } from "./CyrusAgentSession.js";
// Import types for use in this file
import type { EdgeConfig, RepositoryConfig } from "./config-schemas.js";
import type { Issue } from "./issue-tracker/types.js";

// Re-export schemas and types from config-schemas
export {
	type EdgeConfig,
	type EdgeConfigPayload,
	EdgeConfigPayloadSchema,
	EdgeConfigSchema,
	type LinearWorkspaceConfig,
	LinearWorkspaceConfigSchema,
	type MemoryGateConfig,
	MemoryGateConfigSchema,
	migrateEdgeConfig,
	type NetworkPolicy,
	NetworkPolicySchema,
	type RepositoryConfig,
	type RepositoryConfigPayload,
	RepositoryConfigPayloadSchema,
	RepositoryConfigSchema,
	type RunnerType,
	RunnerTypeSchema,
	requireLinearWorkspaceId,
	type SandboxConfig,
	SandboxConfigSchema,
	type UserAccessControlConfig,
	UserAccessControlConfigSchema,
	type UserIdentifier,
	UserIdentifierSchema,
} from "./config-schemas.js";

export { TRUSTED_DOMAINS } from "./trusted-domains.js";

/**
 * Resolve path with tilde (~) expansion
 * Expands ~ to the user's home directory and resolves to absolute path
 *
 * @param path - Path that may contain ~ prefix (e.g., "~/.cyrus/repos/myrepo")
 * @returns Absolute path with ~ expanded
 *
 * @example
 * resolvePath("~/projects/myapp") // "/home/user/projects/myapp"
 * resolvePath("/absolute/path") // "/absolute/path"
 * resolvePath("relative/path") // "/current/working/dir/relative/path"
 */
export function resolvePath(path: string): string {
	if (path.startsWith("~/")) {
		return resolve(homedir(), path.slice(2));
	}
	return resolve(path);
}

/**
 * OAuth callback handler type
 */
export type OAuthCallbackHandler = (
	token: string,
	workspaceId: string,
	workspaceName: string,
) => Promise<void>;

/**
 * Runtime-only configuration fields for EdgeWorker.
 *
 * These fields are NOT serializable to JSON and are only available at runtime.
 * They include callbacks, handlers, and runtime-specific settings that cannot
 * be persisted to config.json.
 */
export interface EdgeWorkerRuntimeConfig {
	/** Cyrus CLI version (e.g., "1.2.3"), used in /version endpoint */
	version?: string;

	/** Cyrus home directory - required at runtime */
	cyrusHome: string;

	// --- Server/Network Configuration (runtime-specific) ---

	/** Optional proxy URL - defaults to DEFAULT_PROXY_URL for OAuth flows */
	proxyUrl?: string;

	/** Base URL for the server */
	baseUrl?: string;

	/** @deprecated Use baseUrl instead */
	webhookBaseUrl?: string;

	/** @deprecated Use serverPort instead */
	webhookPort?: number;

	/** Unified server port for both webhooks and OAuth callbacks (default: 3456) */
	serverPort?: number;

	/** Server host address ('localhost' or '0.0.0.0', default: 'localhost') */
	serverHost?: string;

	// --- Platform Configuration ---

	/**
	 * Issue tracker platform type (default: "linear")
	 * - "linear": Uses Linear as the issue tracker (default production mode)
	 * - "cli": Uses an in-memory issue tracker for CLI-based testing and development
	 */
	platform?: "linear" | "cli";

	// --- Agent Configuration (for CLI mode) ---

	/** The name/handle the agent responds to (e.g., "john", "cyrus") */
	agentHandle?: string;

	/** The user ID of the agent (for CLI mode) */
	agentUserId?: string;

	// --- Runtime Handlers (non-serializable callbacks) ---

	/**
	 * Optional handlers that apps can implement.
	 * These are callback functions that cannot be serialized to JSON.
	 */
	handlers?: {
		/** Called when workspace needs to be created. Accepts array of repositories for multi-repo workspaces. */
		createWorkspace?: (
			issue: Issue,
			repositories: RepositoryConfig[],
			options?: { baseBranchOverrides?: Map<string, string> },
		) => Promise<Workspace>;

		/** Called with Claude messages (for UI updates, logging, etc). Includes repository ID. */
		onClaudeMessage?: (
			issueId: string,
			message: SDKMessage,
			repositoryId: string,
		) => void;

		/** Called when session starts. Includes repository ID. */
		onSessionStart?: (
			issueId: string,
			issue: Issue,
			repositoryId: string,
		) => void;

		/** Called when session ends. Includes repository ID. */
		onSessionEnd?: (
			issueId: string,
			exitCode: number | null,
			repositoryId: string,
		) => void;

		/** Called on errors */
		onError?: (error: Error, context?: unknown) => void;

		/** Called when OAuth callback is received */
		onOAuthCallback?: OAuthCallbackHandler;
	};
}

/**
 * Configuration for the EdgeWorker supporting multiple repositories.
 *
 * This is the complete runtime configuration that combines:
 * - EdgeConfig: Serializable settings from ~/.cyrus/config.json
 * - EdgeWorkerRuntimeConfig: Runtime-only fields (callbacks, handlers, server config)
 *
 * The separation exists because EdgeConfig can be persisted to disk as JSON,
 * while EdgeWorkerRuntimeConfig contains callback functions and other
 * non-serializable runtime state that must be provided programmatically.
 *
 * @example
 * // EdgeConfig is loaded from config.json
 * const fileConfig: EdgeConfig = JSON.parse(fs.readFileSync('config.json'));
 *
 * // EdgeWorkerConfig adds runtime handlers
 * const runtimeConfig: EdgeWorkerConfig = {
 *   ...fileConfig,
 *   cyrusHome: '/home/user/.cyrus',
 *   handlers: {
 *     onSessionStart: (issueId, issue, repoId) => console.log('Started'),
 *     onError: (error) => console.error(error),
 *   },
 * };
 */
export type EdgeWorkerConfig = EdgeConfig & EdgeWorkerRuntimeConfig;
