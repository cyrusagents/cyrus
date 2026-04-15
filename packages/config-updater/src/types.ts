import { EdgeConfigPayloadSchema } from "cyrus-core";
import { z } from "zod";

/**
 * Repository configuration payload
 * Matches the format sent by cyrus-hosted
 */
export interface RepositoryPayload {
	repository_url: string; // Git clone URL
	repository_name: string; // Repository name (required)
	githubUrl?: string; // GitHub repository URL (e.g., "https://github.com/org/repo") - used for Linear select signal
	gitlabUrl?: string; // GitLab repository URL (e.g., "https://gitlab.com/group/project") - used for Linear select signal
}

/**
 * Repository deletion payload
 * Sent by cyrus-hosted when removing a repository
 */
export interface DeleteRepositoryPayload {
	repository_name: string; // Repository name to delete
	linear_team_key: string; // Linear team key (optional, for worktree cleanup)
}

/**
 * Cyrus config update payload schema
 * Extends EdgeConfigPayloadSchema with operation flags for the update process.
 * Uses EdgeConfigPayloadSchema (not EdgeConfigSchema) because incoming payloads
 * may omit workspaceBaseDir - the handler applies a default value.
 */
export const CyrusConfigPayloadSchema = EdgeConfigPayloadSchema.extend({
	restartCyrus: z.boolean().optional(),
	backupConfig: z.boolean().optional(),
});

export type CyrusConfigPayload = z.infer<typeof CyrusConfigPayloadSchema>;

/**
 * Cyrus environment variables payload (for Claude token)
 */
export interface CyrusEnvPayload {
	variables?: Record<string, string>;
	ANTHROPIC_API_KEY?: string;
	restartCyrus?: boolean;
	backupEnv?: boolean;
	[key: string]: string | boolean | Record<string, string> | undefined;
}

/**
 * MCP server configuration
 */
export interface McpServerConfig {
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	transport?: "stdio" | "sse";
	headers?: Record<string, string>;
}

/**
 * Test MCP connection payload
 */
export interface TestMcpPayload {
	transportType: "stdio" | "sse" | "http";
	serverUrl?: string | null;
	command?: string | null;
	commandArgs?: Array<{ value: string; order: number }> | null;
	headers?: Array<{ name: string; value: string }> | null;
	envVars?: Array<{ key: string; value: string }> | null;
}

/**
 * Configure MCP servers payload
 */
export interface ConfigureMcpPayload {
	mcpServers: Record<string, McpServerConfig>;
}

/**
 * Check GitHub CLI payload (empty - no parameters needed)
 */
export type CheckGhPayload = Record<string, never>;

/**
 * Check GitHub CLI response data
 */
export interface CheckGhData {
	isInstalled: boolean;
	isAuthenticated: boolean;
}

/**
 * Check GitLab CLI payload (empty - no parameters needed)
 */
export type CheckGlabPayload = Record<string, never>;

/**
 * Check GitLab CLI response data
 */
export interface CheckGlabData {
	isInstalled: boolean;
	isAuthenticated: boolean;
}

/**
 * Error response to send back to cyrus-hosted
 */
export interface ErrorResponse {
	success: false;
	error: string;
	details?: string;
}

/**
 * Success response to send back to cyrus-hosted
 */
export interface SuccessResponse {
	success: true;
	message: string;
	data?: any;
}

export type ApiResponse = SuccessResponse | ErrorResponse;

/**
 * Create or update a user skill
 * Sent by cyrus-hosted when a user creates/edits a skill
 */
export interface UpdateSkillPayload {
	/** Skill name — used as the directory name and invocation name */
	name: string;
	/** One-line description shown in the Skill tool's list */
	description: string;
	/** Full skill content (Markdown body, excluding the frontmatter — frontmatter is generated from name + description) */
	content: string;
}

/**
 * Delete a user skill
 * Sent by cyrus-hosted when a user removes a skill
 */
export interface DeleteSkillPayload {
	/** Skill name to delete */
	name: string;
}

/**
 * List user skills payload (empty — no parameters needed)
 */
export type ListSkillsPayload = Record<string, never>;

/**
 * Skill info returned in list responses
 */
export interface SkillInfo {
	name: string;
	description: string;
}
