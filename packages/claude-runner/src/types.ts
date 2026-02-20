import type {
	HookCallbackMatcher,
	HookEvent,
	JsonSchemaOutputFormat,
	McpServerConfig,
	OutputFormat,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { ILogger, OnAskUserQuestion } from "cyrus-core";

export type { OnAskUserQuestion } from "cyrus-core";

/**
 * Output format configuration for structured outputs
 * Re-exported from Claude Agent SDK for convenience
 */
export type OutputFormatConfig = OutputFormat;

export interface ClaudeRunnerConfig {
	workingDirectory?: string;
	allowedTools?: string[];
	disallowedTools?: string[];
	allowedDirectories?: string[];
	resumeSessionId?: string; // Session ID to resume from previous Claude session
	workspaceName?: string;
	systemPrompt?: string;
	appendSystemPrompt?: string; // Additional prompt to append to the default system prompt
	mcpConfigPath?: string | string[]; // Single path or array of paths to compose
	mcpConfig?: Record<string, McpServerConfig>; // Additional/override MCP servers
	model?: string; // Claude model to use (e.g., "opus", "sonnet", "haiku")
	fallbackModel?: string; // Fallback model if primary model is unavailable
	maxTurns?: number; // Maximum number of turns before completing the session
	tools?: string[]; // Built-in tools available in model context (empty array disables all tools)
	cyrusHome: string; // Cyrus home directory
	logger?: ILogger; // Optional logger instance
	promptVersions?: {
		// Optional prompt template version information
		userPromptVersion?: string;
		systemPromptVersion?: string;
	};
	hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>; // Claude SDK hooks
	outputFormat?: OutputFormatConfig; // Structured output format configuration
	extraArgs?: Record<string, string | null>; // Additional CLI arguments to pass to Claude Code (e.g., { chrome: null } for --chrome flag)
	/**
	 * Callback for handling AskUserQuestion tool invocations.
	 * When provided, the ClaudeRunner will intercept AskUserQuestion tool calls
	 * via the canUseTool callback and delegate to this handler.
	 *
	 * Note: Only one question at a time is supported. Multiple questions will be rejected.
	 */
	onAskUserQuestion?: OnAskUserQuestion;
	onMessage?: (message: SDKMessage) => void | Promise<void>;
	onError?: (error: Error) => void | Promise<void>;
	onComplete?: (messages: SDKMessage[]) => void | Promise<void>;
}

export interface ClaudeSessionInfo {
	sessionId: string | null; // Initially null until first message received
	startedAt: Date;
	isRunning: boolean;
}

export interface ClaudeRunnerEvents {
	message: (message: SDKMessage) => void;
	assistant: (content: string) => void;
	"tool-use": (toolName: string, input: any) => void;
	text: (text: string) => void;
	"end-turn": (lastText: string) => void;
	error: (error: Error) => void | Promise<void>;
	complete: (messages: SDKMessage[]) => void | Promise<void>;
}

// Re-export SDK types for convenience
export type {
	JsonSchemaOutputFormat,
	McpServerConfig,
	OutputFormat,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Legacy alias - JsonSchema type is now part of JsonSchemaOutputFormat['schema']
export type JsonSchema = JsonSchemaOutputFormat["schema"];
// Re-export Anthropic API message types
export type {
	Message as APIAssistantMessage,
	MessageParam as APIUserMessage,
} from "@anthropic-ai/sdk/resources/messages.js";
// Type aliases for re-export
export type ClaudeSystemMessage = SDKSystemMessage;
export type ClaudeUserMessage = SDKUserMessage;
export type ClaudeAssistantMessage = SDKAssistantMessage;
export type ClaudeResultMessage = SDKResultMessage;
