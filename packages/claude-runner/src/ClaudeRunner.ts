import { EventEmitter } from "node:events";
import {
	createWriteStream,
	existsSync,
	mkdirSync,
	readFileSync,
	type WriteStream,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type CanUseTool,
	type PermissionResult,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "cyrus-core";
import { type IAgentRunner, StreamingPrompt } from "cyrus-core";
import dotenv from "dotenv";

// AbortError is no longer exported in v1.0.95, so we define it locally
export class AbortError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "AbortError";
	}
}

import { ClaudeMessageFormatter, type IMessageFormatter } from "./formatter.js";
import type {
	ClaudeRunnerConfig,
	ClaudeRunnerEvents,
	ClaudeSessionInfo,
} from "./types.js";

export declare interface ClaudeRunner {
	on<K extends keyof ClaudeRunnerEvents>(
		event: K,
		listener: ClaudeRunnerEvents[K],
	): this;
	emit<K extends keyof ClaudeRunnerEvents>(
		event: K,
		...args: Parameters<ClaudeRunnerEvents[K]>
	): boolean;
}

/**
 * Manages Claude SDK sessions and communication
 */
export class ClaudeRunner extends EventEmitter implements IAgentRunner {
	/**
	 * ClaudeRunner supports streaming input via startStreaming(), addStreamMessage(), and completeStream()
	 */
	readonly supportsStreamingInput = true;

	private config: ClaudeRunnerConfig;
	private abortController: AbortController | null = null;
	private sessionInfo: ClaudeSessionInfo | null = null;
	private logStream: WriteStream | null = null;
	private readableLogStream: WriteStream | null = null;
	private messages: SDKMessage[] = [];
	private streamingPrompt: StreamingPrompt | null = null;
	private cyrusHome: string;
	private formatter: IMessageFormatter;
	private pendingResultMessage: SDKMessage | null = null;
	private canUseToolCallback: CanUseTool | undefined;

	constructor(config: ClaudeRunnerConfig) {
		super();
		this.config = config;
		this.cyrusHome = config.cyrusHome;
		this.formatter = new ClaudeMessageFormatter();

		// Create canUseTool callback if onAskUserQuestion is provided
		if (config.onAskUserQuestion) {
			this.canUseToolCallback = this.createCanUseToolCallback();
		}

		// Forward config callbacks to events
		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	/**
	 * Create the canUseTool callback for intercepting AskUserQuestion tool calls.
	 *
	 * This implements the Claude SDK permission handling pattern:
	 * - Intercepts AskUserQuestion tool calls
	 * - Rejects requests with multiple questions (only 1 allowed at a time)
	 * - Delegates to the onAskUserQuestion callback for presentation
	 * - Returns the user's answers or denial
	 *
	 * @see {@link https://platform.claude.com/docs/en/agent-sdk/permissions#handling-the-ask-user-question-tool}
	 */
	private createCanUseToolCallback(): CanUseTool {
		return async (
			toolName: string,
			input: Record<string, unknown>,
			options: {
				signal: AbortSignal;
				toolUseID: string;
			},
		): Promise<PermissionResult> => {
			// Only intercept AskUserQuestion tool
			if (toolName !== "AskUserQuestion") {
				// Allow all other tools to proceed normally
				return {
					behavior: "allow",
					updatedInput: input,
				};
			}

			console.log(
				`[ClaudeRunner] Intercepted AskUserQuestion tool call (toolUseID: ${options.toolUseID})`,
			);

			// Validate the input structure
			const askInput = input as unknown as AskUserQuestionInput;
			if (!askInput.questions || !Array.isArray(askInput.questions)) {
				return {
					behavior: "deny",
					message:
						"Invalid AskUserQuestion input: 'questions' array is required",
				};
			}

			// IMPORTANT: Only allow one question at a time
			if (askInput.questions.length !== 1) {
				console.log(
					`[ClaudeRunner] Rejecting AskUserQuestion with ${askInput.questions.length} questions (only 1 allowed)`,
				);
				return {
					behavior: "deny",
					message:
						"Only one question at a time is supported. Please ask each question separately.",
				};
			}

			// Validate the onAskUserQuestion callback exists
			if (!this.config.onAskUserQuestion) {
				console.error(
					"[ClaudeRunner] onAskUserQuestion callback not configured",
				);
				return {
					behavior: "deny",
					message: "AskUserQuestion handler not configured",
				};
			}

			// Get the session ID (required for tracking)
			const sessionId = this.sessionInfo?.sessionId;
			if (!sessionId) {
				console.error(
					"[ClaudeRunner] Cannot handle AskUserQuestion without session ID",
				);
				return {
					behavior: "deny",
					message: "Session not initialized",
				};
			}

			try {
				// Delegate to the onAskUserQuestion callback
				console.log(
					`[ClaudeRunner] Delegating AskUserQuestion to callback for session ${sessionId}`,
				);

				const result = await this.config.onAskUserQuestion(
					askInput,
					sessionId,
					options.signal,
				);

				if (result.answered && result.answers) {
					console.log(
						`[ClaudeRunner] User answered AskUserQuestion for session ${sessionId}`,
					);

					// Return the answers via updatedInput as per SDK documentation
					return {
						behavior: "allow",
						updatedInput: {
							questions: askInput.questions,
							answers: result.answers,
						},
					};
				} else {
					console.log(
						`[ClaudeRunner] User denied AskUserQuestion for session ${sessionId}: ${result.message}`,
					);
					return {
						behavior: "deny",
						message: result.message || "User did not respond to the question",
					};
				}
			} catch (error) {
				const errorMessage = (error as Error).message || String(error);
				console.error(
					`[ClaudeRunner] Error handling AskUserQuestion: ${errorMessage}`,
				);
				return {
					behavior: "deny",
					message: `Failed to present question: ${errorMessage}`,
				};
			}
		};
	}

	/**
	 * Start a new Claude session with string prompt (legacy mode)
	 */
	async start(prompt: string): Promise<ClaudeSessionInfo> {
		return this.startWithPrompt(prompt);
	}

	/**
	 * Start a new Claude session with streaming input
	 */
	async startStreaming(initialPrompt?: string): Promise<ClaudeSessionInfo> {
		return this.startWithPrompt(null, initialPrompt);
	}

	/**
	 * Add a message to the streaming prompt (only works when in streaming mode)
	 */
	addStreamMessage(content: string): void {
		if (!this.streamingPrompt) {
			throw new Error("Cannot add stream message when not in streaming mode");
		}
		this.streamingPrompt.addMessage(content);
	}

	/**
	 * Complete the streaming prompt (no more messages will be added)
	 */
	completeStream(): void {
		if (this.streamingPrompt) {
			this.streamingPrompt.complete();
		}
	}

	/**
	 * Internal method to start a Claude session with either string or streaming prompt
	 */
	private async startWithPrompt(
		stringPrompt?: string | null,
		streamingInitialPrompt?: string,
	): Promise<ClaudeSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Claude session already running");
		}

		// Initialize session info without session ID (will be set from first message)
		this.sessionInfo = {
			sessionId: null,
			startedAt: new Date(),
			isRunning: true,
		};

		console.log(
			`[ClaudeRunner] Starting new session (session ID will be assigned by Claude)`,
		);
		console.log(
			"[ClaudeRunner] Working directory:",
			this.config.workingDirectory,
		);

		// Ensure working directory exists
		if (this.config.workingDirectory) {
			try {
				mkdirSync(this.config.workingDirectory, { recursive: true });
				console.log("[ClaudeRunner] Created working directory");
			} catch (err) {
				console.error(
					"[ClaudeRunner] Failed to create working directory:",
					err,
				);
			}
		}

		// Load environment variables from repository .env file
		// This must happen BEFORE MCP config processing so the SDK can expand ${VAR} references
		if (this.config.workingDirectory) {
			this.loadRepositoryEnv(this.config.workingDirectory);
		}

		// Set up logging (initial setup without session ID)
		this.setupLogging();

		// Create abort controller for this session
		this.abortController = new AbortController();

		// Reset messages array
		this.messages = [];

		try {
			// Determine prompt mode and setup
			let promptForQuery: string | AsyncIterable<SDKUserMessage>;

			if (stringPrompt !== null && stringPrompt !== undefined) {
				// String mode
				console.log(
					`[ClaudeRunner] Starting query with string prompt length: ${stringPrompt.length} characters`,
				);
				promptForQuery = stringPrompt;
			} else {
				// Streaming mode
				console.log(`[ClaudeRunner] Starting query with streaming prompt`);
				this.streamingPrompt = new StreamingPrompt(
					null,
					streamingInitialPrompt,
				);
				promptForQuery = this.streamingPrompt;
			}

			// Process allowed directories by adding Read patterns to allowedTools
			let processedAllowedTools = this.config.allowedTools
				? [...this.config.allowedTools]
				: undefined;
			if (
				this.config.allowedDirectories &&
				this.config.allowedDirectories.length > 0
			) {
				const directoryTools = this.config.allowedDirectories.map((dir) => {
					// Add extra / prefix for absolute paths to ensure Claude Code recognizes them properly
					// See: https://docs.anthropic.com/en/docs/claude-code/settings#read-%26-edit
					const prefixedPath = dir.startsWith("/") ? `/${dir}` : dir;
					return `Read(${prefixedPath}/**)`;
				});
				processedAllowedTools = processedAllowedTools
					? [...processedAllowedTools, ...directoryTools]
					: directoryTools;
			}

			// Process disallowed tools - no defaults, just pass through
			// Only pass if array is non-empty
			const processedDisallowedTools =
				this.config.disallowedTools && this.config.disallowedTools.length > 0
					? this.config.disallowedTools
					: undefined;

			// Log disallowed tools if configured
			if (processedDisallowedTools) {
				console.log(
					`[ClaudeRunner] Disallowed tools configured:`,
					processedDisallowedTools,
				);
			}

			// Parse MCP config - merge file(s) and inline configs
			let mcpServers = {};

			// Build list of config paths to load (in order of precedence)
			const configPaths: string[] = [];

			// Auto-detect .mcp.json in working directory (base config)
			if (this.config.workingDirectory) {
				const autoMcpPath = join(this.config.workingDirectory, ".mcp.json");
				if (existsSync(autoMcpPath)) {
					try {
						// Validate it's readable JSON before adding to paths
						const testContent = readFileSync(autoMcpPath, "utf8");
						JSON.parse(testContent);
						configPaths.push(autoMcpPath);
						console.log(
							`[ClaudeRunner] Auto-detected MCP config at ${autoMcpPath}`,
						);
					} catch (_error) {
						// Silently skip invalid .mcp.json files (could be test fixtures, etc.)
						console.log(
							`[ClaudeRunner] Skipping invalid .mcp.json at ${autoMcpPath}`,
						);
					}
				}
			}

			// Add explicitly configured paths (these will extend/override the base config)
			if (this.config.mcpConfigPath) {
				const explicitPaths = Array.isArray(this.config.mcpConfigPath)
					? this.config.mcpConfigPath
					: [this.config.mcpConfigPath];
				configPaths.push(...explicitPaths);
			}

			// Load from all config paths
			for (const path of configPaths) {
				try {
					const mcpConfigContent = readFileSync(path, "utf8");
					const mcpConfig = JSON.parse(mcpConfigContent);
					const servers = mcpConfig.mcpServers || {};
					mcpServers = { ...mcpServers, ...servers };
					console.log(
						`[ClaudeRunner] Loaded MCP servers from ${path}: ${Object.keys(servers).join(", ")}`,
					);
				} catch (error) {
					console.error(
						`[ClaudeRunner] Failed to load MCP config from ${path}:`,
						error,
					);
				}
			}

			// Finally, merge inline config (overrides file config for same server names)
			if (this.config.mcpConfig) {
				mcpServers = { ...mcpServers, ...this.config.mcpConfig };
				console.log(
					`[ClaudeRunner] Final MCP servers after merge: ${Object.keys(mcpServers).join(", ")}`,
				);
			}

			// Log allowed directories if configured
			if (this.config.allowedDirectories) {
				console.log(
					`[ClaudeRunner] Allowed directories configured:`,
					this.config.allowedDirectories,
				);
			}

			const queryOptions: Parameters<typeof query>[0] = {
				prompt: promptForQuery,
				options: {
					model: this.config.model || "opus",
					fallbackModel: this.config.fallbackModel || "sonnet",
					abortController: this.abortController,
					// Use Claude Code preset by default to maintain backward compatibility
					// This can be overridden if systemPrompt is explicitly provided
					systemPrompt: this.config.systemPrompt || {
						type: "preset",
						preset: "claude_code",
						...(this.config.appendSystemPrompt && {
							append: this.config.appendSystemPrompt,
						}),
					},
					// load file based settings, to maintain more backwards compatibility,
					// particularly with CLAUDE.md files, settings files, and custom slash commands,
					// see: https://docs.claude.com/en/docs/claude-code/sdk/migration-guide#settings-sources-no-longer-loaded-by-default
					settingSources: ["user", "project", "local"],
					env: {
						...process.env,
						CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD: "1",
						CLAUDE_CODE_ENABLE_TASKS: "true",
						CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1",
					},
					...(this.config.workingDirectory && {
						cwd: this.config.workingDirectory,
					}),
					...(this.config.allowedDirectories && {
						allowedDirectories: this.config.allowedDirectories,
					}),
					...(processedAllowedTools && { allowedTools: processedAllowedTools }),
					...(processedDisallowedTools && {
						disallowedTools: processedDisallowedTools,
					}),
					...(this.canUseToolCallback && {
						canUseTool: this.canUseToolCallback,
					}),
					...(this.config.resumeSessionId && {
						resume: this.config.resumeSessionId,
					}),
					...(Object.keys(mcpServers).length > 0 && { mcpServers }),
					...(this.config.hooks && { hooks: this.config.hooks }),
					...(this.config.tools !== undefined && { tools: this.config.tools }),
					...(this.config.maxTurns && { maxTurns: this.config.maxTurns }),
					...(this.config.outputFormat && {
						outputFormat: this.config.outputFormat,
					}),
					...(this.config.extraArgs && { extraArgs: this.config.extraArgs }),
				},
			};

			// Process messages from the query
			for await (const message of query(queryOptions)) {
				if (!this.sessionInfo?.isRunning) {
					console.log(
						"[ClaudeRunner] Session was stopped, breaking from query loop",
					);
					break;
				}

				// Extract session ID from first message if we don't have one yet
				if (!this.sessionInfo.sessionId && message.session_id) {
					this.sessionInfo.sessionId = message.session_id;
					console.log(
						`[ClaudeRunner] Session ID assigned by Claude: ${message.session_id}`,
					);

					// Update streaming prompt with session ID if it exists
					if (this.streamingPrompt) {
						this.streamingPrompt.updateSessionId(message.session_id);
					}

					// Re-setup logging now that we have the session ID
					this.setupLogging();
				}

				this.messages.push(message);

				// Log to detailed JSON log
				if (this.logStream) {
					const logEntry = {
						type: "sdk-message",
						message,
						timestamp: new Date().toISOString(),
					};
					this.logStream.write(`${JSON.stringify(logEntry)}\n`);
				}

				// Log to human-readable log
				if (this.readableLogStream) {
					this.writeReadableLogEntry(message);
				}

				// Emit appropriate events based on message type
				// Defer result message emission until after loop completes to avoid race conditions
				// where subroutine transitions start before the runner has fully cleaned up
				if (message.type === "result") {
					this.pendingResultMessage = message;
					// Complete streaming prompt immediately so it stops accepting input
					if (this.streamingPrompt) {
						console.log(
							"[ClaudeRunner] Got result message, completing streaming prompt",
						);
						this.streamingPrompt.complete();
					}
				} else {
					this.emit("message", message);
					this.processMessage(message);
				}
			}

			// Session completed successfully - mark as not running BEFORE emitting result
			// This ensures any code checking isRunning() during result processing sees the correct state
			console.log(
				`[ClaudeRunner] Session completed with ${this.messages.length} messages`,
			);
			this.sessionInfo.isRunning = false;

			// Emit deferred result message after marking isRunning = false
			if (this.pendingResultMessage) {
				this.emit("message", this.pendingResultMessage);
				this.processMessage(this.pendingResultMessage);
				this.pendingResultMessage = null;
			}

			this.emit("complete", this.messages);
		} catch (error) {
			if (this.sessionInfo) {
				this.sessionInfo.isRunning = false;
			}

			// Check for user-initiated abort - this is a normal operation, not an error
			// The SDK throws AbortError when the process is aborted via AbortController
			// We check by name since the SDK's AbortError class may not match our local definition
			const isAbortError =
				error instanceof Error &&
				(error.name === "AbortError" ||
					error.message.includes("aborted by user"));

			// Check for SIGTERM (exit code 143 = 128 + 15), which indicates graceful termination
			// This is expected when the session is stopped during unassignment
			const isSigterm =
				error instanceof Error &&
				error.message.includes("Claude Code process exited with code 143");

			if (isAbortError) {
				// User-initiated stop - log at info level, not error
				console.log("[ClaudeRunner] Session stopped by user");
			} else if (isSigterm) {
				console.log(
					"[ClaudeRunner] Session was terminated gracefully (SIGTERM)",
				);
			} else {
				// Actual error - log and emit
				console.error("[ClaudeRunner] Session error:", error);
				this.emit(
					"error",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		} finally {
			// Clean up
			this.abortController = null;
			this.pendingResultMessage = null;

			// Complete and clean up streaming prompt if it exists
			if (this.streamingPrompt) {
				this.streamingPrompt.complete();
				this.streamingPrompt = null;
			}

			// Close log streams
			if (this.logStream) {
				this.logStream.end();
				this.logStream = null;
			}
			if (this.readableLogStream) {
				this.readableLogStream.end();
				this.readableLogStream = null;
			}
		}

		return this.sessionInfo;
	}

	/**
	 * Update prompt versions (can be called after constructor)
	 */
	updatePromptVersions(versions: {
		userPromptVersion?: string;
		systemPromptVersion?: string;
	}): void {
		this.config.promptVersions = versions;

		// If logging has already been set up and we now have versions, write the version file
		if (this.logStream && versions) {
			try {
				const logsDir = join(this.cyrusHome, "logs");
				const workspaceName =
					this.config.workspaceName ||
					(this.config.workingDirectory
						? this.config.workingDirectory.split("/").pop()
						: "default") ||
					"default";
				const workspaceLogsDir = join(logsDir, workspaceName);
				const sessionId = this.sessionInfo?.sessionId || "pending";

				const versionFileName = `session-${sessionId}-versions.txt`;
				const versionFilePath = join(workspaceLogsDir, versionFileName);

				let versionContent = `Session: ${sessionId}\n`;
				versionContent += `Timestamp: ${new Date().toISOString()}\n`;
				versionContent += `Workspace: ${workspaceName}\n`;
				versionContent += "\nPrompt Template Versions:\n";

				if (versions.userPromptVersion) {
					versionContent += `User Prompt: ${versions.userPromptVersion}\n`;
				}
				if (versions.systemPromptVersion) {
					versionContent += `System Prompt: ${versions.systemPromptVersion}\n`;
				}

				writeFileSync(versionFilePath, versionContent);
				console.log(
					`[ClaudeRunner] Wrote prompt versions to: ${versionFilePath}`,
				);
			} catch (error) {
				console.error("[ClaudeRunner] Failed to write version file:", error);
			}
		}
	}

	/**
	 * Stop the current Claude session
	 */
	stop(): void {
		if (this.abortController) {
			console.log("[ClaudeRunner] Stopping Claude session");
			this.abortController.abort();
			this.abortController = null;
		}

		// Complete streaming prompt if in streaming mode
		if (this.streamingPrompt) {
			this.streamingPrompt.complete();
			this.streamingPrompt = null;
		}

		if (this.sessionInfo) {
			this.sessionInfo.isRunning = false;
		}
	}

	/**
	 * Check if session is running
	 */
	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	/**
	 * Check if session is in streaming mode and still running
	 */
	isStreaming(): boolean {
		return (
			this.streamingPrompt !== null &&
			!this.streamingPrompt.completed &&
			this.isRunning()
		);
	}

	/**
	 * Get current session info
	 */
	getSessionInfo(): ClaudeSessionInfo | null {
		return this.sessionInfo;
	}

	/**
	 * Get all messages from current session
	 */
	getMessages(): SDKMessage[] {
		return [...this.messages];
	}

	/**
	 * Get the message formatter for this runner
	 */
	getFormatter(): IMessageFormatter {
		return this.formatter;
	}

	/**
	 * Process individual SDK messages and emit appropriate events
	 */
	private processMessage(message: SDKMessage): void {
		switch (message.type) {
			case "assistant":
				if (
					message.message?.content &&
					Array.isArray(message.message.content)
				) {
					// Process content blocks
					for (const block of message.message.content) {
						if (block.type === "text") {
							this.emit("text", block.text);
							this.emit("assistant", block.text);
						} else if (block.type === "tool_use") {
							this.emit("tool-use", block.name, block.input);
						}
					}
				}
				break;

			case "user":
				// User messages don't typically need special processing
				break;

			case "result":
				// Result messages indicate completion
				break;

			case "system":
				// System messages are for initialization
				break;

			default:
				console.log(
					`[ClaudeRunner] Unhandled message type: ${(message as any).type}`,
				);
		}
	}

	/**
	 * Load environment variables from repository .env file
	 * Does not override existing process.env values
	 */
	private loadRepositoryEnv(workingDirectory: string): void {
		try {
			const envPath = join(workingDirectory, ".env");

			if (existsSync(envPath)) {
				// Load but don't override existing env vars
				const result = dotenv.config({
					path: envPath,
					override: false, // Existing process.env takes precedence
				});

				if (result.error) {
					console.warn(
						`[ClaudeRunner] Failed to parse .env file:`,
						result.error,
					);
				} else if (result.parsed && Object.keys(result.parsed).length > 0) {
					console.log(`[ClaudeRunner] Loaded environment variables from .env`);
				}
			}
		} catch (error) {
			console.warn(`[ClaudeRunner] Error loading repository .env:`, error);
			// Don't fail the session, just warn
		}
	}

	/**
	 * Set up logging to .cyrus directory
	 */
	private setupLogging(): void {
		try {
			// Close existing log streams if we're re-setting up with new session ID
			if (this.logStream) {
				this.logStream.end();
				this.logStream = null;
			}
			if (this.readableLogStream) {
				this.readableLogStream.end();
				this.readableLogStream = null;
			}

			// Create logs directory structure: <cyrusHome>/logs/<workspace-name>/
			const logsDir = join(this.cyrusHome, "logs");

			// Get workspace name from config or extract from working directory
			const workspaceName =
				this.config.workspaceName ||
				(this.config.workingDirectory
					? this.config.workingDirectory.split("/").pop()
					: "default") ||
				"default";
			const workspaceLogsDir = join(logsDir, workspaceName);

			// Create directories
			mkdirSync(workspaceLogsDir, { recursive: true });

			// Create log files with session ID and timestamp
			const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
			const sessionId = this.sessionInfo?.sessionId || "pending";

			// Detailed JSON log (existing)
			const detailedLogFileName = `session-${sessionId}-${timestamp}.jsonl`;
			const detailedLogPath = join(workspaceLogsDir, detailedLogFileName);

			// Human-readable log (new)
			const readableLogFileName = `session-${sessionId}-${timestamp}.md`;
			const readableLogPath = join(workspaceLogsDir, readableLogFileName);

			console.log(`[ClaudeRunner] Creating detailed log: ${detailedLogPath}`);
			console.log(`[ClaudeRunner] Creating readable log: ${readableLogPath}`);

			this.logStream = createWriteStream(detailedLogPath, { flags: "a" });
			this.readableLogStream = createWriteStream(readableLogPath, {
				flags: "a",
			});

			// Write initial metadata to detailed log
			const metadata = {
				type: "session-metadata",
				sessionId: this.sessionInfo?.sessionId,
				startedAt: this.sessionInfo?.startedAt?.toISOString(),
				workingDirectory: this.config.workingDirectory,
				workspaceName: workspaceName,
				promptVersions: this.config.promptVersions,
				timestamp: new Date().toISOString(),
			};
			this.logStream.write(`${JSON.stringify(metadata)}\n`);

			// Write readable log header
			const readableHeader =
				`# Claude Session Log\n\n` +
				`**Session ID:** ${sessionId}\n` +
				`**Started:** ${this.sessionInfo?.startedAt?.toISOString() || "Unknown"}\n` +
				`**Workspace:** ${workspaceName}\n` +
				`**Working Directory:** ${this.config.workingDirectory || "Not set"}\n\n` +
				`---\n\n`;

			this.readableLogStream.write(readableHeader);
		} catch (error) {
			console.error("[ClaudeRunner] Failed to set up logging:", error);
		}
	}

	/**
	 * Write a human-readable log entry for a message
	 */
	private writeReadableLogEntry(message: SDKMessage): void {
		if (!this.readableLogStream) return;

		const timestamp = new Date().toISOString().substring(11, 19); // HH:MM:SS format

		try {
			switch (message.type) {
				case "assistant":
					if (
						message.message?.content &&
						Array.isArray(message.message.content)
					) {
						// Extract text content only, skip tool use noise
						const textBlocks = message.message.content
							.filter((block) => block.type === "text")
							.map((block) => (block as { text: string }).text)
							.join("");

						if (textBlocks.trim()) {
							this.readableLogStream.write(
								`## ${timestamp} - Claude Response\n\n${textBlocks.trim()}\n\n`,
							);
						}

						// Log tool usage in a clean format, but filter out noisy tools
						const toolBlocks = message.message.content
							.filter((block) => block.type === "tool_use")
							.filter(
								(block) => (block as { name: string }).name !== "TodoWrite",
							); // Filter out TodoWrite as it's noisy

						if (toolBlocks.length > 0) {
							for (const tool of toolBlocks) {
								const toolWithName = tool as {
									name: string;
									input?: Record<string, unknown>;
								};
								this.readableLogStream.write(
									`### ${timestamp} - Tool: ${toolWithName.name}\n\n`,
								);
								if (
									toolWithName.input &&
									typeof toolWithName.input === "object"
								) {
									// Format tool input in a readable way
									const inputStr = Object.entries(toolWithName.input)
										.map(([key, value]) => `- **${key}**: ${value}`)
										.join("\n");
									this.readableLogStream.write(`${inputStr}\n\n`);
								}
							}
						}
					}
					break;

				case "user":
					// Only log user messages that contain actual content (not tool results)
					if (
						message.message?.content &&
						Array.isArray(message.message.content)
					) {
						const userContent = message.message.content
							.filter((block) => block.type === "text")
							.map((block) => (block as { text: string }).text)
							.join("");

						if (userContent.trim()) {
							this.readableLogStream.write(
								`## ${timestamp} - User\n\n${userContent.trim()}\n\n`,
							);
						}
					}
					break;

				case "result":
					if (message.subtype === "success") {
						this.readableLogStream.write(
							`## ${timestamp} - Session Complete\n\n`,
						);
						if (message.duration_ms) {
							this.readableLogStream.write(
								`**Duration**: ${message.duration_ms}ms\n`,
							);
						}
						if (message.total_cost_usd) {
							this.readableLogStream.write(
								`**Cost**: $${message.total_cost_usd.toFixed(4)}\n`,
							);
						}
						this.readableLogStream.write(`\n---\n\n`);
					}
					break;

				// Skip system messages, they're too noisy for readable log
				default:
					break;
			}
		} catch (error) {
			console.error("[ClaudeRunner] Error writing readable log entry:", error);
		}
	}
}
