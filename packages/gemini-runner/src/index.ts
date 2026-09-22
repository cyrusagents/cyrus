/**
 * @module atmiko-gemini-runner
 *
 * Gemini CLI integration for Atmiko agent framework.
 * Provides a provider-agnostic wrapper around the Gemini CLI that implements
 * the IAgentRunner interface, allowing seamless switching between Claude and Gemini.
 *
 * @example
 * ```typescript
 * import { GeminiRunner } from 'atmiko-gemini-runner';
 *
 * const runner = new GeminiRunner({
 *   atmikoHome: '/home/user/.atmiko',
 *   workingDirectory: '/path/to/repo',
 *   model: 'gemini-2.5-flash',
 *   autoApprove: true
 * });
 *
 * // Start a session
 * const session = await runner.start("Analyze this codebase");
 * console.log(`Session ID: ${session.sessionId}`);
 *
 * // Get messages
 * const messages = runner.getMessages();
 * console.log(`Received ${messages.length} messages`);
 * ```
 */

// Adapter functions
export {
	createUserMessage,
	extractSessionId,
	geminiEventToSDKMessage,
} from "./adapters.js";
// Formatter
export { GeminiMessageFormatter } from "./formatter.js";
// Main runner class
export { GeminiRunner } from "./GeminiRunner.js";
// Simple agent runner
export { SimpleGeminiRunner } from "./SimpleGeminiRunner.js";
// Zod schemas and validation utilities
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
// Settings generator utilities (for MCP configuration)
export {
	autoDetectMcpConfig,
	backupGeminiSettings,
	convertToGeminiMcpConfig,
	deleteGeminiSettings,
	type GeminiSettingsOptions,
	loadMcpConfigFromPaths,
	restoreGeminiSettings,
	setupGeminiSettings,
	writeGeminiSettings,
} from "./settingsGenerator.js";
// System prompt manager
export { SystemPromptManager } from "./systemPromptManager.js";
// Types
export type {
	// Event types
	GeminiErrorEvent,
	GeminiInitEvent,
	// MCP types
	GeminiMcpServerConfig,
	GeminiMessageEvent,
	GeminiResultEvent,
	GeminiRunnerConfig,
	GeminiRunnerEvents,
	GeminiSessionInfo,
	GeminiStreamEvent,
	// Tool parameter types
	GeminiToolParameters,
	GeminiToolResultEvent,
	GeminiToolUseEvent,
	ListDirectoryParameters,
	// Tool result types
	ListDirectoryToolResult,
	ListDirectoryToolUseEvent,
	// Re-export McpServerConfig from atmiko-core for convenience
	McpServerConfig,
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
} from "./types.js";
