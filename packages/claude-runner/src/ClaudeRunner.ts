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
	type Query,
	query,
	type SDKMessage,
	type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionInput } from "cyrus-core";
import {
	createLogger,
	type IAgentRunner,
	type ILogger,
	LogLevel,
	StreamingPrompt,
} from "cyrus-core";
import dotenv from "dotenv";
import { ClaudeMessageFormatter, type IMessageFormatter } from "./formatter.js";
import { buildHomeDirectoryDisallowedTools } from "./home-directory-restrictions.js";
import {
	checkLinuxSandboxRequirements,
	logSandboxRequirementFailures,
} from "./sandbox-requirements.js";
import {
	buildBaseSessionEnv,
	normalizeMcpHttpTransport,
} from "./session-env.js";
import type {
	ClaudeRunnerConfig,
	ClaudeRunnerEvents,
	ClaudeSessionInfo,
} from "./types.js";

// AbortError is no longer exported in v1.0.95, so we define it locally
export class AbortError extends Error {
	constructor(message?: string) {
		super(message);
		this.name = "AbortError";
	}
}

/**
 * JSON.stringify replacer for Claude query options. The SDK's query options
 * include non-serializable members (AbortController, async iterables,
 * callbacks, pre-warmed sessions) — replace them with diagnostic placeholders
 * so debug logs remain valid JSON.
 */
function serializeQueryOptionsReplacer(_key: string, value: unknown): unknown {
	if (typeof value === "function") {
		return `[Function${value.name ? `: ${value.name}` : ""}]`;
	}
	if (value instanceof AbortController) {
		return "[AbortController]";
	}
	if (
		value !== null &&
		typeof value === "object" &&
		Symbol.asyncIterator in (value as object)
	) {
		return "[AsyncIterable]";
	}
	return value;
}

/**
 * Build a Sentry-safe projection of the resolved Claude query options.
 *
 * Why not just stringify the full object: Sentry's server-side data scrubbing
 * pattern-matches the entire string value of an attribute. If any substring
 * looks token-shaped (e.g. nested env vars, MCP server header values, system
 * prompts that mention auth/token/password keywords), Sentry replaces the
 * whole `options` field with `[Filtered]` — costing the entire diagnostic
 * payload, not just the offending substring.
 *
 * The projection drops everything that ever holds opaque secrets or
 * unbounded prose (env, mcpServers' inner config, the prompt, system prompt
 * append text, hook scripts, additionalEnv) and keeps only the configuration
 * surface useful for triaging "what was Claude invoked with":
 *   - model / fallbackModel / maxTurns / outputFormat
 *   - system prompt SHAPE (type/preset/has-append) — not the text
 *   - tool allowlist/denylist (counts + first 50 entries)
 *   - resumeSessionId, workingDirectory, allowedDirectories
 *   - mcpServer NAMES only
 *   - presence flags for hooks/plugins/canUseTool/sandbox
 *   - env KEY NAMES only (no values)
 *
 * Local DEBUG logging still emits the full untruncated JSON so on-machine
 * troubleshooting is unaffected.
 */
type SanitizedQueryOptions = Record<string, unknown>;

function buildSanitizedQueryOptions(
	queryOptions: Parameters<typeof query>[0],
): SanitizedQueryOptions {
	const o = (queryOptions.options ?? {}) as Record<string, unknown>;
	const out: SanitizedQueryOptions = {};

	if (typeof o.model === "string") out.model = o.model;
	if (typeof o.fallbackModel === "string") out.fallbackModel = o.fallbackModel;
	if (typeof o.maxTurns === "number") out.maxTurns = o.maxTurns;
	if (typeof o.outputFormat === "string") out.outputFormat = o.outputFormat;
	if (typeof o.cwd === "string") out.cwd = o.cwd;
	if (Array.isArray(o.allowedDirectories)) {
		out.allowedDirectoryCount = (o.allowedDirectories as unknown[]).length;
	}
	if (Array.isArray(o.settingSources)) {
		out.settingSources = o.settingSources;
	}
	if (typeof o.resume === "string") {
		out.resumeSessionId = o.resume;
	}
	if (typeof o.permissionMode === "string") {
		out.permissionMode = o.permissionMode;
	}

	// System prompt — keep the shape, not the prose. Append text routinely
	// contains long form documentation that may include token/auth keywords.
	if (o.systemPrompt && typeof o.systemPrompt === "object") {
		const sp = o.systemPrompt as Record<string, unknown>;
		out.systemPrompt = {
			type: sp.type,
			preset: sp.preset,
			hasAppend: typeof sp.append === "string" && sp.append.length > 0,
			appendLength: typeof sp.append === "string" ? sp.append.length : 0,
		};
	}

	// Tool allow/deny lists — bound the size so a 5000-entry list doesn't
	// itself blow the attribute cap. Tool names like `Read(/abs/path/**)`
	// are diagnostic gold and don't carry secrets.
	const TOOL_LIST_PREVIEW = 50;
	if (Array.isArray(o.allowedTools)) {
		const arr = o.allowedTools as string[];
		out.allowedToolsCount = arr.length;
		out.allowedToolsPreview = arr.slice(0, TOOL_LIST_PREVIEW);
	}
	if (Array.isArray(o.disallowedTools)) {
		const arr = o.disallowedTools as string[];
		out.disallowedToolsCount = arr.length;
		out.disallowedToolsPreview = arr.slice(0, TOOL_LIST_PREVIEW);
	}

	// MCP servers — names only. Inner config carries auth headers, URLs with
	// tokens in query strings, etc.
	if (o.mcpServers && typeof o.mcpServers === "object") {
		out.mcpServerNames = Object.keys(o.mcpServers as object);
	}

	// Env — key names only, no values. Spreads `process.env`, so values are
	// inherently sensitive.
	if (o.env && typeof o.env === "object") {
		const envKeys = Object.keys(o.env as object);
		out.envKeyCount = envKeys.length;
		// First 100 names is plenty to confirm what flowed through.
		out.envKeyNamesPreview = envKeys.slice(0, 100);
	}

	// Presence flags rather than payload for opaque/large fields.
	out.hasHooks = !!o.hooks;
	out.hasPlugins =
		Array.isArray(o.plugins) && (o.plugins as unknown[]).length > 0;
	out.hasCanUseTool = typeof o.canUseTool === "function";
	out.hasSandbox = !!o.sandbox;
	out.hasExtraArgs = !!o.extraArgs;
	out.hasPathToClaudeCodeExecutable =
		typeof o.pathToClaudeCodeExecutable === "string";

	return out;
}

/**
 * Flatten the sanitized query options into a set of primitive Sentry Logs
 * attributes. Sentry attribute values must be primitives, so arrays and
 * nested objects are joined into newline-separated strings (preview values
 * are already bounded). Each top-level datum gets its own attribute key so a
 * stray match in any one field can't filter the whole payload — and short
 * scalar values rarely trip Sentry's pattern matchers in the first place.
 */
function flattenSanitizedQueryOptions(
	sanitized: SanitizedQueryOptions,
): Record<string, string | number | boolean | null | undefined> {
	const ATTR_PREFIX = "cqo.";
	const out: Record<string, string | number | boolean | null | undefined> = {};
	for (const [key, value] of Object.entries(sanitized)) {
		const attrKey = `${ATTR_PREFIX}${key}`;
		if (value === null || value === undefined) continue;
		if (
			typeof value === "string" ||
			typeof value === "number" ||
			typeof value === "boolean"
		) {
			out[attrKey] = value;
			continue;
		}
		if (Array.isArray(value)) {
			out[attrKey] = (value as unknown[]).map(String).join("\n");
			continue;
		}
		if (typeof value === "object") {
			// Nested object (e.g. systemPrompt summary). Stringify but keep it
			// short — these summaries are intentionally tiny.
			try {
				out[attrKey] = JSON.stringify(value);
			} catch {
				out[attrKey] = "[unserialisable]";
			}
		}
	}
	return out;
}

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
	private logger: ILogger;
	private abortController: AbortController | null = null;
	private sessionInfo: ClaudeSessionInfo | null = null;
	private logStream: WriteStream | null = null;
	private readableLogStream: WriteStream | null = null;
	private messages: SDKMessage[] = [];
	private streamingPrompt: StreamingPrompt | null = null;
	private activeQuery: Query | null = null;
	private cyrusHome: string;
	private formatter: IMessageFormatter;
	private pendingResultMessage: SDKMessage | null = null;
	private canUseToolCallback: CanUseTool | undefined;
	private repositoryEnv: Record<string, string> = {};
	private keepSessionWarm: boolean;

	constructor(config: ClaudeRunnerConfig, keepSessionWarm = false) {
		super();
		this.config = config;
		this.keepSessionWarm = keepSessionWarm;
		this.logger = config.logger ?? createLogger({ component: "ClaudeRunner" });
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

			this.logger.debug(
				`Intercepted AskUserQuestion tool call (toolUseID: ${options.toolUseID})`,
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
				this.logger.warn(
					`Rejecting AskUserQuestion with ${askInput.questions.length} questions (only 1 allowed)`,
				);
				return {
					behavior: "deny",
					message:
						"Only one question at a time is supported. Please ask each question separately.",
				};
			}

			// Validate the onAskUserQuestion callback exists
			if (!this.config.onAskUserQuestion) {
				this.logger.error("onAskUserQuestion callback not configured");
				return {
					behavior: "deny",
					message: "AskUserQuestion handler not configured",
				};
			}

			// Get the session ID (required for tracking)
			const sessionId = this.sessionInfo?.sessionId;
			if (!sessionId) {
				this.logger.error("Cannot handle AskUserQuestion without session ID");
				return {
					behavior: "deny",
					message: "Session not initialized",
				};
			}

			try {
				// Delegate to the onAskUserQuestion callback
				this.logger.debug(
					`Delegating AskUserQuestion to callback for session ${sessionId}`,
				);

				const result = await this.config.onAskUserQuestion(
					askInput,
					sessionId,
					options.signal,
				);

				if (result.answered && result.answers) {
					this.logger.debug(
						`User answered AskUserQuestion for session ${sessionId}`,
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
					this.logger.debug(
						`User denied AskUserQuestion for session ${sessionId}: ${result.message}`,
					);
					return {
						behavior: "deny",
						message: result.message || "User did not respond to the question",
					};
				}
			} catch (error) {
				const errorMessage = (error as Error).message || String(error);
				this.logger.error(`Error handling AskUserQuestion: ${errorMessage}`);
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

		const isResumed = !!this.config.resumeSessionId;
		this.logger.event(isResumed ? "session_resumed" : "session_started", {
			resumeSessionId: this.config.resumeSessionId,
			workingDirectory: this.config.workingDirectory,
			model: this.config.model,
			fallbackModel: this.config.fallbackModel,
		});
		this.logger.debug("Working directory:", this.config.workingDirectory);

		// Ensure working directory exists
		if (this.config.workingDirectory) {
			try {
				mkdirSync(this.config.workingDirectory, { recursive: true });
			} catch (err) {
				this.logger.error("Failed to create working directory:", err);
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
				this.logger.debug(
					`Starting query with string prompt length: ${stringPrompt.length} characters`,
				);
				promptForQuery = stringPrompt;
			} else {
				// Streaming mode
				this.logger.debug("Starting query with streaming prompt");
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

			// Build home directory restrictions: deny Read on everything in ~/
			// that is not an ancestor of the working directory. This prevents
			// Claude from reading SSH keys, credentials, etc. `Read(~/**)` does
			// not work as a disallowedTools pattern — `~` is not expanded to the
			// home directory path, so the pattern never matches.
			const homeDisallowedTools = this.config.workingDirectory
				? buildHomeDirectoryDisallowedTools(
						this.config.workingDirectory,
						this.config.allowedDirectories ?? [],
					)
				: [];

			// Merge config-level denials with home directory denials, deduplicating in case
			// any paths appear in both (e.g. an allowedDirectory that is also explicitly denied).
			const processedDisallowedTools = [
				...new Set([
					...(this.config.disallowedTools ?? []),
					...homeDisallowedTools,
				]),
			];

			// Log disallowed tools if configured
			if (processedDisallowedTools.length > 0) {
				this.logger.debug(
					"Disallowed tools configured:",
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
						this.logger.debug(`Auto-detected MCP config at ${autoMcpPath}`);
					} catch (_error) {
						// Silently skip invalid .mcp.json files (could be test fixtures, etc.)
						this.logger.debug(`Skipping invalid .mcp.json at ${autoMcpPath}`);
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
					normalizeMcpHttpTransport(servers);
					mcpServers = { ...mcpServers, ...servers };
					this.logger.debug(
						`Loaded MCP servers from ${path}: ${Object.keys(servers).join(", ")}`,
					);
				} catch (error) {
					this.logger.error(`Failed to load MCP config from ${path}:`, error);
				}
			}

			// Finally, merge inline config (overrides file config for same server names)
			if (this.config.mcpConfig) {
				mcpServers = { ...mcpServers, ...this.config.mcpConfig };
				this.logger.debug(
					`Final MCP servers after merge: ${Object.keys(mcpServers).join(", ")}`,
				);
			}

			// Log allowed directories if configured
			if (this.config.allowedDirectories) {
				this.logger.debug(
					"Allowed directories configured:",
					this.config.allowedDirectories,
				);
			}

			const pathToClaudeCodeExecutable = this.config.pathToClaudeCodeExecutable;

			// On Linux, setting CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1 causes the SDK
			// to run tool invocations under a bubblewrap-backed sandbox. If the
			// host lacks `socat`, `bubblewrap`, or the kernel/AppArmor config
			// needed to create an unprivileged user namespace, the sandbox will
			// fail at runtime. Check those requirements up front so we can fall
			// back to unscrubbed env (and log resolution guidance to stdout)
			// instead of failing opaquely mid-session.
			const sandboxRequirements = checkLinuxSandboxRequirements();
			logSandboxRequirementFailures(sandboxRequirements, this.logger);

			const isDebugLogging = this.logger.getLevel() === LogLevel.DEBUG;

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
						...buildBaseSessionEnv(),
						// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally NOT set while
						// the Linux bubblewrap sandbox side effects it triggers are being
						// investigated. The sandbox requirements precheck is still run
						// above so the diagnostics remain available when we re-enable.
						// See: CYPACK-1108.
						...this.repositoryEnv,
						...this.config.additionalEnv,
						// When logging at DEBUG level, enable the SDK's own debug output so
						// --debug-to-stderr and DEBUG=1 propagate to the Claude subprocess.
						...(isDebugLogging && { DEBUG_CLAUDE_AGENT_SDK: "1" }),
					},
					...(this.config.workingDirectory && {
						cwd: this.config.workingDirectory,
					}),
					...(this.config.allowedDirectories && {
						allowedDirectories: this.config.allowedDirectories,
					}),
					...(processedAllowedTools && { allowedTools: processedAllowedTools }),
					...(processedDisallowedTools.length > 0 && {
						disallowedTools: processedDisallowedTools,
					}),
					...(this.canUseToolCallback && {
						canUseTool: this.canUseToolCallback,
					}),
					...(this.config.resumeSessionId && {
						resume: this.config.resumeSessionId,
					}),
					...(this.config.sessionStore && {
						sessionStore: this.config.sessionStore,
					}),
					...(Object.keys(mcpServers).length > 0 && { mcpServers }),
					...(this.config.hooks && { hooks: this.config.hooks }),
					...(this.config.plugins?.length && { plugins: this.config.plugins }),
					...(this.config.tools !== undefined && { tools: this.config.tools }),
					...(this.config.maxTurns && { maxTurns: this.config.maxTurns }),
					...(this.config.outputFormat && {
						outputFormat: this.config.outputFormat,
					}),
					...(this.config.sandbox && { sandbox: this.config.sandbox }),
					...(this.config.extraArgs && { extraArgs: this.config.extraArgs }),
					...(pathToClaudeCodeExecutable && { pathToClaudeCodeExecutable }),
				},
			};

			// Local DEBUG console keeps the full untruncated payload — useful
			// when troubleshooting on the host machine where secrets aren't an
			// issue.
			if (isDebugLogging) {
				const serializedQueryOptions = JSON.stringify(
					queryOptions,
					serializeQueryOptionsReplacer,
					2,
				);
				this.logger.debug(`Claude query options: ${serializedQueryOptions}`);
			}
			// What ships to Sentry is a flattened set of primitive attributes,
			// not a single nested-JSON string. A long JSON value attached
			// under a single key (we tried `options`) gets pattern-matched by
			// Sentry's server-side scrubber and replaced with `[Filtered]`,
			// wiping the entire diagnostic payload. Sending each datum as its
			// own short, primitive attribute avoids that — short non-credential
			// values don't trip the matcher, and a per-key filter (if it ever
			// fires) only loses one attribute, not the whole payload.
			const flat = flattenSanitizedQueryOptions(
				buildSanitizedQueryOptions(queryOptions),
			);
			this.logger.event("claude_query_options", flat);

			// Process messages from the query
			// Use pre-warmed session if available (eliminates cold-start subprocess spawn cost).
			// warmSession.query() accepts both string and AsyncIterable<SDKUserMessage>,
			// so promptForQuery works correctly for both start() and startStreaming().
			if (this.config.warmSession) {
				this.logger.debug("Using pre-warmed session for first turn");
				this.activeQuery = this.config.warmSession.query(promptForQuery);
			} else {
				this.activeQuery = query(queryOptions);
			}
			for await (const message of this.activeQuery) {
				if (!this.sessionInfo?.isRunning) {
					this.logger.info("Session was stopped, breaking from query loop");
					break;
				}

				// Extract session ID from first message if we don't have one yet
				if (!this.sessionInfo.sessionId && message.session_id) {
					this.sessionInfo.sessionId = message.session_id;
					this.logger.event("claude_session_id_assigned", {
						claudeSessionId: message.session_id,
					});

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

				// Emit all messages (including result) immediately in-loop.
				// When keepSessionWarm is true, the streamingPrompt stays open for
				// follow-up messages so the SDK session can be reused. Otherwise we
				// complete the streaming prompt on result so the for-await loop exits
				// and the subprocess can shut down (pre-warm-sessions behavior).
				this.logger.event("message_emitted", {
					messageType: message.type,
					claudeSessionId: this.sessionInfo?.sessionId,
				});
				this.emit("message", message);
				this.processMessage(message);
				if (
					message.type === "result" &&
					!this.keepSessionWarm &&
					this.streamingPrompt
				) {
					this.streamingPrompt.complete();
				}
			}

			this.activeQuery = null;

			// Session completed successfully - mark as not running BEFORE emitting result
			// This ensures any code checking isRunning() during result processing sees the correct state
			this.logger.event("session_completed", {
				messageCount: this.messages.length,
				claudeSessionId: this.sessionInfo?.sessionId,
			});
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
				this.logger.event("session_stopped", {
					reason: "user_abort",
					claudeSessionId: this.sessionInfo?.sessionId,
				});
			} else if (isSigterm) {
				this.logger.event("session_stopped", {
					reason: "sigterm",
					claudeSessionId: this.sessionInfo?.sessionId,
				});
			} else {
				// Actual error - log and emit
				this.logger.error("Session error:", error);
				this.emit(
					"error",
					error instanceof Error ? error : new Error(String(error)),
				);
			}
		} finally {
			// Clean up
			this.abortController = null;
			this.activeQuery = null;
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
				this.logger.debug(`Wrote prompt versions to: ${versionFilePath}`);
			} catch (error) {
				this.logger.error("Failed to write version file:", error);
			}
		}
	}

	/**
	 * Interrupt the current turn without killing the session.
	 * The session stays warm and can accept new messages.
	 *
	 * Only safe to call on warm sessions (see {@link isWarm}). Calling
	 * `interrupt()` on a non-warm session aborts the underlying request and
	 * causes the SDK to emit a "Request was aborted" error. Callers should
	 * gate on `isWarm()` and prefer `stop()` for non-warm sessions.
	 */
	async interrupt(): Promise<void> {
		if (!this.keepSessionWarm) {
			this.logger.debug(
				"interrupt() called on non-warm session; falling back to stop()",
			);
			this.stop();
			return;
		}
		if (this.activeQuery) {
			this.logger.info("Interrupting current turn");
			await this.activeQuery.interrupt();
		} else {
			this.logger.debug("interrupt() called but no active query");
		}
	}

	/**
	 * Whether this runner keeps its SDK session warm between turns. Warm
	 * sessions can be safely interrupted; non-warm sessions cannot.
	 */
	isWarm(): boolean {
		return this.keepSessionWarm;
	}

	/**
	 * Stop the current Claude session
	 */
	stop(): void {
		if (this.abortController) {
			this.logger.event("session_stop_requested", {
				claudeSessionId: this.sessionInfo?.sessionId,
			});
			this.abortController.abort();
			this.abortController = null;
		}

		// Complete streaming prompt if in streaming mode
		if (this.streamingPrompt) {
			this.streamingPrompt.complete();
			this.streamingPrompt = null;
		}

		this.activeQuery = null;

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

			case "rate_limit_event":
			case "stream_event":
			case "tool_progress":
			case "auth_status":
			case "tool_use_summary":
			case "prompt_suggestion":
				// Informational events handled upstream by AgentSessionManager
				break;

			default:
				this.logger.debug(`Unhandled message type: ${(message as any).type}`);
		}
	}

	/**
	 * Load environment variables from repository .env file into an isolated
	 * object. The parsed vars are merged only into the child subprocess env,
	 * never into the EdgeWorker's own process.env, so different sessions
	 * (potentially across different repositories) cannot poison each other.
	 * Re-reads the file on every call so updated/removed vars take effect.
	 */
	private loadRepositoryEnv(workingDirectory: string): void {
		try {
			const envPath = join(workingDirectory, ".env");

			if (existsSync(envPath)) {
				const content = readFileSync(envPath, "utf8");
				const parsed = dotenv.parse(content);

				// Store as isolated per-session env — replaces any previous load
				this.repositoryEnv = parsed;

				if (Object.keys(parsed).length > 0) {
					this.logger.debug("Loaded environment variables from .env");
				}
			} else {
				// No .env file — clear any previously loaded vars
				this.repositoryEnv = {};
			}
		} catch (error) {
			this.logger.warn("Error loading repository .env:", error);
			// Don't fail the session, just warn
			this.repositoryEnv = {};
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

			this.logger.debug(`Creating detailed log: ${detailedLogPath}`);
			this.logger.debug(`Creating readable log: ${readableLogPath}`);

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
			this.logger.error("Failed to set up logging:", error);
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
							.filter((block: any) => block.type === "text")
							.map((block: any) => (block as { text: string }).text)
							.join("");

						if (textBlocks.trim()) {
							this.readableLogStream.write(
								`## ${timestamp} - Claude Response\n\n${textBlocks.trim()}\n\n`,
							);
						}

						// Log tool usage in a clean format, but filter out noisy tools
						const toolBlocks = message.message.content
							.filter((block: any) => block.type === "tool_use")
							.filter(
								(block: any) =>
									(block as { name: string }).name !== "TodoWrite",
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
							.filter((block: any) => block.type === "text")
							.map((block: any) => (block as { text: string }).text)
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
			this.logger.error("Error writing readable log entry:", error);
		}
	}
}
