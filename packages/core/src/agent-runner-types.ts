import type {
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	SDKMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

// Import the AskUserQuestionInput type from the SDK's tool input types
// This ensures we use the SDK's official type definitions
import type { AskUserQuestionInput as SDKAskUserQuestionInput } from "@anthropic-ai/claude-agent-sdk/sdk-tools.d.ts";

// ============================================================================
// ASK USER QUESTION TYPES
// ============================================================================
// Re-export the SDK's AskUserQuestionInput type as the canonical input type.
// The SDK's type has complex tuple structures for questions and options.
// We also provide simplified types for easier consumption in our callback API.

/**
 * The canonical AskUserQuestionInput type from the Claude SDK.
 *
 * @see {@link https://platform.claude.com/docs/en/agent-sdk/typescript#ask-user-question}
 */
export type AskUserQuestionInput = SDKAskUserQuestionInput;

/**
 * Simplified option type for easier API consumption.
 * Matches the structure within AskUserQuestionInput but without tuple constraints.
 */
export interface AskUserQuestionOption {
	/** The display text for this option */
	label: string;
	/** Explanation of what this option means */
	description: string;
}

/**
 * Simplified question type for easier API consumption.
 * Matches the structure within AskUserQuestionInput but without tuple constraints.
 */
export interface AskUserQuestion {
	/** The complete question to ask the user */
	question: string;
	/** Short label for the question (max 12 chars) */
	header: string;
	/** The available choices (2-4 options) */
	options: AskUserQuestionOption[];
	/** Whether multiple options can be selected */
	multiSelect: boolean;
}

/**
 * Result of user responding to questions.
 * Maps question text to selected option label(s).
 *
 * For single-select: the value is the selected option's label
 * For multi-select: the value is a comma-separated string of selected labels
 *
 * @see {@link https://platform.claude.com/docs/en/agent-sdk/permissions#returning-answers}
 */
export type AskUserQuestionAnswers = Record<string, string>;

/**
 * Result of presenting questions to the user.
 */
export interface AskUserQuestionResult {
	/** Whether the user provided answers (true) or the request was cancelled/denied (false) */
	answered: boolean;
	/** The user's answers, if answered is true */
	answers?: AskUserQuestionAnswers;
	/** Message explaining why the request was denied, if answered is false */
	message?: string;
}

/**
 * Callback for handling AskUserQuestion tool invocations.
 *
 * This callback is invoked when Claude uses the AskUserQuestion tool to ask
 * the user clarifying questions. Implementations should present the questions
 * to the user (e.g., via Linear's select signal) and return their answers.
 *
 * @param input - The questions to present to the user
 * @param sessionId - The agent session ID (used for tracking pending responses)
 * @param signal - AbortSignal to cancel the operation if needed
 * @returns Promise resolving to the user's answers or a denial
 *
 * @example
 * ```typescript
 * const onAskUserQuestion: OnAskUserQuestion = async (input, sessionId, signal) => {
 *   // Present questions to user via Linear select signal
 *   const answers = await presentToLinear(input.questions, sessionId);
 *
 *   if (answers) {
 *     return {
 *       answered: true,
 *       answers: {
 *         "Which database should we use?": "PostgreSQL",
 *         "Which features should we enable?": "Authentication, Caching"
 *       }
 *     };
 *   } else {
 *     return {
 *       answered: false,
 *       message: "User did not respond"
 *     };
 *   }
 * };
 * ```
 */
export type OnAskUserQuestion = (
	input: AskUserQuestionInput,
	sessionId: string,
	signal: AbortSignal,
) => Promise<AskUserQuestionResult>;

/**
 * Message Formatter Interface
 *
 * Forward declaration - implemented by each runner (e.g., ClaudeMessageFormatter, GeminiMessageFormatter)
 */
export interface IMessageFormatter {
	/**
	 * Format TodoWrite tool parameter as a nice checklist
	 * @deprecated TodoWrite has been replaced by Task tools (TaskCreate, TaskUpdate, etc.)
	 */
	formatTodoWriteParameter(jsonContent: string): string;
	/**
	 * Format Task tool parameter (TaskCreate, TaskUpdate, TaskList, TaskGet)
	 */
	formatTaskParameter(toolName: string, toolInput: any): string;
	formatToolParameter(toolName: string, toolInput: any): string;
	formatToolActionName(
		toolName: string,
		toolInput: any,
		isError: boolean,
	): string;
	formatToolResult(
		toolName: string,
		toolInput: any,
		result: string,
		isError: boolean,
	): string;
}

/**
 * Agent Runner Interface
 *
 * This interface provides a provider-agnostic abstraction for AI agent runners.
 * It follows the same pattern as IIssueTrackerService, where type aliases point
 * to provider-specific SDK types (currently Claude SDK).
 *
 * The interface is designed to support multiple AI providers (Claude, Gemini, etc.)
 * through adapter implementations, while maintaining a consistent API surface.
 *
 * ## Architecture Pattern
 *
 * This abstraction uses type aliasing to external SDK types rather than creating
 * new types. This approach:
 * - Maintains compatibility with existing Claude SDK code
 * - Allows gradual migration to provider-agnostic code
 * - Enables adapter pattern implementations for other providers
 * - Preserves type safety and IDE autocomplete
 *
 * ## Usage Example
 *
 * ```typescript
 * class ClaudeRunnerAdapter implements IAgentRunner {
 *   async start(prompt: string): Promise<AgentSessionInfo> {
 *     // Implementation using Claude SDK
 *   }
 *
 *   async startStreaming(initialPrompt?: string): Promise<AgentSessionInfo> {
 *     // Implementation using Claude SDK streaming
 *   }
 *
 *   // ... other methods
 * }
 *
 * class GeminiRunnerAdapter implements IAgentRunner {
 *   async start(prompt: string): Promise<AgentSessionInfo> {
 *     // Implementation using Gemini SDK
 *   }
 *
 *   // ... other methods
 * }
 * ```
 *
 * @see {@link AgentRunnerConfig} for configuration options
 * @see {@link AgentSessionInfo} for session information structure
 */
export interface IAgentRunner {
	/**
	 * Indicates whether this runner supports streaming input
	 *
	 * When true, the runner supports `startStreaming()`, `addStreamMessage()`, and `completeStream()`.
	 * When false, only `start()` should be used - streaming methods may throw or be unavailable.
	 *
	 * @example
	 * ```typescript
	 * if (runner.supportsStreamingInput) {
	 *   await runner.startStreaming(initialPrompt);
	 *   runner.addStreamMessage("Additional context");
	 * } else {
	 *   await runner.start(fullPrompt);
	 * }
	 * ```
	 */
	readonly supportsStreamingInput: boolean;

	/**
	 * Start a new agent session with a string prompt (legacy/simple mode)
	 *
	 * This method initiates a complete agent session with a single prompt string.
	 * The session runs until completion or until stopped.
	 *
	 * @param prompt - The initial prompt to send to the agent
	 * @returns Session information including session ID and status
	 *
	 * @example
	 * ```typescript
	 * const runner = new ClaudeRunnerAdapter(config);
	 * const session = await runner.start("Please analyze this codebase");
	 * console.log(`Session started: ${session.sessionId}`);
	 * ```
	 */
	start(prompt: string): Promise<AgentSessionInfo>;

	/**
	 * Start a new agent session with streaming input support
	 *
	 * This method enables adding messages to the session dynamically after it has started.
	 * Use this for interactive sessions where prompts arrive over time (e.g., from webhooks).
	 *
	 * Only available when `supportsStreamingInput` is true.
	 *
	 * @param initialPrompt - Optional initial prompt to send immediately
	 * @returns Session information including session ID and status
	 *
	 * @example
	 * ```typescript
	 * if (runner.supportsStreamingInput) {
	 *   const session = await runner.startStreaming("Initial task");
	 *   runner.addStreamMessage("Additional context");
	 *   runner.completeStream();
	 * }
	 * ```
	 */
	startStreaming?(initialPrompt?: string): Promise<AgentSessionInfo>;

	/**
	 * Add a message to the streaming prompt
	 *
	 * Only works when the session was started with `startStreaming()`.
	 * Messages are queued and sent to the agent as it processes them.
	 *
	 * Only available when `supportsStreamingInput` is true.
	 *
	 * @param content - The message content to add to the stream
	 * @throws Error if not in streaming mode or if stream is already completed
	 *
	 * @example
	 * ```typescript
	 * runner.addStreamMessage("New comment from user: Fix the bug in auth.ts");
	 * ```
	 */
	addStreamMessage?(content: string): void;

	/**
	 * Complete the streaming prompt (no more messages will be added)
	 *
	 * This signals to the agent that no more messages will be added to the stream.
	 * The agent will complete processing and finish the session.
	 *
	 * Only available when `supportsStreamingInput` is true.
	 *
	 * @example
	 * ```typescript
	 * runner.addStreamMessage("Final message");
	 * runner.completeStream(); // Agent will finish processing
	 * ```
	 */
	completeStream?(): void;

	/**
	 * Stop the current agent session
	 *
	 * Gracefully terminates the running session. Any in-progress operations
	 * will be aborted, and the session will transition to stopped state.
	 *
	 * @example
	 * ```typescript
	 * // User unassigned from issue - stop the agent
	 * if (runner.isRunning()) {
	 *   runner.stop();
	 * }
	 * ```
	 */
	stop(): void;

	/**
	 * Check if the session is currently running
	 *
	 * @returns True if the session is active and processing, false otherwise
	 *
	 * @example
	 * ```typescript
	 * if (runner.isRunning()) {
	 *   console.log("Session still active");
	 * } else {
	 *   console.log("Session completed or not started");
	 * }
	 * ```
	 */
	isRunning(): boolean;

	/**
	 * Get all messages from the current session
	 *
	 * Returns a copy of all messages exchanged in the session, including
	 * user prompts, assistant responses, system messages, and tool results.
	 *
	 * @returns Array of all session messages (copy, not reference)
	 *
	 * @example
	 * ```typescript
	 * const messages = runner.getMessages();
	 * console.log(`Session has ${messages.length} messages`);
	 *
	 * // Analyze assistant responses
	 * const assistantMessages = messages.filter(m => m.type === 'assistant');
	 * ```
	 */
	getMessages(): AgentMessage[];

	/**
	 * Get the message formatter for this runner
	 *
	 * Returns a formatter that can convert tool messages into human-readable
	 * format suitable for display in Linear or other issue trackers.
	 * Each runner provides its own formatter that understands its specific message format.
	 *
	 * @returns The message formatter instance for this runner
	 *
	 * @example
	 * ```typescript
	 * const formatter = runner.getFormatter();
	 * const formatted = formatter.formatToolParameter("Read", { file_path: "/test.ts" });
	 * console.log(formatted); // "/test.ts"
	 * ```
	 */
	getFormatter(): IMessageFormatter;
}

/**
 * Configuration for agent runner
 *
 * This type aliases to the Claude SDK configuration structure. When implementing
 * adapters for other providers (e.g., Gemini), they should map their config to
 * this structure or extend it with provider-specific options.
 *
 * @example
 * ```typescript
 * const config: AgentRunnerConfig = {
 *   workingDirectory: '/path/to/repo',
 *   allowedDirectories: ['/path/to/repo'],
 *   mcpConfig: {
 *     'linear': { command: 'npx', args: ['-y', '@linear/mcp-server'] }
 *   },
 *   cyrusHome: '/home/user/.cyrus'
 * };
 * ```
 */
export interface AgentRunnerConfig {
	/** Working directory for the agent session */
	workingDirectory?: string;
	/** List of allowed tool patterns (e.g., ["Read(**)", "Edit(**)"]) */
	allowedTools?: string[];
	/** List of disallowed tool patterns */
	disallowedTools?: string[];
	/** Directories the agent can read from */
	allowedDirectories?: string[];
	/** Session ID to resume from a previous session */
	resumeSessionId?: string;
	/** Workspace name for logging and organization */
	workspaceName?: string;
	/** Additional text to append to default system prompt */
	appendSystemPrompt?: string;
	/** Path(s) to MCP configuration file(s) */
	mcpConfigPath?: string | string[];
	/** MCP server configurations (inline) */
	mcpConfig?: Record<string, McpServerConfig>;
	/** AI model to use (e.g., "opus", "sonnet", "haiku") */
	model?: string;
	/** Fallback model if primary is unavailable */
	fallbackModel?: string;
	/** Maximum number of turns before completing session */
	maxTurns?: number;
	/** Built-in tools available in model context (empty array disables all tools) */
	tools?: string[];
	/** Cyrus home directory (required) */
	cyrusHome: string;
	/** Prompt template version information */
	promptVersions?: {
		userPromptVersion?: string;
		systemPromptVersion?: string;
	};
	/** Event hooks for customizing agent behavior */
	hooks?: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
	/**
	 * Callback for handling AskUserQuestion tool invocations.
	 * When provided, intercepts the AskUserQuestion tool to allow presenting
	 * questions to users via external interfaces (e.g., Linear's select signal).
	 *
	 * Note: Only one question at a time is supported. Multiple questions in
	 * a single tool call will be rejected.
	 */
	onAskUserQuestion?: OnAskUserQuestion;
	/** Callback for each message received */
	onMessage?: (message: AgentMessage) => void | Promise<void>;
	/** Callback for errors */
	onError?: (error: Error) => void | Promise<void>;
	/** Callback when session completes */
	onComplete?: (messages: AgentMessage[]) => void | Promise<void>;
}

/**
 * Information about an agent session
 *
 * Tracks the lifecycle and status of an agent session.
 * The sessionId is initially null and gets assigned by the provider
 * when the first message is processed.
 *
 * @example
 * ```typescript
 * const info: AgentSessionInfo = {
 *   sessionId: 'claude-session-abc123',
 *   startedAt: new Date(),
 *   isRunning: true
 * };
 * ```
 */
export interface AgentSessionInfo {
	/** Unique session identifier (null until first message) */
	sessionId: string | null;
	/** When the session started */
	startedAt: Date;
	/** Whether the session is currently active */
	isRunning: boolean;
}

/**
 * Type alias for agent messages
 *
 * Maps to Claude SDK's SDKMessage type, which is a union of:
 * - SDKUserMessage (user inputs)
 * - SDKAssistantMessage (agent responses)
 * - SDKSystemMessage (system prompts)
 * - SDKResultMessage (completion/error results)
 *
 * Other provider adapters should map their message types to this structure.
 */
export type AgentMessage = SDKMessage;

/**
 * Type alias for user messages
 *
 * Maps to Claude SDK's SDKUserMessage type.
 * Used for prompts and user inputs to the agent.
 */
export type AgentUserMessage = SDKUserMessage;

/**
 * Re-export SDK types for convenience
 *
 * These re-exports allow consumers to import all necessary types
 * from a single location (packages/core) without knowing the
 * underlying provider SDK.
 */
export type {
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	SDKAssistantMessage,
	SDKAssistantMessageError,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
