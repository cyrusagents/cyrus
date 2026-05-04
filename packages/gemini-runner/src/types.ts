/**
 * Type definitions for Gemini Runner
 *
 * Event types are derived from Zod schemas in schemas.ts for runtime validation.
 * Configuration and session types remain as interfaces.
 */

import type {
	AgentRunnerConfig,
	AgentSessionInfo,
	McpServerConfig,
	SDKMessage,
} from "cyrus-core";

/**
 * Gemini CLI MCP server configuration
 *
 * Gemini CLI supports three transport types:
 * - stdio: Spawns a subprocess and communicates via stdin/stdout (command-based)
 * - sse: Connects to Server-Sent Events endpoints (url-based)
 * - http: Uses HTTP streaming for communication (httpUrl-based)
 *
 * Reference: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md
 */
export interface GeminiMcpServerConfig {
	// Transport: stdio (command-based)
	/** The command to execute to start the MCP server (stdio transport) */
	command?: string;
	/** Arguments to pass to the command (stdio transport) */
	args?: string[];
	/** The working directory in which to start the server (stdio transport) */
	cwd?: string;

	// Transport: SSE (Server-Sent Events)
	/** SSE endpoint URL (sse transport) */
	url?: string;

	// Transport: HTTP (Streamable HTTP)
	/** HTTP streaming endpoint URL (http transport) */
	httpUrl?: string;

	// Common options
	/** Custom HTTP headers when using url or httpUrl */
	headers?: Record<string, string>;
	/** Environment variables for the server process */
	env?: Record<string, string>;
	/** Timeout in milliseconds for requests to this MCP server (default: 600000ms) */
	timeout?: number;
	/** Trust this server and bypass all tool call confirmations */
	trust?: boolean;
	/** List of tool names to include from this MCP server (whitelist) */
	includeTools?: string[];
	/** List of tool names to exclude from this MCP server (blacklist) */
	excludeTools?: string[];
}

// Re-export event types from schemas (derived from Zod schemas)
export type {
	GeminiErrorEvent,
	GeminiInitEvent,
	GeminiMessageEvent,
	GeminiResultEvent,
	GeminiStreamEvent,
	// Tool parameter types
	GeminiToolParameters,
	GeminiToolResultEvent,
	GeminiToolUseEvent,
	ListDirectoryParameters,
	// Tool result types
	ListDirectoryToolResult,
	ListDirectoryToolUseEvent,
	ReadFileParameters,
	ReadFileToolResult,
	ReadFileToolUseEvent,
	ReplaceParameters,
	ReplaceToolResult,
	ReplaceToolUseEvent,
	RunShellCommandParameters,
	RunShellCommandToolResult,
	RunShellCommandToolUseEvent,
	SearchFileContentParameters,
	SearchFileContentToolResult,
	SearchFileContentToolUseEvent,
	TodoItem,
	UnknownToolUseEvent,
	WriteFileParameters,
	WriteFileToolResult,
	WriteFileToolUseEvent,
	WriteTodosParameters,
	WriteTodosToolResult,
	WriteTodosToolUseEvent,
} from "./schemas.js";
// Re-export schemas for runtime validation
export {
	// Parsing utilities
	extractToolNameFromId,
	// Event schemas
	GeminiErrorEventSchema,
	GeminiInitEventSchema,
	GeminiMessageEventSchema,
	GeminiResultEventSchema,
	GeminiStreamEventSchema,
	// Tool parameter schemas
	GeminiToolParametersSchema,
	GeminiToolResultEventSchema,
	GeminiToolUseEventSchema,
	// Event type guards
	isGeminiErrorEvent,
	isGeminiInitEvent,
	isGeminiMessageEvent,
	isGeminiResultEvent,
	isGeminiToolResultEvent,
	isGeminiToolUseEvent,
	// Tool use type guards
	isListDirectoryTool,
	// Tool result type guards
	isListDirectoryToolResult,
	isReadFileTool,
	isReadFileToolResult,
	isReplaceTool,
	isReplaceToolResult,
	isRunShellCommandTool,
	isRunShellCommandToolResult,
	isSearchFileContentTool,
	isSearchFileContentToolResult,
	isWriteFileTool,
	isWriteFileToolResult,
	isWriteTodosTool,
	isWriteTodosToolResult,
	ListDirectoryParametersSchema,
	// Tool result schemas
	ListDirectoryToolResultSchema,
	ListDirectoryToolUseEventSchema,
	parseAsListDirectoryTool,
	parseAsReadFileTool,
	parseAsReplaceTool,
	parseAsRunShellCommandTool,
	parseAsSearchFileContentTool,
	parseAsWriteFileTool,
	parseAsWriteTodosTool,
	parseGeminiStreamEvent,
	ReadFileParametersSchema,
	ReadFileToolResultSchema,
	ReadFileToolUseEventSchema,
	ReplaceParametersSchema,
	ReplaceToolResultSchema,
	ReplaceToolUseEventSchema,
	RunShellCommandParametersSchema,
	RunShellCommandToolResultSchema,
	RunShellCommandToolUseEventSchema,
	SearchFileContentParametersSchema,
	SearchFileContentToolResultSchema,
	SearchFileContentToolUseEventSchema,
	safeParseGeminiStreamEvent,
	TodoItemSchema,
	UnknownToolUseEventSchema,
	WriteFileParametersSchema,
	WriteFileToolResultSchema,
	WriteFileToolUseEventSchema,
	WriteTodosParametersSchema,
	WriteTodosToolResultSchema,
	WriteTodosToolUseEventSchema,
} from "./schemas.js";
// Re-export McpServerConfig from cyrus-core for convenience
export type { McpServerConfig };

/**
 * Configuration for GeminiRunner
 * Extends the base AgentRunnerConfig with Gemini-specific options
 *
 * MCP Configuration:
 * - mcpConfig: Inline MCP server configurations (inherited from AgentRunnerConfig)
 * - mcpConfigPath: Path(s) to MCP configuration file(s) (inherited from AgentRunnerConfig)
 * - allowMCPServers: Gemini-specific whitelist of MCP server names
 * - excludeMCPServers: Gemini-specific blacklist of MCP server names
 *
 * @example
 * ```typescript
 * const config: GeminiRunnerConfig = {
 *   cyrusHome: '/home/user/.cyrus',
 *   workingDirectory: '/path/to/repo',
 *   mcpConfig: {
 *     linear: {
 *       command: 'npx',
 *       args: ['-y', '@anthropic/mcp-linear'],
 *       env: { LINEAR_API_TOKEN: 'token' }
 *     }
 *   },
 *   allowMCPServers: ['linear'], // Only enable Linear MCP
 * };
 * ```
 */
export interface GeminiRunnerConfig extends AgentRunnerConfig {
	/** Path to gemini CLI binary (defaults to 'gemini' in PATH) */
	geminiPath?: string;
	/** Whether to auto-approve all actions (--yolo flag) */
	autoApprove?: boolean;
	/** Approval mode for tool use */
	approvalMode?: "auto_edit" | "auto" | "manual";
	/** Enable debug output */
	debug?: boolean;
	/** Additional directories to include in workspace context (--include-directories flag) */
	includeDirectories?: string[];
	/** Enable single-turn mode (sets maxSessionTurns=1 in settings.json) */
	singleTurn?: boolean;
	/**
	 * Whitelist of MCP server names to make available to the model.
	 * If specified, only listed servers will be available.
	 * Matches Gemini CLI's allowMCPServers setting.
	 */
	allowMCPServers?: string[];
	/**
	 * Blacklist of MCP server names to exclude from the model.
	 * Takes precedence over allowMCPServers.
	 * Matches Gemini CLI's excludeMCPServers setting.
	 */
	excludeMCPServers?: string[];
}

/**
 * Session information for Gemini runner
 */
export interface GeminiSessionInfo extends AgentSessionInfo {
	/** Gemini-specific session ID */
	sessionId: string | null;
}

/**
 * Event emitter interface for GeminiRunner
 */
export interface GeminiRunnerEvents {
	message: (message: SDKMessage) => void;
	error: (error: Error) => void;
	complete: (messages: SDKMessage[]) => void;
	streamEvent: (event: import("./schemas.js").GeminiStreamEvent) => void;
}
