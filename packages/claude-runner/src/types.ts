import type {
	JsonSchemaOutputFormat,
	OutputFormat,
	SandboxSettings,
	SDKAssistantMessage,
	SDKResultMessage,
	SDKSystemMessage,
	SDKUserMessage,
	SessionStore,
	WarmQuery,
} from "@anthropic-ai/claude-agent-sdk";
import type { AgentMessage, AgentRunnerConfig } from "cyrus-core";

export type { OnAskUserQuestion } from "cyrus-core";

/**
 * Output format configuration for structured outputs
 * Re-exported from Claude Agent SDK for convenience
 */
export type OutputFormatConfig = OutputFormat;

/**
 * Claude-specific runner configuration. Extends the neutral
 * {@link AgentRunnerConfig} base (which owns workingDirectory, allowedTools,
 * model, mcpConfig, hooks, plugins, skills, onMessage/onComplete, etc.) with
 * the fields only the Claude SDK understands.
 */
export interface ClaudeRunnerConfig extends AgentRunnerConfig {
	systemPrompt?: string;
	outputFormat?: OutputFormatConfig; // Structured output format configuration
	sandbox?: SandboxSettings; // Sandbox settings (enabled, network proxy ports, etc.)
	/** Additional environment variables to pass to the Claude child process (merged after process.env) */
	additionalEnv?: Record<string, string>;
	pathToClaudeCodeExecutable?: string; // Explicit path to Claude Code CLI executable (auto-resolved if not set)
	extraArgs?: Record<string, string | null>; // Additional CLI arguments to pass to Claude Code (e.g., { 'output-format': 'json' } for --output-format=json, or { verbose: null } for boolean flags)
	/**
	 * Pre-warmed session from startup() — when set, the first streaming query uses
	 * this warm instance instead of spawning a cold process (~20x faster first turn).
	 */
	warmSession?: WarmQuery;
	/**
	 * Optional SessionStore that mirrors transcript entries to external storage.
	 * Forwarded to the SDK's `query()` via `options.sessionStore`. Used to ship
	 * session JSONL to the Cyrus hosted control plane so transcripts survive
	 * the ephemeral worktree and can be resumed from any host.
	 */
	sessionStore?: SessionStore;
	/**
	 * Custom directory path for Claude's auto-memory storage. Forwarded to the
	 * Claude SDK as settings.autoMemoryDirectory. When unset, the SDK falls
	 * back to its default (~/.claude/projects/<sanitized-cwd>/memory/).
	 */
	autoMemoryDirectory?: string;
	/**
	 * Effective context-window size (in tokens) at which the session
	 * auto-compacts. Forwarded to the Claude SDK as `settings.autoCompactWindow`.
	 * When unset, the SDK compacts only near the model's full context window
	 * (e.g. ~1M tokens), which lets long multi-subroutine sessions accumulate a
	 * large re-read context tax before ever compacting. Setting a smaller value
	 * (e.g. 120000) forces earlier compaction to cap per-turn context cost.
	 */
	autoCompactWindow?: number;
	/**
	 * How long (in ms) to keep the streaming session alive after a turn ends,
	 * waiting for a follow-up message. A positive value implies
	 * `keepSessionWarm`. When the window elapses with no new message the prompt
	 * is completed and the subprocess exits, so the next message resumes the
	 * session normally. Unset or `0` restores the shut-down-on-result behavior.
	 */
	sessionKeepAliveMs?: number;
}

export interface ClaudeSessionInfo {
	sessionId: string | null; // Initially null until first message received
	startedAt: Date;
	isRunning: boolean;
}

export interface ClaudeRunnerEvents {
	message: (message: AgentMessage) => void;
	assistant: (content: string) => void;
	"tool-use": (toolName: string, input: any) => void;
	text: (text: string) => void;
	"end-turn": (lastText: string) => void;
	error: (error: Error) => void | Promise<void>;
	complete: (messages: AgentMessage[]) => void | Promise<void>;
}

// Re-export SDK types for convenience
export type {
	JsonSchemaOutputFormat,
	McpServerConfig,
	OutputFormat,
	SandboxSettings,
	SDKAssistantMessage,
	SDKMessage,
	SDKRateLimitEvent,
	SDKResultMessage,
	SDKStatusMessage,
	SDKSystemMessage,
	SDKUserMessage,
	SdkPluginConfig,
	SessionKey,
	SessionStore,
	SessionStoreEntry,
} from "@anthropic-ai/claude-agent-sdk";

// Legacy alias - JsonSchema type is now part of JsonSchemaOutputFormat['schema']
export type JsonSchema = JsonSchemaOutputFormat["schema"];
export type { BetaMessage as APIAssistantMessage } from "@anthropic-ai/sdk/resources/beta/messages/messages.js";
// Re-export Anthropic API message types
export type { MessageParam as APIUserMessage } from "@anthropic-ai/sdk/resources/messages.js";
// Type aliases for re-export
export type ClaudeSystemMessage = SDKSystemMessage;
export type ClaudeUserMessage = SDKUserMessage;
export type ClaudeAssistantMessage = SDKAssistantMessage;
export type ClaudeResultMessage = SDKResultMessage;
