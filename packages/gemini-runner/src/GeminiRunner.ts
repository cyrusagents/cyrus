import { type ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
	type IAgentRunner,
	type IMessageFormatter,
	type SDKAssistantMessage,
	type SDKMessage,
	type SDKResultMessage,
	type SDKUserMessage,
	StreamingPrompt,
} from "cyrus-core";
import { extractSessionId, geminiEventToSDKMessage } from "./adapters.js";
import { GeminiMessageFormatter } from "./formatter.js";
import {
	type GeminiStreamEvent,
	safeParseGeminiStreamEvent,
} from "./schemas.js";
import {
	autoDetectMcpConfig,
	convertToGeminiMcpConfig,
	type GeminiSettingsOptions,
	loadMcpConfigFromPaths,
	setupGeminiSettings,
} from "./settingsGenerator.js";
import { SystemPromptManager } from "./systemPromptManager.js";
import type {
	GeminiMcpServerConfig,
	GeminiRunnerConfig,
	GeminiRunnerEvents,
	GeminiSessionInfo,
} from "./types.js";

export declare interface GeminiRunner {
	on<K extends keyof GeminiRunnerEvents>(
		event: K,
		listener: GeminiRunnerEvents[K],
	): this;
	emit<K extends keyof GeminiRunnerEvents>(
		event: K,
		...args: Parameters<GeminiRunnerEvents[K]>
	): boolean;
}

/**
 * Manages Gemini CLI sessions and communication
 *
 * GeminiRunner implements the IAgentRunner interface to provide a provider-agnostic
 * wrapper around the Gemini CLI. It spawns the Gemini CLI process in headless mode
 * and translates between the CLI's JSON streaming format and Claude SDK message types.
 *
 * @example
 * ```typescript
 * const runner = new GeminiRunner({
 *   cyrusHome: '/home/user/.cyrus',
 *   workingDirectory: '/path/to/repo',
 *   model: 'gemini-2.5-flash',
 *   autoApprove: true
 * });
 *
 * // String mode
 * await runner.start("Analyze this codebase");
 *
 * // Streaming mode
 * await runner.startStreaming("Initial task");
 * runner.addStreamMessage("Additional context");
 * runner.completeStream();
 * ```
 */
export class GeminiRunner extends EventEmitter implements IAgentRunner {
	/**
	 * GeminiRunner does not support true streaming input.
	 * While startStreaming() exists, it only accepts an initial prompt and does not support
	 * addStreamMessage() for adding messages after the session starts.
	 */
	readonly supportsStreamingInput = false;

	private config: GeminiRunnerConfig;
	private process: ChildProcess | null = null;
	private sessionInfo: GeminiSessionInfo | null = null;
	private logStream: WriteStream | null = null;
	private readableLogStream: WriteStream | null = null;
	private messages: SDKMessage[] = [];
	private streamingPrompt: StreamingPrompt | null = null;
	private cyrusHome: string;
	// Delta message accumulation
	private accumulatingMessage: SDKMessage | null = null;
	private accumulatingRole: "user" | "assistant" | null = null;
	// Track last assistant message for result coercion
	private lastAssistantMessage: SDKAssistantMessage | null = null;
	// Settings cleanup function
	private settingsCleanup: (() => void) | null = null;
	// System prompt manager
	private systemPromptManager: SystemPromptManager;
	// Message formatter
	private formatter: IMessageFormatter;
	// Readline interface for stdout processing
	private readlineInterface: ReturnType<typeof createInterface> | null = null;
	// Deferred result message to emit after loop completes
	private pendingResultMessage: SDKMessage | null = null;

	constructor(config: GeminiRunnerConfig) {
		super();
		this.config = config;
		this.cyrusHome = config.cyrusHome;
		// Use workspaceName for unique system prompt file paths (supports parallel execution)
		const workspaceName = config.workspaceName || "default";
		this.systemPromptManager = new SystemPromptManager(
			config.cyrusHome,
			workspaceName,
		);
		// Use GeminiMessageFormatter for Gemini-specific tool names
		this.formatter = new GeminiMessageFormatter();

		// Forward config callbacks to events
		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	/**
	 * Start a new Gemini session with string prompt (legacy mode)
	 */
	async start(prompt: string): Promise<GeminiSessionInfo> {
		return this.startWithPrompt(prompt);
	}

	/**
	 * Start a new Gemini session with streaming input
	 */
	async startStreaming(initialPrompt?: string): Promise<GeminiSessionInfo> {
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

		// Write to stdin if process is running
		if (this.process?.stdin && !this.process.stdin.destroyed) {
			console.log(
				`[GeminiRunner] Writing to stdin (${content.length} chars): ${content.substring(0, 100)}...`,
			);
			this.process.stdin.write(`${content}\n`);
		} else {
			console.log(
				`[GeminiRunner] Cannot write to stdin - process stdin is ${this.process?.stdin ? "destroyed" : "null"}`,
			);
		}
	}

	/**
	 * Complete the streaming prompt (no more messages will be added)
	 */
	completeStream(): void {
		if (this.streamingPrompt) {
			this.streamingPrompt.complete();

			// Close stdin to signal completion to Gemini CLI
			if (this.process?.stdin && !this.process.stdin.destroyed) {
				this.process.stdin.end();
			}
		}
	}

	/**
	 * Get the last assistant message (used for result coercion)
	 */
	getLastAssistantMessage(): SDKAssistantMessage | null {
		return this.lastAssistantMessage;
	}

	/**
	 * Internal method to start a Gemini session with either string or streaming prompt
	 */
	private async startWithPrompt(
		stringPrompt?: string | null,
		streamingInitialPrompt?: string,
	): Promise<GeminiSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Gemini session already running");
		}

		// Initialize session info without session ID (will be set from init event)
		this.sessionInfo = {
			sessionId: null,
			startedAt: new Date(),
			isRunning: true,
		};

		console.log(
			`[GeminiRunner] Starting new session (session ID will be assigned by Gemini)`,
		);
		console.log(
			"[GeminiRunner] Working directory:",
			this.config.workingDirectory,
		);

		// Ensure working directory exists
		if (this.config.workingDirectory) {
			try {
				mkdirSync(this.config.workingDirectory, { recursive: true });
				console.log("[GeminiRunner] Created working directory");
			} catch (err) {
				console.error(
					"[GeminiRunner] Failed to create working directory:",
					err,
				);
			}
		}

		// Set up logging (initial setup without session ID)
		this.setupLogging();

		// Reset messages array
		this.messages = [];

		// Build MCP servers configuration
		const mcpServers = this.buildMcpServers();

		// Setup Gemini settings with MCP servers and maxTurns
		const settingsOptions: GeminiSettingsOptions = {};

		if (this.config.maxTurns) {
			settingsOptions.maxSessionTurns = this.config.maxTurns;
		}

		if (Object.keys(mcpServers).length > 0) {
			settingsOptions.mcpServers = mcpServers;
		}

		if (this.config.allowMCPServers) {
			settingsOptions.allowMCPServers = this.config.allowMCPServers;
		}

		if (this.config.excludeMCPServers) {
			settingsOptions.excludeMCPServers = this.config.excludeMCPServers;
		}

		// Only setup settings if we have something to configure
		if (Object.keys(settingsOptions).length > 0) {
			// Use project-scoped .gemini/settings.json when a working directory is set.
			this.settingsCleanup = setupGeminiSettings(
				settingsOptions,
				this.config.workingDirectory,
			);
		}

		try {
			// Build Gemini CLI command
			const geminiPath = this.config.geminiPath || "gemini";
			const args: string[] = ["--output-format", "stream-json"];

			// Add model if specified
			if (this.config.model) {
				args.push("--model", this.config.model);
			} else {
				// Default to gemini-2.5-pro
				args.push("--model", "gemini-2.5-pro");
			}

			// Add resume session flag if provided
			if (this.config.resumeSessionId) {
				args.push("-r", this.config.resumeSessionId);
				console.log(
					`[GeminiRunner] Resuming session: ${this.config.resumeSessionId}`,
				);
			}

			// This will be added in the future
			// Add auto-approve flags
			// if (this.config.autoApprove) {
			// 	args.push("--yolo");
			// }
			args.push("--yolo");

			if (this.config.approvalMode) {
				args.push("--approval-mode", this.config.approvalMode);
			}

			// Add debug flag
			if (this.config.debug) {
				args.push("--debug");
			}

			// Add include-directories flag if specified
			if (
				this.config.allowedDirectories &&
				this.config.allowedDirectories.length > 0
			) {
				args.push(
					"--include-directories",
					this.config.allowedDirectories.join(","),
				);
			}

			// Handle prompt mode
			let useStdin = false;
			let fullStreamingPrompt: string | undefined;
			if (stringPrompt !== null && stringPrompt !== undefined) {
				console.log(
					`[GeminiRunner] Starting with string prompt length: ${stringPrompt.length} characters`,
				);
				args.push("-p");
				args.push(stringPrompt);
			} else {
				// Streaming mode - use stdin
				fullStreamingPrompt = streamingInitialPrompt || undefined;
				console.log(`[GeminiRunner] Starting with streaming prompt`);
				this.streamingPrompt = new StreamingPrompt(null, fullStreamingPrompt);
				useStdin = true;
			}

			// Prepare environment variables for Gemini CLI
			const geminiEnv = { ...process.env };

			if (this.config.appendSystemPrompt) {
				try {
					const systemPromptPath =
						await this.systemPromptManager.prepareSystemPrompt(
							this.config.appendSystemPrompt,
						);
					geminiEnv.GEMINI_SYSTEM_MD = systemPromptPath;
					console.log(
						`[GeminiRunner] Prepared system prompt at: ${systemPromptPath}`,
					);
				} catch (error) {
					console.error(
						"[GeminiRunner] Failed to prepare system prompt, continuing without it:",
						error,
					);
				}
			}

			// Spawn Gemini CLI process
			console.log(`[GeminiRunner] Spawning: ${geminiPath} ${args.join(" ")}`);
			this.process = spawn(geminiPath, args, {
				cwd: this.config.workingDirectory,
				stdio: useStdin ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"],
				env: geminiEnv,
			});

			// IMPORTANT: Write initial streaming prompt to stdin immediately after spawn
			// This prevents gemini from hanging waiting for input.
			//
			// How gemini-cli stdin works (from packages/cli/src/utils/readStdin.ts):
			// 1. Has a 500ms timeout - if NO data arrives, assumes nothing is piped and returns empty
			// 2. Once data arrives, timeout is canceled and it waits for stdin to close ('end' event)
			// 3. Continues reading chunks as they arrive until stdin closes
			//
			// Therefore:
			// - We MUST write initial prompt immediately to cancel the 500ms timeout
			// - We MUST NOT close stdin here - keep it open for addStreamMessage() calls
			// - stdin.end() is called later in completeStream() when all messages are sent
			if (useStdin && fullStreamingPrompt && this.process.stdin) {
				console.log(
					`[GeminiRunner] Writing initial streaming prompt to stdin (${fullStreamingPrompt.length} chars): ${fullStreamingPrompt.substring(0, 150)}...`,
				);
				this.process.stdin.write(`${fullStreamingPrompt}\n`);
			} else if (useStdin) {
				console.log(
					`[GeminiRunner] Cannot write initial prompt - fullStreamingPrompt=${!!fullStreamingPrompt}, stdin=${!!this.process.stdin}`,
				);
			}

			// Set up stdout line reader for JSON events
			this.readlineInterface = createInterface({
				input: this.process.stdout!,
				crlfDelay: Infinity,
			});

			// Process each line as a JSON event with Zod validation
			this.readlineInterface.on("line", (line: string) => {
				const event = safeParseGeminiStreamEvent(line);
				if (event) {
					this.processStreamEvent(event);
				} else {
					console.error(
						"[GeminiRunner] Failed to parse/validate JSON event:",
						line,
					);
				}
			});

			// Handle stderr
			this.process.stderr?.on("data", (data: Buffer) => {
				console.error("[GeminiRunner] stderr:", data.toString());
			});

			// Wait for process to complete
			await new Promise<void>((resolve, reject) => {
				if (!this.process) {
					reject(new Error("Process not started"));
					return;
				}

				this.process.on("close", (code: number) => {
					console.log(`[GeminiRunner] Process exited with code ${code}`);
					if (code === 0) {
						resolve();
					} else {
						reject(new Error(`Gemini CLI exited with code ${code}`));
					}
				});

				this.process.on("error", (err: Error) => {
					console.error("[GeminiRunner] Process error:", err);
					reject(err);
				});
			});

			// Flush any remaining accumulated message
			this.flushAccumulatedMessage();

			// Session completed successfully - mark as not running BEFORE emitting result
			// This ensures any code checking isRunning() during result processing sees the correct state
			console.log(
				`[GeminiRunner] Session completed with ${this.messages.length} messages`,
			);
			this.sessionInfo.isRunning = false;

			// Emit deferred result message after marking isRunning = false
			if (this.pendingResultMessage) {
				this.emitMessage(this.pendingResultMessage);
				this.pendingResultMessage = null;
			}

			this.emit("complete", this.messages);
		} catch (error) {
			console.error("[GeminiRunner] Session error:", error);

			if (this.sessionInfo) {
				this.sessionInfo.isRunning = false;
			}

			// Emit error result message to maintain consistent message flow
			const errorMessage =
				error instanceof Error ? error.message : String(error);
			const errorResult: SDKResultMessage = {
				type: "result",
				subtype: "error_during_execution",
				duration_ms: Date.now() - this.sessionInfo!.startedAt.getTime(),
				duration_api_ms: 0,
				is_error: true,
				num_turns: 0,
				stop_reason: null,
				errors: [errorMessage],
				total_cost_usd: 0,
				usage: {
					input_tokens: 0,
					output_tokens: 0,
					cache_creation_input_tokens: 0,
					cache_read_input_tokens: 0,
					cache_creation: {
						ephemeral_1h_input_tokens: 0,
						ephemeral_5m_input_tokens: 0,
					},
					inference_geo: "unknown",
					iterations: [],
					server_tool_use: {
						web_fetch_requests: 0,
						web_search_requests: 0,
					},
					service_tier: "standard",
					speed: "standard",
				},
				modelUsage: {},
				permission_denials: [],
				uuid: crypto.randomUUID(),
				session_id: this.sessionInfo?.sessionId || "pending",
			};

			this.emitMessage(errorResult);

			this.emit(
				"error",
				error instanceof Error ? error : new Error(String(error)),
			);
		} finally {
			// Clean up
			this.process = null;
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

			// Restore Gemini settings
			if (this.settingsCleanup) {
				this.settingsCleanup();
				this.settingsCleanup = null;
			}
		}

		return this.sessionInfo;
	}

	/**
	 * Process a Gemini stream event and convert to SDK message
	 */
	private processStreamEvent(event: GeminiStreamEvent): void {
		console.log(
			`[GeminiRunner] Stream event: ${event.type}`,
			JSON.stringify(event).substring(0, 200),
		);

		// Emit raw stream event
		this.emit("streamEvent", event);

		// Extract session ID from init event
		const sessionId = extractSessionId(event);
		if (sessionId && !this.sessionInfo?.sessionId) {
			this.sessionInfo!.sessionId = sessionId;
			console.log(`[GeminiRunner] Session ID assigned: ${sessionId}`);

			// Update streaming prompt with session ID if it exists
			if (this.streamingPrompt) {
				this.streamingPrompt.updateSessionId(sessionId);
			}

			// Re-setup logging now that we have the session ID
			this.setupLogging();
		}

		// Handle delta message accumulation
		if (event.type === "message") {
			const messageEvent = event;

			// Check if this is a delta message
			if (messageEvent.delta === true) {
				// Accumulate delta message
				this.accumulateDeltaMessage(messageEvent);
				return; // Don't process further, just accumulate
			} else {
				// Not a delta message - flush any accumulated message first
				this.flushAccumulatedMessage();
			}
		} else {
			// Non-message event - flush any accumulated message
			this.flushAccumulatedMessage();
		}

		// Convert to SDK message format
		const message = geminiEventToSDKMessage(
			event,
			this.sessionInfo?.sessionId || null,
			this.lastAssistantMessage,
		);

		if (message) {
			// Track last assistant message for result coercion
			if (message.type === "assistant") {
				this.lastAssistantMessage = message;
			}
			// Defer result message emission until after loop completes to avoid race conditions
			// where subroutine transitions start before the runner has fully cleaned up
			if (message.type === "result") {
				this.pendingResultMessage = message;
			} else {
				this.emitMessage(message);
			}
		}
	}

	/**
	 * Accumulate a delta message (message with delta: true)
	 */
	private accumulateDeltaMessage(
		event: GeminiStreamEvent & { type: "message" },
	): void {
		console.log(
			`[GeminiRunner] Accumulating delta message (role: ${event.role})`,
		);

		// If role changed or no accumulating message exists, start new accumulation
		if (!this.accumulatingMessage || this.accumulatingRole !== event.role) {
			// Flush previous accumulation if exists
			this.flushAccumulatedMessage();

			// Start new accumulation using Claude SDK format (array of content blocks)
			if (event.role === "user") {
				this.accumulatingMessage = {
					type: "user",
					message: {
						role: "user",
						content: [{ type: "text", text: event.content }],
					},
					parent_tool_use_id: null,
					session_id: this.sessionInfo?.sessionId || "pending",
				} as SDKUserMessage;
			} else {
				// assistant role
				this.accumulatingMessage = {
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: event.content }],
					},
					session_id: this.sessionInfo?.sessionId || "pending",
				} as unknown as SDKMessage;
			}
			this.accumulatingRole = event.role;
		} else {
			// Same role - append content to existing text block
			if (
				this.accumulatingMessage.type === "user" ||
				this.accumulatingMessage.type === "assistant"
			) {
				const currentContent = this.accumulatingMessage.message.content;
				if (Array.isArray(currentContent) && currentContent.length > 0) {
					const lastBlock = currentContent[currentContent.length - 1];
					if (lastBlock && lastBlock.type === "text" && "text" in lastBlock) {
						lastBlock.text += event.content;
					}
				}
			}
		}
	}

	/**
	 * Flush the accumulated delta message
	 */
	private flushAccumulatedMessage(): void {
		if (this.accumulatingMessage) {
			console.log(
				`[GeminiRunner] Flushing accumulated message (role: ${this.accumulatingRole})`,
			);

			// Track last assistant message for result coercion BEFORE emitting
			if (this.accumulatingMessage.type === "assistant") {
				this.lastAssistantMessage = this.accumulatingMessage;
			}

			this.emitMessage(this.accumulatingMessage);
			this.accumulatingMessage = null;
			this.accumulatingRole = null;
		}
	}

	/**
	 * Emit a message (add to messages array, log, and emit event)
	 */
	private emitMessage(message: SDKMessage): void {
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

		// Emit message event
		this.emit("message", message);
	}

	/**
	 * Stop the current Gemini session
	 */
	stop(): void {
		// Flush any accumulated message before stopping
		this.flushAccumulatedMessage();

		// Close readline interface first to stop processing stdout
		if (this.readlineInterface) {
			// Close() method stops the readline interface from emitting further events
			// and allows cleanup of underlying streams
			if (typeof this.readlineInterface.close === "function") {
				this.readlineInterface.close();
			}
			this.readlineInterface.removeAllListeners();
			this.readlineInterface = null;
		}

		if (this.process) {
			console.log("[GeminiRunner] Stopping Gemini process");
			this.process.kill("SIGTERM");
			this.process = null;
		}

		if (this.sessionInfo) {
			this.sessionInfo.isRunning = false;
		}

		// Complete streaming prompt if active
		if (this.streamingPrompt) {
			this.streamingPrompt.complete();
		}

		// Restore Gemini settings
		if (this.settingsCleanup) {
			this.settingsCleanup();
			this.settingsCleanup = null;
		}
	}

	/**
	 * Check if the session is currently running
	 */
	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	/**
	 * Get all messages from the current session
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
	 * Build MCP servers configuration from config paths and inline config
	 *
	 * MCP configuration loading follows a layered approach:
	 * 1. Auto-detect .mcp.json in working directory (base config)
	 * 2. Load from explicitly configured paths via mcpConfigPath (extends/overrides)
	 * 3. Merge inline mcpConfig (highest priority, overrides file configs)
	 *
	 * HTTP-based MCP servers (like Linear's https://mcp.linear.app/mcp) are filtered out
	 * since Gemini CLI only supports stdio (command-based) MCP servers.
	 *
	 * @returns Record of MCP server name to GeminiMcpServerConfig
	 */
	private buildMcpServers(): Record<string, GeminiMcpServerConfig> {
		const geminiMcpServers: Record<string, GeminiMcpServerConfig> = {};

		// Build config paths list, starting with auto-detected .mcp.json
		const configPaths: string[] = [];

		// 1. Auto-detect .mcp.json in working directory
		const autoDetectedPath = autoDetectMcpConfig(this.config.workingDirectory);
		if (autoDetectedPath) {
			configPaths.push(autoDetectedPath);
		}

		// 2. Add explicitly configured paths
		if (this.config.mcpConfigPath) {
			const explicitPaths = Array.isArray(this.config.mcpConfigPath)
				? this.config.mcpConfigPath
				: [this.config.mcpConfigPath];
			configPaths.push(...explicitPaths);
		}

		// Load from all config paths
		const fileBasedServers = loadMcpConfigFromPaths(
			configPaths.length > 0 ? configPaths : undefined,
		);

		// 3. Merge inline config (overrides file-based config)
		const allServers = this.config.mcpConfig
			? { ...fileBasedServers, ...this.config.mcpConfig }
			: fileBasedServers;

		// Convert each server to Gemini format
		for (const [serverName, serverConfig] of Object.entries(allServers)) {
			const geminiConfig = convertToGeminiMcpConfig(serverName, serverConfig);
			if (geminiConfig) {
				geminiMcpServers[serverName] = geminiConfig;
			}
		}

		if (Object.keys(geminiMcpServers).length > 0) {
			console.log(
				`[GeminiRunner] Configured ${Object.keys(geminiMcpServers).length} MCP server(s): ${Object.keys(geminiMcpServers).join(", ")}`,
			);
		}

		return geminiMcpServers;
	}

	/**
	 * Set up logging streams for this session
	 */
	private setupLogging(): void {
		const logsDir = join(this.cyrusHome, "logs");
		const workspaceName =
			this.config.workspaceName ||
			(this.config.workingDirectory
				? this.config.workingDirectory.split("/").pop()
				: "default") ||
			"default";
		const workspaceLogsDir = join(logsDir, workspaceName);
		const sessionId = this.sessionInfo?.sessionId || "pending";

		// Close existing streams if they exist
		if (this.logStream) {
			this.logStream.end();
		}
		if (this.readableLogStream) {
			this.readableLogStream.end();
		}

		// Ensure logs directory exists
		mkdirSync(workspaceLogsDir, { recursive: true });

		// Create log streams
		const logPath = join(workspaceLogsDir, `${sessionId}.ndjson`);
		const readableLogPath = join(workspaceLogsDir, `${sessionId}.log`);

		console.log(`[GeminiRunner] Logging to: ${logPath}`);
		console.log(`[GeminiRunner] Readable log: ${readableLogPath}`);

		this.logStream = createWriteStream(logPath, { flags: "a" });
		this.readableLogStream = createWriteStream(readableLogPath, { flags: "a" });

		// Log session start
		const startEntry = {
			type: "session-start",
			sessionId,
			timestamp: new Date().toISOString(),
			config: {
				model: this.config.model,
				workingDirectory: this.config.workingDirectory,
			},
		};
		this.logStream.write(`${JSON.stringify(startEntry)}\n`);
		this.readableLogStream.write(
			`=== Session ${sessionId} started at ${new Date().toISOString()} ===\n\n`,
		);
	}

	/**
	 * Write a human-readable log entry for a message
	 */
	private writeReadableLogEntry(message: SDKMessage): void {
		if (!this.readableLogStream) return;

		const timestamp = new Date().toISOString();
		this.readableLogStream.write(`[${timestamp}] ${message.type}\n`);

		if (message.type === "user" || message.type === "assistant") {
			const content =
				typeof message.message.content === "string"
					? message.message.content
					: JSON.stringify(message.message.content, null, 2);
			this.readableLogStream.write(`${content}\n\n`);
		} else {
			// Other message types (system, result, etc.)
			this.readableLogStream.write(`${JSON.stringify(message, null, 2)}\n\n`);
		}
	}
}
