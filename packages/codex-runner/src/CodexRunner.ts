import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative as pathRelative } from "node:path";
import { cwd } from "node:process";
import type {
	CommandExecutionItem,
	FileChangeItem,
	McpToolCallItem,
	Thread,
	ThreadItem,
	ThreadOptions,
	TodoListItem,
	Usage,
	WebSearchItem,
} from "@openai/codex-sdk";
import { Codex } from "@openai/codex-sdk";
import type {
	IAgentRunner,
	IMessageFormatter,
	McpServerConfig,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import { CodexMessageFormatter } from "./formatter.js";
import type {
	CodexConfigOverrides,
	CodexConfigValue,
	CodexJsonEvent,
	CodexRunnerConfig,
	CodexRunnerEvents,
	CodexSessionInfo,
} from "./types.js";

type SDKSystemInitMessage = Extract<
	SDKMessage,
	{ type: "system"; subtype: "init" }
>;

interface ParsedUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
}

type ToolInput = Record<string, unknown>;

interface ToolProjection {
	toolUseId: string;
	toolName: string;
	toolInput: ToolInput;
	result: string;
	isError: boolean;
}

const DEFAULT_CODEX_MODEL = "gpt-5.3-codex";
const CODEX_MCP_DOCS_URL = "https://platform.openai.com/docs/docs-mcp";

function toFiniteNumber(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function createAssistantToolUseMessage(
	toolUseId: string,
	toolName: string,
	toolInput: ToolInput,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	const contentBlocks = [
		{
			type: "tool_use",
			id: toolUseId,
			name: toolName,
			input: toolInput,
		},
	] as unknown as SDKAssistantMessage["message"]["content"];

	return {
		id: messageId,
		type: "message",
		role: "assistant",
		content: contentBlocks,
		model: DEFAULT_CODEX_MODEL,
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation: null,
			inference_geo: null,
			iterations: null,
			server_tool_use: null,
			service_tier: null,
			speed: null,
		},
		container: null,
		context_management: null,
	};
}

function createUserToolResultMessage(
	toolUseId: string,
	result: string,
	isError: boolean,
): SDKUserMessage["message"] {
	const contentBlocks = [
		{
			type: "tool_result",
			tool_use_id: toolUseId,
			content: result,
			is_error: isError,
		},
	] as unknown as SDKUserMessage["message"]["content"];

	return {
		role: "user",
		content: contentBlocks,
	};
}

function createAssistantBetaMessage(
	content: string,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	const contentBlocks = [
		{ type: "text", text: content },
	] as unknown as SDKAssistantMessage["message"]["content"];

	return {
		id: messageId,
		type: "message",
		role: "assistant",
		content: contentBlocks,
		model: DEFAULT_CODEX_MODEL,
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation: null,
			inference_geo: null,
			iterations: null,
			server_tool_use: null,
			service_tier: null,
			speed: null,
		},
		container: null,
		context_management: null,
	};
}

function parseUsage(usage: Usage | null | undefined): ParsedUsage {
	if (!usage) {
		return {
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
		};
	}

	return {
		inputTokens: toFiniteNumber(usage.input_tokens),
		outputTokens: toFiniteNumber(usage.output_tokens),
		cachedInputTokens: toFiniteNumber(usage.cached_input_tokens),
	};
}

function createResultUsage(parsed: ParsedUsage): SDKResultMessage["usage"] {
	return {
		input_tokens: parsed.inputTokens,
		output_tokens: parsed.outputTokens,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: parsed.cachedInputTokens,
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
	};
}

function getDefaultReasoningEffortForModel(
	model?: string,
): CodexRunnerConfig["modelReasoningEffort"] | undefined {
	// gpt-5 codex variants reject xhigh in some environments; pin a compatible default.
	return /gpt-5[a-z0-9.-]*codex$/i.test(model || "") ? "high" : undefined;
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "Codex execution failed";
}

function inferCommandToolName(command: string): string {
	const normalized = command.toLowerCase();
	if (/\brg\b|\bgrep\b/.test(normalized)) {
		return "Grep";
	}
	if (/\bglob\.glob\b|\bfind\b.+\s-name\s/.test(normalized)) {
		return "Glob";
	}
	if (/\bcat\b/.test(normalized) && !/>/.test(normalized)) {
		return "Read";
	}
	if (
		/<<\s*['"]?eof['"]?\s*>/i.test(command) ||
		/\becho\b.+>/.test(normalized)
	) {
		return "Write";
	}
	return "Bash";
}

function normalizeFilePath(path: string, workingDirectory?: string): string {
	if (!path) {
		return path;
	}

	if (workingDirectory && path.startsWith(workingDirectory)) {
		const relativePath = pathRelative(workingDirectory, path);
		if (relativePath && relativePath !== ".") {
			return relativePath;
		}
	}

	return path;
}

function summarizeFileChanges(
	item: FileChangeItem,
	workingDirectory?: string,
): string {
	if (!item.changes.length) {
		return item.status === "failed" ? "Patch failed" : "No file changes";
	}

	return item.changes
		.map((change) => {
			const filePath = normalizeFilePath(change.path, workingDirectory);
			return `${change.kind} ${filePath}`;
		})
		.join("\n");
}

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object") {
		return value as Record<string, unknown>;
	}
	return null;
}

function toMcpResultString(item: McpToolCallItem): string {
	if (item.error?.message) {
		return item.error.message;
	}

	const textBlocks: string[] = [];
	for (const block of item.result?.content || []) {
		const text = asRecord(block)?.text;
		if (typeof text === "string" && text.trim().length > 0) {
			textBlocks.push(text);
		}
	}

	if (textBlocks.length > 0) {
		return textBlocks.join("\n");
	}

	if (item.result?.structured_content !== undefined) {
		return safeStringify(item.result.structured_content);
	}

	return item.status === "failed"
		? "MCP tool call failed"
		: "MCP tool call completed";
}

function normalizeMcpIdentifier(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return normalized || "unknown";
}

function autoDetectMcpConfigPath(
	workingDirectory?: string,
): string | undefined {
	if (!workingDirectory) {
		return undefined;
	}

	const mcpPath = join(workingDirectory, ".mcp.json");
	if (!existsSync(mcpPath)) {
		return undefined;
	}

	try {
		JSON.parse(readFileSync(mcpPath, "utf8"));
		return mcpPath;
	} catch {
		console.warn(
			`[CodexRunner] Found .mcp.json at ${mcpPath} but it is invalid JSON, skipping`,
		);
		return undefined;
	}
}

function loadMcpConfigFromPaths(
	configPaths: string | string[] | undefined,
): Record<string, McpServerConfig> {
	if (!configPaths) {
		return {};
	}

	const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
	let mcpServers: Record<string, McpServerConfig> = {};

	for (const configPath of paths) {
		try {
			const mcpConfigContent = readFileSync(configPath, "utf8");
			const mcpConfig = JSON.parse(mcpConfigContent);
			const servers =
				mcpConfig &&
				typeof mcpConfig === "object" &&
				!Array.isArray(mcpConfig) &&
				mcpConfig.mcpServers &&
				typeof mcpConfig.mcpServers === "object" &&
				!Array.isArray(mcpConfig.mcpServers)
					? (mcpConfig.mcpServers as Record<string, McpServerConfig>)
					: {};
			mcpServers = { ...mcpServers, ...servers };
			console.log(
				`[CodexRunner] Loaded MCP config from ${configPath}: ${Object.keys(servers).join(", ")}`,
			);
		} catch (error) {
			console.warn(
				`[CodexRunner] Failed to load MCP config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return mcpServers;
}

export declare interface CodexRunner {
	on<K extends keyof CodexRunnerEvents>(
		event: K,
		listener: CodexRunnerEvents[K],
	): this;
	emit<K extends keyof CodexRunnerEvents>(
		event: K,
		...args: Parameters<CodexRunnerEvents[K]>
	): boolean;
}

/**
 * Runner that adapts Codex SDK streaming output to Cyrus SDK message types.
 */
export class CodexRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = false;

	private config: CodexRunnerConfig;
	private sessionInfo: CodexSessionInfo | null = null;
	private messages: SDKMessage[] = [];
	private formatter: IMessageFormatter;
	private hasInitMessage = false;
	private pendingResultMessage: SDKResultMessage | null = null;
	private lastAssistantText: string | null = null;
	private lastUsage: ParsedUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
	};
	private errorMessages: string[] = [];
	private startTimestampMs = 0;
	private wasStopped = false;
	private abortController: AbortController | null = null;
	private emittedToolUseIds: Set<string> = new Set();

	constructor(config: CodexRunnerConfig) {
		super();
		this.config = config;
		this.formatter = new CodexMessageFormatter();

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<CodexSessionInfo> {
		return this.startWithPrompt(prompt);
	}

	async startStreaming(initialPrompt?: string): Promise<CodexSessionInfo> {
		return this.startWithPrompt(null, initialPrompt);
	}

	addStreamMessage(_content: string): void {
		throw new Error("CodexRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op: CodexRunner does not support streaming input.
	}

	private async startWithPrompt(
		stringPrompt?: string | null,
		streamingInitialPrompt?: string,
	): Promise<CodexSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Codex session already running");
		}

		const sessionId = this.config.resumeSessionId || crypto.randomUUID();
		this.sessionInfo = {
			sessionId,
			startedAt: new Date(),
			isRunning: true,
		};

		this.messages = [];
		this.hasInitMessage = false;
		this.pendingResultMessage = null;
		this.lastAssistantText = null;
		this.lastUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
		};
		this.errorMessages = [];
		this.wasStopped = false;
		this.startTimestampMs = Date.now();
		this.emittedToolUseIds.clear();

		const prompt = (stringPrompt ?? streamingInitialPrompt ?? "").trim();
		const threadOptions = this.buildThreadOptions();
		const codex = this.createCodexClient();
		const thread = this.config.resumeSessionId
			? codex.resumeThread(this.config.resumeSessionId, threadOptions)
			: codex.startThread(threadOptions);
		const abortController = new AbortController();
		this.abortController = abortController;

		let caughtError: unknown;
		try {
			await this.runTurn(thread, prompt, abortController.signal);
		} catch (error) {
			caughtError = error;
		} finally {
			this.finalizeSession(caughtError);
		}

		return this.sessionInfo;
	}

	private createCodexClient(): Codex {
		const codexHome = this.resolveCodexHome();
		const envOverride = this.buildEnvOverride(codexHome);
		const configOverrides = this.buildConfigOverrides();

		return new Codex({
			...(this.config.codexPath
				? { codexPathOverride: this.config.codexPath }
				: {}),
			...(envOverride ? { env: envOverride } : {}),
			...(configOverrides ? { config: configOverrides } : {}),
		});
	}

	private buildThreadOptions(): ThreadOptions {
		const additionalDirectories = this.getAdditionalDirectories();
		const reasoningEffort =
			this.config.modelReasoningEffort ??
			getDefaultReasoningEffortForModel(this.config.model);
		const webSearchMode =
			this.config.webSearchMode ??
			(this.config.includeWebSearch ? "live" : undefined);

		const threadOptions: ThreadOptions = {
			model: this.config.model,
			sandboxMode: this.config.sandbox || "workspace-write",
			workingDirectory: this.config.workingDirectory,
			skipGitRepoCheck: this.config.skipGitRepoCheck ?? true,
			approvalPolicy: this.config.askForApproval || "never",
			...(reasoningEffort ? { modelReasoningEffort: reasoningEffort } : {}),
			...(webSearchMode ? { webSearchMode } : {}),
			...(additionalDirectories.length > 0 ? { additionalDirectories } : {}),
		};

		return threadOptions;
	}

	private getAdditionalDirectories(): string[] {
		const workingDirectory = this.config.workingDirectory;
		const uniqueDirectories = new Set<string>();

		for (const directory of this.config.allowedDirectories || []) {
			if (!directory || directory === workingDirectory) {
				continue;
			}
			uniqueDirectories.add(directory);
		}

		return [...uniqueDirectories];
	}

	private resolveCodexHome(): string {
		const codexHome =
			this.config.codexHome ||
			process.env.CODEX_HOME ||
			join(homedir(), ".codex");
		mkdirSync(codexHome, { recursive: true });
		return codexHome;
	}

	private buildEnvOverride(
		codexHome: string,
	): Record<string, string> | undefined {
		if (!this.config.codexHome) {
			return undefined;
		}

		const env: Record<string, string> = {};
		for (const [key, value] of Object.entries(process.env)) {
			if (typeof value === "string") {
				env[key] = value;
			}
		}
		env.CODEX_HOME = codexHome;
		return env;
	}

	private buildCodexMcpServersConfig():
		| Record<string, CodexConfigOverrides>
		| undefined {
		const autoDetectedPath = autoDetectMcpConfigPath(
			this.config.workingDirectory,
		);
		const configPaths = autoDetectedPath
			? [autoDetectedPath]
			: ([] as string[]);
		if (this.config.mcpConfigPath) {
			const explicitPaths = Array.isArray(this.config.mcpConfigPath)
				? this.config.mcpConfigPath
				: [this.config.mcpConfigPath];
			configPaths.push(...explicitPaths);
		}

		const fileBasedServers = loadMcpConfigFromPaths(configPaths);
		const mergedServers = this.config.mcpConfig
			? { ...fileBasedServers, ...this.config.mcpConfig }
			: fileBasedServers;
		if (Object.keys(mergedServers).length === 0) {
			return undefined;
		}

		// Codex MCP configuration reference:
		// https://platform.openai.com/docs/docs-mcp
		const codexServers: Record<string, CodexConfigOverrides> = {};
		for (const [serverName, rawConfig] of Object.entries(mergedServers)) {
			const configAny = rawConfig as Record<string, unknown>;
			if (
				typeof configAny.listTools === "function" ||
				typeof configAny.callTool === "function"
			) {
				console.warn(
					`[CodexRunner] Skipping MCP server '${serverName}' because in-process SDK server instances cannot be mapped to codex config`,
				);
				continue;
			}

			const mapped: CodexConfigOverrides = {};
			if (typeof configAny.command === "string") {
				mapped.command = configAny.command;
			}
			if (Array.isArray(configAny.args)) {
				mapped.args =
					configAny.args as unknown as CodexConfigOverrides[keyof CodexConfigOverrides];
			}
			if (
				configAny.env &&
				typeof configAny.env === "object" &&
				!Array.isArray(configAny.env)
			) {
				mapped.env =
					configAny.env as unknown as CodexConfigOverrides[keyof CodexConfigOverrides];
			}
			if (typeof configAny.cwd === "string") {
				mapped.cwd = configAny.cwd;
			}
			if (typeof configAny.url === "string") {
				mapped.url = configAny.url;
			}
			if (
				configAny.http_headers &&
				typeof configAny.http_headers === "object" &&
				!Array.isArray(configAny.http_headers)
			) {
				mapped.http_headers =
					configAny.http_headers as unknown as CodexConfigOverrides[keyof CodexConfigOverrides];
			}
			if (
				configAny.headers &&
				typeof configAny.headers === "object" &&
				!Array.isArray(configAny.headers)
			) {
				mapped.http_headers =
					configAny.headers as unknown as CodexConfigOverrides[keyof CodexConfigOverrides];
			}
			if (
				configAny.env_http_headers &&
				typeof configAny.env_http_headers === "object" &&
				!Array.isArray(configAny.env_http_headers)
			) {
				mapped.env_http_headers =
					configAny.env_http_headers as unknown as CodexConfigOverrides[keyof CodexConfigOverrides];
			}
			if (typeof configAny.bearer_token_env_var === "string") {
				mapped.bearer_token_env_var = configAny.bearer_token_env_var;
			}
			if (typeof configAny.timeout === "number") {
				mapped.timeout = configAny.timeout;
			}

			if (!mapped.command && !mapped.url) {
				console.warn(
					`[CodexRunner] Skipping MCP server '${serverName}' because it has no command/url transport`,
				);
				continue;
			}

			codexServers[serverName] = mapped;
		}

		if (Object.keys(codexServers).length === 0) {
			return undefined;
		}

		console.log(
			`[CodexRunner] Configured ${Object.keys(codexServers).length} MCP server(s) for codex config (docs: ${CODEX_MCP_DOCS_URL})`,
		);
		return codexServers;
	}

	private buildConfigOverrides(): CodexConfigOverrides | undefined {
		const appendSystemPrompt = (this.config.appendSystemPrompt ?? "").trim();
		const configOverrides = this.config.configOverrides
			? { ...this.config.configOverrides }
			: {};
		const mcpServers = this.buildCodexMcpServersConfig();
		if (mcpServers) {
			const existingMcpServers = configOverrides.mcp_servers;
			if (
				existingMcpServers &&
				typeof existingMcpServers === "object" &&
				!Array.isArray(existingMcpServers)
			) {
				configOverrides.mcp_servers = {
					...(existingMcpServers as Record<string, CodexConfigValue>),
					...mcpServers,
				};
			} else {
				configOverrides.mcp_servers = mcpServers;
			}
		}

		const sandboxWorkspaceWrite = configOverrides.sandbox_workspace_write;
		// Keep workspace-write as the default sandbox, but enable outbound network so
		// common remote workflows (for example `git`/`gh` against GitHub) work without
		// requiring danger-full-access.
		if (
			sandboxWorkspaceWrite &&
			typeof sandboxWorkspaceWrite === "object" &&
			!Array.isArray(sandboxWorkspaceWrite)
		) {
			configOverrides.sandbox_workspace_write = {
				...sandboxWorkspaceWrite,
				network_access:
					(sandboxWorkspaceWrite as { network_access?: boolean })
						.network_access ?? true,
			};
		} else if (!sandboxWorkspaceWrite) {
			configOverrides.sandbox_workspace_write = { network_access: true };
		}

		if (!appendSystemPrompt) {
			return Object.keys(configOverrides).length > 0
				? configOverrides
				: undefined;
		}

		return {
			...configOverrides,
			developer_instructions: appendSystemPrompt,
		};
	}

	private async runTurn(
		thread: Thread,
		prompt: string,
		signal: AbortSignal,
	): Promise<void> {
		const streamedTurn = await thread.runStreamed(prompt, { signal });
		for await (const event of streamedTurn.events) {
			this.handleEvent(event);
		}
	}

	private handleEvent(event: CodexJsonEvent): void {
		this.emit("streamEvent", event);

		switch (event.type) {
			case "thread.started": {
				if (this.sessionInfo) {
					this.sessionInfo.sessionId = event.thread_id;
				}
				this.emitSystemInitMessage(event.thread_id);
				break;
			}
			case "item.completed": {
				if (event.item.type === "agent_message") {
					this.emitAssistantMessage(event.item.text);
				} else {
					this.emitToolMessagesForItem(event.item, true);
				}
				break;
			}
			case "item.started": {
				this.emitToolMessagesForItem(event.item, false);
				break;
			}
			case "turn.completed": {
				this.lastUsage = parseUsage(event.usage);
				this.pendingResultMessage = this.createSuccessResultMessage(
					this.lastAssistantText || "Codex session completed successfully",
				);
				break;
			}
			case "turn.failed": {
				// Prefer event.error.message; fallback to last standalone "error" event
				const message =
					event.error?.message ||
					this.errorMessages.at(-1) ||
					"Codex execution failed";
				this.errorMessages.push(message);
				this.pendingResultMessage = this.createErrorResultMessage(message);
				break;
			}
			case "error": {
				this.errorMessages.push(event.message);
				break;
			}
			default:
				break;
		}
	}

	private projectItemToTool(item: ThreadItem): ToolProjection | null {
		switch (item.type) {
			case "command_execution": {
				const commandItem = item as CommandExecutionItem;
				const isError =
					commandItem.status === "failed" ||
					(typeof commandItem.exit_code === "number" &&
						commandItem.exit_code !== 0);
				const result =
					commandItem.aggregated_output?.trim() ||
					(isError
						? `Command failed (exit code ${commandItem.exit_code ?? "unknown"})`
						: "Command completed with no output");

				return {
					toolUseId: commandItem.id,
					toolName: inferCommandToolName(commandItem.command),
					toolInput: { command: commandItem.command },
					result,
					isError,
				};
			}
			case "file_change": {
				const fileChangeItem = item as FileChangeItem;
				const primaryPath =
					fileChangeItem.changes[0]?.path &&
					normalizeFilePath(
						fileChangeItem.changes[0].path,
						this.config.workingDirectory,
					);
				return {
					toolUseId: fileChangeItem.id,
					toolName: "Edit",
					toolInput: {
						...(primaryPath ? { file_path: primaryPath } : {}),
						changes: fileChangeItem.changes.map((change) => ({
							kind: change.kind,
							path: normalizeFilePath(
								change.path,
								this.config.workingDirectory,
							),
						})),
					},
					result: summarizeFileChanges(
						fileChangeItem,
						this.config.workingDirectory,
					),
					isError: fileChangeItem.status === "failed",
				};
			}
			case "web_search": {
				const webSearchItem = item as WebSearchItem;
				const extendedItem = item as unknown as Record<string, unknown>;
				const action = asRecord(extendedItem.action);
				const actionType =
					typeof action?.type === "string" ? action.type : undefined;
				const isFetch = actionType === "open_page";
				const url =
					typeof action?.url === "string"
						? action.url
						: typeof extendedItem.url === "string"
							? extendedItem.url
							: undefined;
				const pattern =
					typeof action?.pattern === "string"
						? action.pattern
						: typeof extendedItem.pattern === "string"
							? extendedItem.pattern
							: undefined;

				return {
					toolUseId: webSearchItem.id,
					toolName: isFetch ? "WebFetch" : "WebSearch",
					toolInput: isFetch
						? {
								url: url || webSearchItem.query,
								...(pattern ? { pattern } : {}),
							}
						: { query: webSearchItem.query },
					result:
						action && Object.keys(action).length > 0
							? safeStringify(action)
							: `Search completed for query: ${webSearchItem.query}`,
					isError: false,
				};
			}
			case "mcp_tool_call": {
				const mcpItem = item as McpToolCallItem;
				return {
					toolUseId: mcpItem.id,
					toolName: `mcp__${normalizeMcpIdentifier(mcpItem.server)}__${normalizeMcpIdentifier(mcpItem.tool)}`,
					toolInput: asRecord(mcpItem.arguments) || {
						arguments: mcpItem.arguments,
					},
					result: toMcpResultString(mcpItem),
					isError: mcpItem.status === "failed" || Boolean(mcpItem.error),
				};
			}
			case "todo_list": {
				const todoItem = item as TodoListItem;
				return {
					toolUseId: todoItem.id,
					toolName: "TodoWrite",
					toolInput: {
						todos: todoItem.items.map((todo) => ({
							content: todo.text,
							status: todo.completed ? "completed" : "pending",
						})),
					},
					result: `Updated todo list (${todoItem.items.length} items)`,
					isError: false,
				};
			}
			default:
				return null;
		}
	}

	private emitToolMessagesForItem(
		item: ThreadItem,
		includeResult: boolean,
	): void {
		const projection = this.projectItemToTool(item);
		if (!projection) {
			return;
		}

		if (!this.emittedToolUseIds.has(projection.toolUseId)) {
			const assistantMessage: SDKAssistantMessage = {
				type: "assistant",
				message: createAssistantToolUseMessage(
					projection.toolUseId,
					projection.toolName,
					projection.toolInput,
				),
				parent_tool_use_id: null,
				uuid: crypto.randomUUID(),
				session_id: this.sessionInfo?.sessionId || "pending",
			};
			this.messages.push(assistantMessage);
			this.emit("message", assistantMessage);
			this.emittedToolUseIds.add(projection.toolUseId);
		}

		if (!includeResult) {
			return;
		}

		const userMessage: SDKUserMessage = {
			type: "user",
			message: createUserToolResultMessage(
				projection.toolUseId,
				projection.result,
				projection.isError,
			),
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};

		this.messages.push(userMessage);
		this.emit("message", userMessage);
		this.emittedToolUseIds.delete(projection.toolUseId);
	}

	private finalizeSession(caughtError?: unknown): void {
		if (!this.sessionInfo) {
			this.cleanupRuntimeState();
			return;
		}

		this.sessionInfo.isRunning = false;

		// Ensure init is emitted even if stream fails before thread.started.
		if (!this.hasInitMessage) {
			this.emitSystemInitMessage(
				this.sessionInfo.sessionId || this.config.resumeSessionId || "pending",
			);
		}

		if (caughtError && !this.wasStopped) {
			const errorMessage = normalizeError(caughtError);
			this.errorMessages.push(errorMessage);
		}

		if (!this.pendingResultMessage && !this.wasStopped) {
			if (caughtError) {
				this.pendingResultMessage = this.createErrorResultMessage(
					this.errorMessages.at(-1) || "Codex execution failed",
				);
			} else {
				this.pendingResultMessage = this.createSuccessResultMessage(
					this.lastAssistantText || "Codex session completed successfully",
				);
			}
		}

		if (this.pendingResultMessage) {
			this.messages.push(this.pendingResultMessage);
			this.emit("message", this.pendingResultMessage);
			this.pendingResultMessage = null;
		}

		this.emit("complete", [...this.messages]);

		this.cleanupRuntimeState();
	}

	private emitAssistantMessage(text: string): void {
		const normalized = text.trim();
		if (!normalized) {
			return;
		}

		this.lastAssistantText = normalized;
		const assistantMessage: SDKAssistantMessage = {
			type: "assistant",
			message: createAssistantBetaMessage(normalized),
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
		this.messages.push(assistantMessage);
		this.emit("message", assistantMessage);
	}

	private emitSystemInitMessage(sessionId: string): void {
		if (this.hasInitMessage) {
			return;
		}
		this.hasInitMessage = true;

		const initMessage: SDKSystemInitMessage = {
			type: "system",
			subtype: "init",
			agents: undefined,
			apiKeySource: "user",
			claude_code_version: "codex-cli",
			cwd: this.config.workingDirectory || cwd(),
			tools: [],
			mcp_servers: [],
			model: this.config.model || DEFAULT_CODEX_MODEL,
			permissionMode: "default",
			slash_commands: [],
			output_style: "default",
			skills: [],
			plugins: [],
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		};

		this.messages.push(initMessage);
		this.emit("message", initMessage);
	}

	private createSuccessResultMessage(result: string): SDKResultMessage {
		const durationMs = Math.max(Date.now() - this.startTimestampMs, 0);
		return {
			type: "result",
			subtype: "success",
			duration_ms: durationMs,
			duration_api_ms: 0,
			is_error: false,
			num_turns: 1,
			result,
			stop_reason: null,
			total_cost_usd: 0,
			usage: createResultUsage(this.lastUsage),
			modelUsage: {},
			permission_denials: [],
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
	}

	private createErrorResultMessage(errorMessage: string): SDKResultMessage {
		const durationMs = Math.max(Date.now() - this.startTimestampMs, 0);
		return {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: durationMs,
			duration_api_ms: 0,
			is_error: true,
			num_turns: 1,
			stop_reason: null,
			errors: [errorMessage],
			total_cost_usd: 0,
			usage: createResultUsage(this.lastUsage),
			modelUsage: {},
			permission_denials: [],
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
	}

	private cleanupRuntimeState(): void {
		this.abortController = null;
	}

	stop(): void {
		if (!this.sessionInfo?.isRunning) {
			return;
		}
		this.wasStopped = true;
		this.abortController?.abort();
	}

	isRunning(): boolean {
		return this.sessionInfo?.isRunning ?? false;
	}

	getMessages(): SDKMessage[] {
		return [...this.messages];
	}

	getFormatter(): IMessageFormatter {
		return this.formatter;
	}
}
