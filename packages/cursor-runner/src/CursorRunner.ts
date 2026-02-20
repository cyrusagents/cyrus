import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import {
	createWriteStream,
	type Dirent,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	type WriteStream,
	writeFileSync,
} from "node:fs";
import {
	join,
	parse as pathParse,
	relative as pathRelative,
	resolve,
} from "node:path";
import { cwd } from "node:process";
import { createInterface } from "node:readline";
import type {
	IAgentRunner,
	IMessageFormatter,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import { CursorMessageFormatter } from "./formatter.js";
import type {
	CursorJsonEvent,
	CursorRunnerConfig,
	CursorRunnerEvents,
	CursorSessionInfo,
} from "./types.js";

/** cursor-agent version we have tested against; set cursorAgentVersion in config to override */
const TESTED_CURSOR_AGENT_VERSION = "2026.02.13-41ac335";
const CURSOR_MCP_CONFIG_DOCS_URL =
	"https://cursor.com/docs/context/mcp#configuration-locations";
const CURSOR_CLI_PERMISSIONS_DOCS_URL =
	"https://cursor.com/docs/cli/reference/permissions";

type ToolInput = Record<string, unknown>;

interface ParsedUsage {
	inputTokens: number;
	outputTokens: number;
	cachedInputTokens: number;
}

interface ToolProjection {
	toolUseId: string;
	toolName: string;
	toolInput: ToolInput;
	result: string;
	isError: boolean;
}

interface CursorPermissionsConfig {
	permissions: {
		allow: string[];
		deny: string[];
	};
	[key: string]: unknown;
}

interface CursorPermissionsRestoreState {
	configPath: string;
	backupPath: string | null;
}

type CursorMcpServerConfig = Record<string, unknown>;

interface CursorMcpConfig {
	mcpServers: Record<string, CursorMcpServerConfig>;
	[key: string]: unknown;
}

interface CursorMcpRestoreState {
	configPath: string;
	backupPath: string | null;
}

type SDKSystemInitMessage = Extract<
	SDKMessage,
	{ type: "system"; subtype: "init" }
>;

function toFiniteNumber(value: unknown): number {
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
		model: "cursor-agent",
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation: null,
		} as SDKAssistantMessage["message"]["usage"],
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
		model: "cursor-agent",
		stop_reason: null,
		stop_sequence: null,
		usage: {
			input_tokens: 0,
			output_tokens: 0,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
			cache_creation: null,
		} as SDKAssistantMessage["message"]["usage"],
		container: null,
		context_management: null,
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
	} as SDKResultMessage["usage"];
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	if (typeof error === "string") {
		return error;
	}
	return "Cursor execution failed";
}

function normalizeCursorModel(model?: string): string | undefined {
	if (!model) {
		return model;
	}

	// Preserve backward compatibility for selector aliases that Cursor CLI no longer accepts.
	if (model.toLowerCase() === "gpt-5") {
		return "auto";
	}

	return model;
}

function extractTextFromMessageContent(content: unknown): string {
	if (!Array.isArray(content)) {
		return "";
	}

	const text = content
		.map((block) => {
			if (!block || typeof block !== "object") {
				return "";
			}
			const blockObj = block as Record<string, unknown>;
			return getStringValue(blockObj, "text") || "";
		})
		.join("")
		.trim();

	return text;
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
	item: Record<string, unknown>,
	workingDirectory?: string,
): string {
	const changes = Array.isArray(item.changes) ? item.changes : [];
	if (!changes.length) {
		return item.status === "failed" ? "Patch failed" : "No file changes";
	}

	return changes
		.map((change) => {
			if (!change || typeof change !== "object") {
				return null;
			}
			const mapped = change as Record<string, unknown>;
			const path = typeof mapped.path === "string" ? mapped.path : "";
			const kind = typeof mapped.kind === "string" ? mapped.kind : "update";
			const filePath = normalizeFilePath(path, workingDirectory);
			return `${kind} ${filePath}`;
		})
		.filter((line): line is string => Boolean(line))
		.join("\n");
}

function isTodoCompleted(status: string): boolean {
	const s = status.toLowerCase();
	return s === "completed" || s === "todo_status_completed";
}

function isTodoInProgress(status: string): boolean {
	const s = status.toLowerCase();
	return s === "in_progress" || s === "todo_status_in_progress";
}

function summarizeTodoList(item: Record<string, unknown>): string {
	const todos = Array.isArray(item.items) ? item.items : [];
	if (!todos.length) {
		return "No todos";
	}

	return todos
		.map((todo) => {
			if (!todo || typeof todo !== "object") {
				return "- [ ] task";
			}
			const mapped = todo as Record<string, unknown>;
			const text =
				typeof mapped.content === "string"
					? mapped.content
					: typeof mapped.description === "string"
						? mapped.description
						: "task";
			const status =
				typeof mapped.status === "string"
					? mapped.status.toLowerCase()
					: "pending";
			const marker = isTodoCompleted(status) ? "[x]" : "[ ]";
			const suffix = isTodoInProgress(status) ? " (in progress)" : "";
			return `- ${marker} ${text}${suffix}`;
		})
		.join("\n");
}

function getStringValue(
	object: Record<string, unknown>,
	...keys: string[]
): string | undefined {
	for (const key of keys) {
		const value = object[key];
		if (typeof value === "string" && value.trim().length > 0) {
			return value;
		}
	}
	return undefined;
}

function parseToolPattern(
	toolPattern: string,
): { name: string; argument: string | null } | null {
	const trimmed = toolPattern.trim();
	if (!trimmed) {
		return null;
	}
	const match = trimmed.match(/^([A-Za-z]+)(?:\((.*)\))?$/);
	if (!match) {
		return null;
	}
	return {
		name: match[1] || "",
		argument: match[2]?.trim() ?? null,
	};
}

function normalizeShellCommandBase(argument: string | null): string {
	if (!argument || argument === "*" || argument === "**") {
		return "*";
	}
	const firstRule = argument.split(",")[0]?.trim();
	if (!firstRule) {
		return "*";
	}
	const beforeColon = firstRule.split(":")[0]?.trim();
	return beforeColon || "*";
}

function normalizePathPattern(argument: string | null): string {
	if (!argument) {
		// Keep file access scoped to workspace paths by default.
		return "./**";
	}
	const trimmed = argument.trim();
	if (!trimmed) {
		return "./**";
	}
	// Cursor treats broad globs as permissive; anchor wildcard defaults to workspace.
	if (trimmed === "**") {
		return "./**";
	}
	return trimmed;
}

function toCursorPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function isWildcardPathArgument(argument: string | null): boolean {
	if (!argument) {
		return true;
	}
	const trimmed = argument.trim();
	return trimmed.length === 0 || trimmed === "**";
}

function isBroadReadToolPattern(toolPattern: string): boolean {
	const parsed = parseToolPattern(toolPattern);
	if (!parsed) {
		return false;
	}
	const toolName = parsed.name.toLowerCase();
	if (!(toolName === "read" || toolName === "glob" || toolName === "grep")) {
		return false;
	}
	return isWildcardPathArgument(parsed.argument);
}

function isBroadWriteToolPattern(toolPattern: string): boolean {
	const parsed = parseToolPattern(toolPattern);
	if (!parsed) {
		return false;
	}
	const toolName = parsed.name.toLowerCase();
	if (
		!(
			toolName === "edit" ||
			toolName === "write" ||
			toolName === "multiedit" ||
			toolName === "notebookedit" ||
			toolName === "todowrite"
		)
	) {
		return false;
	}
	return isWildcardPathArgument(parsed.argument);
}

function buildWorkspaceSiblingDenyPermissions(
	workspacePath: string,
	permission: "Read" | "Write",
): string[] {
	const resolvedWorkspacePath = resolve(workspacePath);
	const parsed = pathParse(resolvedWorkspacePath);
	if (!parsed.root) {
		return [];
	}

	const segments = resolvedWorkspacePath
		.slice(parsed.root.length)
		.split(/[\\/]+/)
		.filter(Boolean);
	if (segments.length === 0) {
		return [];
	}

	const denyPermissions = new Set<string>();
	let parentPath = parsed.root;

	for (const segment of segments) {
		let siblingEntries: Dirent[];
		try {
			siblingEntries = readdirSync(parentPath, { withFileTypes: true });
		} catch {
			break;
		}

		for (const sibling of siblingEntries) {
			if (!sibling.isDirectory() || sibling.name === segment) {
				continue;
			}
			const siblingPath = join(parentPath, sibling.name);
			denyPermissions.add(`${permission}(${toCursorPath(siblingPath)}/**)`);
		}

		parentPath = join(parentPath, segment);
	}

	return [...denyPermissions];
}

function buildSystemRootDenyPermissions(
	workspacePath: string,
	permission: "Read" | "Write",
): string[] {
	const workspace = toCursorPath(resolve(workspacePath));
	const rootCandidates = [
		"/etc",
		"/bin",
		"/sbin",
		"/usr",
		"/opt",
		"/System",
		"/Library",
		"/Applications",
		"/dev",
		"/proc",
		"/sys",
		"/Volumes",
		"/home",
	];

	const denies: string[] = [];
	for (const rootPath of rootCandidates) {
		if (workspace === rootPath || workspace.startsWith(`${rootPath}/`)) {
			continue;
		}
		denies.push(`${permission}(${rootPath}/**)`);
	}
	return denies;
}

function normalizeMcpPermissionPart(value: string | null): string {
	if (!value) {
		return "*";
	}
	const trimmed = value.trim();
	return trimmed || "*";
}

function mapClaudeMcpToolPatternToCursorPermission(
	toolPattern: string,
): string | null {
	const trimmed = toolPattern.trim();
	if (!trimmed.toLowerCase().startsWith("mcp__")) {
		return null;
	}

	const parts = trimmed.split("__");
	if (parts.length < 2) {
		return null;
	}

	const server = normalizeMcpPermissionPart(parts[1] || null);
	const tool =
		parts.length >= 3
			? normalizeMcpPermissionPart(parts.slice(2).join("__"))
			: "*";

	return `Mcp(${server}:${tool})`;
}

function mapClaudeToolPatternToCursorPermission(
	toolPattern: string,
): string | null {
	const mappedMcpPermission =
		mapClaudeMcpToolPatternToCursorPermission(toolPattern);
	if (mappedMcpPermission) {
		return mappedMcpPermission;
	}

	const parsed = parseToolPattern(toolPattern);
	if (!parsed) {
		return null;
	}

	const toolName = parsed.name.toLowerCase();
	if (toolName === "bash" || toolName === "shell") {
		return `Shell(${normalizeShellCommandBase(parsed.argument)})`;
	}
	if (toolName === "read" || toolName === "glob" || toolName === "grep") {
		return `Read(${normalizePathPattern(parsed.argument)})`;
	}
	if (
		toolName === "edit" ||
		toolName === "write" ||
		toolName === "multiedit" ||
		toolName === "notebookedit" ||
		toolName === "todowrite"
	) {
		return `Write(${normalizePathPattern(parsed.argument)})`;
	}

	return null;
}

function parseMcpServersFromCursorListOutput(output: string): string[] {
	const servers = new Set<string>();
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(/^\s*([A-Za-z0-9._-]+)\s*:/);
		const serverName = match?.[1]?.trim();
		if (serverName) {
			servers.add(serverName);
		}
	}
	return [...servers];
}

function getProjectionForItem(
	item: Record<string, unknown>,
	workingDirectory?: string,
): ToolProjection | null {
	const itemId = getStringValue(item, "id", "tool_id", "item_id");
	if (!itemId) {
		return null;
	}

	const itemType = getStringValue(item, "type");
	const status = getStringValue(item, "status") || "completed";
	const isError = status === "failed";

	if (itemType === "command_execution") {
		const command = getStringValue(item, "command") || "";
		const output = getStringValue(item, "aggregated_output", "output") || "";
		const exitCodeValue = item.exit_code;
		const exitCode = toFiniteNumber(exitCodeValue);
		const toolName = inferCommandToolName(command);
		const toolInput: ToolInput = {
			command,
			description: command,
		};
		const result =
			output ||
			(isError
				? `Command failed${exitCode ? ` (exit ${exitCode})` : ""}`
				: "Command completed");
		return {
			toolUseId: itemId,
			toolName,
			toolInput,
			result,
			isError,
		};
	}

	if (itemType === "file_change") {
		const summary = summarizeFileChanges(item, workingDirectory);
		return {
			toolUseId: itemId,
			toolName: "Edit",
			toolInput: { description: summary },
			result: summary,
			isError,
		};
	}

	if (itemType === "web_search") {
		const query = getStringValue(item, "query") || "web search";
		const actionValue = item.action;
		let toolInput: ToolInput = { query };
		let result = query;
		if (actionValue && typeof actionValue === "object") {
			const action = actionValue as Record<string, unknown>;
			const url = getStringValue(action, "url");
			if (url) {
				toolInput = { url };
				result = url;
			}
		}
		return {
			toolUseId: itemId,
			toolName: "WebSearch",
			toolInput,
			result,
			isError,
		};
	}

	if (itemType === "mcp_tool_call") {
		const server = getStringValue(item, "server") || "mcp";
		const tool = getStringValue(item, "tool") || "tool";
		const args =
			item.arguments && typeof item.arguments === "object"
				? item.arguments
				: {};
		const result =
			getStringValue(item, "result") ||
			safeStringify(item.result || "MCP tool completed");
		return {
			toolUseId: itemId,
			toolName: `mcp__${server}__${tool}`,
			toolInput: args as ToolInput,
			result,
			isError,
		};
	}

	if (itemType === "todo_list") {
		const summary = summarizeTodoList(item);
		return {
			toolUseId: itemId,
			toolName: "TodoWrite",
			toolInput: { todos: item.items },
			result: summary,
			isError,
		};
	}

	return null;
}

function extractToolResultFromPayload(payload: Record<string, unknown>): {
	text: string;
	isError: boolean;
} {
	const resultValue =
		payload.result && typeof payload.result === "object"
			? (payload.result as Record<string, unknown>)
			: null;
	if (!resultValue) {
		return { text: "Tool completed", isError: false };
	}

	if (resultValue.success && typeof resultValue.success === "object") {
		const success = resultValue.success as Record<string, unknown>;
		const output =
			getStringValue(
				success,
				"interleavedOutput",
				"stdout",
				"markdown",
				"text",
			) || safeStringify(success);
		return { text: output, isError: false };
	}

	const failure =
		resultValue.failure && typeof resultValue.failure === "object"
			? (resultValue.failure as Record<string, unknown>)
			: null;
	if (failure) {
		return {
			text:
				getStringValue(failure, "message", "stderr") || safeStringify(failure),
			isError: true,
		};
	}

	return { text: safeStringify(resultValue), isError: false };
}

function getProjectionForToolCallEvent(
	event: Record<string, unknown>,
	workingDirectory?: string,
): ToolProjection | null {
	const toolUseId = getStringValue(event, "call_id");
	if (!toolUseId) {
		return null;
	}

	const toolCallRaw =
		event.tool_call && typeof event.tool_call === "object"
			? (event.tool_call as Record<string, unknown>)
			: null;
	if (!toolCallRaw) {
		return null;
	}

	const variantKey = Object.keys(toolCallRaw)[0];
	if (!variantKey) {
		return null;
	}
	const payloadValue = toolCallRaw[variantKey];
	if (!payloadValue || typeof payloadValue !== "object") {
		return null;
	}
	const payload = payloadValue as Record<string, unknown>;
	const args =
		payload.args && typeof payload.args === "object"
			? (payload.args as Record<string, unknown>)
			: {};

	let toolName = "Tool";
	let toolInput: ToolInput = {};
	let resultText = "Tool completed";

	if (variantKey === "shellToolCall") {
		const command = getStringValue(args, "command") || "";
		toolName = inferCommandToolName(command);
		toolInput = { command, description: command };
	} else if (variantKey === "readToolCall") {
		toolName = "Read";
		toolInput = {
			path: normalizeFilePath(
				getStringValue(args, "path") || "",
				workingDirectory,
			),
			limit: args.limit,
		};
	} else if (variantKey === "grepToolCall") {
		toolName = "Grep";
		toolInput = {
			pattern: getStringValue(args, "pattern") || "",
			path: normalizeFilePath(
				getStringValue(args, "path") || "",
				workingDirectory,
			),
		};
	} else if (variantKey === "globToolCall") {
		toolName = "Glob";
		toolInput = {
			glob: getStringValue(args, "globPattern") || "",
			path: normalizeFilePath(
				getStringValue(args, "targetDirectory") || "",
				workingDirectory,
			),
		};
	} else if (variantKey === "editToolCall") {
		toolName = "Edit";
		toolInput = {
			path: normalizeFilePath(
				getStringValue(args, "path") || "",
				workingDirectory,
			),
		};
	} else if (variantKey === "deleteToolCall") {
		toolName = "Edit";
		toolInput = {
			description: `delete ${normalizeFilePath(getStringValue(args, "path") || "", workingDirectory)}`,
		};
	} else if (variantKey === "semSearchToolCall") {
		toolName = "ToolSearch";
		toolInput = { query: getStringValue(args, "query") || "" };
	} else if (variantKey === "readLintsToolCall") {
		toolName = "Read";
		toolInput = { paths: args.paths };
	} else if (variantKey === "mcpToolCall") {
		const provider = getStringValue(args, "providerIdentifier") || "mcp";
		const namedTool =
			getStringValue(args, "toolName") ||
			getStringValue(args, "name") ||
			"tool";
		toolName = `mcp__${provider}__${namedTool}`;
		toolInput =
			args.args && typeof args.args === "object"
				? (args.args as ToolInput)
				: {};
	} else if (variantKey === "listMcpResourcesToolCall") {
		toolName = "mcp__list_resources";
		toolInput = {};
	} else if (variantKey === "webFetchToolCall") {
		toolName = "WebFetch";
		toolInput = { url: getStringValue(args, "url") || "" };
	} else if (variantKey === "updateTodosToolCall") {
		toolName = "TodoWrite";
		toolInput = { todos: args.todos };
		resultText = summarizeTodoList({ items: args.todos });
	} else {
		toolName = variantKey.replace(/ToolCall$/, "");
		toolInput = args as ToolInput;
	}

	const extracted = extractToolResultFromPayload(payload);
	if (resultText === "Tool completed" || extracted.isError) {
		resultText = extracted.text;
	}

	return {
		toolUseId,
		toolName,
		toolInput,
		result: resultText,
		isError: extracted.isError,
	};
}

function extractUsageFromEvent(
	event: Record<string, unknown>,
): ParsedUsage | null {
	const usageRaw =
		event.usage && typeof event.usage === "object"
			? (event.usage as Record<string, unknown>)
			: null;
	if (!usageRaw) {
		return null;
	}
	return {
		inputTokens: toFiniteNumber(usageRaw.input_tokens),
		outputTokens: toFiniteNumber(usageRaw.output_tokens),
		cachedInputTokens: toFiniteNumber(usageRaw.cached_input_tokens),
	};
}

export declare interface CursorRunner {
	on<K extends keyof CursorRunnerEvents>(
		event: K,
		listener: CursorRunnerEvents[K],
	): this;
	emit<K extends keyof CursorRunnerEvents>(
		event: K,
		...args: Parameters<CursorRunnerEvents[K]>
	): boolean;
}

export class CursorRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = false;

	private config: CursorRunnerConfig;
	private sessionInfo: CursorSessionInfo | null = null;
	private messages: SDKMessage[] = [];
	private formatter: IMessageFormatter;
	private process: ChildProcess | null = null;
	private readlineInterface: ReturnType<typeof createInterface> | null = null;
	private pendingResultMessage: SDKResultMessage | null = null;
	private hasInitMessage = false;
	private lastAssistantText: string | null = null;
	private wasStopped = false;
	private startTimestampMs = 0;
	private lastUsage: ParsedUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cachedInputTokens: 0,
	};
	private errorMessages: string[] = [];
	private emittedToolUseIds = new Set<string>();
	private fallbackOutputLines: string[] = [];
	private logStream: WriteStream | null = null;
	private mcpConfigRestoreState: CursorMcpRestoreState | null = null;
	private permissionsConfigRestoreState: CursorPermissionsRestoreState | null =
		null;

	constructor(config: CursorRunnerConfig) {
		super();
		this.config = config;
		this.formatter = new CursorMessageFormatter();

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<CursorSessionInfo> {
		return this.startWithPrompt(prompt);
	}

	async startStreaming(initialPrompt?: string): Promise<CursorSessionInfo> {
		return this.startWithPrompt(null, initialPrompt);
	}

	addStreamMessage(_content: string): void {
		throw new Error("CursorRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op: CursorRunner does not support streaming input.
	}

	private async startWithPrompt(
		stringPrompt?: string | null,
		streamingInitialPrompt?: string,
	): Promise<CursorSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Cursor session already running");
		}

		const sessionId = this.config.resumeSessionId || crypto.randomUUID();
		this.sessionInfo = {
			sessionId,
			startedAt: new Date(),
			isRunning: true,
		};

		this.messages = [];
		this.pendingResultMessage = null;
		this.hasInitMessage = false;
		this.lastAssistantText = null;
		this.wasStopped = false;
		this.startTimestampMs = Date.now();
		this.lastUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cachedInputTokens: 0,
		};
		this.errorMessages = [];
		this.emittedToolUseIds.clear();
		this.fallbackOutputLines = [];
		this.setupLogging(sessionId);
		this.syncProjectMcpConfig();
		this.enableCursorMcpServers();
		this.syncProjectPermissionsConfig();

		// Test/CI fallback: allow deterministic mock runs when cursor-agent cannot execute.
		if (process.env.CYRUS_CURSOR_MOCK === "1") {
			this.emitInitMessage();
			this.handleEvent({
				type: "message",
				role: "assistant",
				content: "Cursor mock session completed",
			});
			this.pendingResultMessage = this.createSuccessResultMessage(
				"Cursor mock session completed",
			);
			this.finalizeSession();
			return this.sessionInfo;
		}

		const cursorPath = this.config.cursorPath || "cursor-agent";
		const expectedVersion =
			this.config.cursorAgentVersion ?? TESTED_CURSOR_AGENT_VERSION;
		const versionError = this.checkCursorAgentVersion(
			cursorPath,
			expectedVersion,
		);
		if (versionError) {
			this.finalizeSession(new Error(versionError));
			return this.sessionInfo;
		}

		const prompt = (stringPrompt ?? streamingInitialPrompt ?? "").trim();
		const args = this.buildArgs(prompt);
		const spawnLine = `[CursorRunner] Spawn: ${cursorPath} ${args.join(" ")}`;
		console.log(spawnLine);
		if (this.logStream) {
			this.logStream.write(`${spawnLine}\n`);
		}
		const child = spawn(cursorPath, args, {
			cwd: this.config.workingDirectory || cwd(),
			env: this.buildEnv(),
			stdio: ["ignore", "pipe", "pipe"],
		});

		this.process = child;

		this.readlineInterface = createInterface({
			input: child.stdout!,
			crlfDelay: Infinity,
		});

		this.readlineInterface.on("line", (line) => this.handleStdoutLine(line));

		child.stderr?.on("data", (data: Buffer) => {
			const text = data.toString().trim();
			if (!text) return;
			this.errorMessages.push(text);
		});

		let caughtError: unknown;
		try {
			await new Promise<void>((resolve, reject) => {
				child.on("close", (code) => {
					if (code === 0 || this.wasStopped) {
						resolve();
						return;
					}
					reject(new Error(`cursor-agent exited with code ${code}`));
				});
				child.on("error", reject);
			});
		} catch (error) {
			caughtError = error;
		} finally {
			this.finalizeSession(caughtError);
		}

		return this.sessionInfo;
	}

	private buildCursorPermissionsConfig(): CursorPermissionsConfig {
		// Cursor CLI permission tokens reference:
		// https://cursor.com/docs/cli/reference/permissions
		const allowedTools = this.config.allowedTools || [];
		const disallowedTools = this.config.disallowedTools || [];
		const workspacePath = this.config.workingDirectory;

		const allow = [
			...new Set(
				allowedTools
					.map(mapClaudeToolPatternToCursorPermission)
					.filter((value): value is string => Boolean(value)),
			),
		];
		const autoScopeDenyPermissions = new Set<string>();
		if (workspacePath) {
			if (allowedTools.some(isBroadReadToolPattern)) {
				for (const permission of buildWorkspaceSiblingDenyPermissions(
					workspacePath,
					"Read",
				)) {
					autoScopeDenyPermissions.add(permission);
				}
				for (const permission of buildSystemRootDenyPermissions(
					workspacePath,
					"Read",
				)) {
					autoScopeDenyPermissions.add(permission);
				}
			}
			if (allowedTools.some(isBroadWriteToolPattern)) {
				for (const permission of buildWorkspaceSiblingDenyPermissions(
					workspacePath,
					"Write",
				)) {
					autoScopeDenyPermissions.add(permission);
				}
				for (const permission of buildSystemRootDenyPermissions(
					workspacePath,
					"Write",
				)) {
					autoScopeDenyPermissions.add(permission);
				}
			}
		}

		const mappedDisallowedPermissions = disallowedTools
			.map(mapClaudeToolPatternToCursorPermission)
			.filter((value): value is string => Boolean(value));
		const deny = [
			...new Set(
				[...mappedDisallowedPermissions, ...autoScopeDenyPermissions].flat(),
			),
		];

		return {
			permissions: { allow, deny },
		};
	}

	private buildCursorMcpServersConfig(): Record<string, CursorMcpServerConfig> {
		const servers: Record<string, CursorMcpServerConfig> = {};
		for (const [serverName, rawConfig] of Object.entries(
			this.config.mcpConfig || {},
		)) {
			const configAny = rawConfig as Record<string, unknown>;
			if (
				typeof configAny.listTools === "function" ||
				typeof configAny.callTool === "function"
			) {
				console.warn(
					`[CursorRunner] Skipping MCP server '${serverName}' because in-process SDK server instances cannot be serialized to .cursor/mcp.json`,
				);
				continue;
			}

			const mapped: CursorMcpServerConfig = {};
			if (typeof configAny.command === "string") {
				mapped.command = configAny.command;
			}
			if (Array.isArray(configAny.args)) {
				mapped.args = configAny.args;
			}
			if (
				configAny.env &&
				typeof configAny.env === "object" &&
				!Array.isArray(configAny.env)
			) {
				mapped.env = configAny.env;
			}
			if (typeof configAny.cwd === "string") {
				mapped.cwd = configAny.cwd;
			}
			if (typeof configAny.url === "string") {
				mapped.url = configAny.url;
			}
			if (
				configAny.headers &&
				typeof configAny.headers === "object" &&
				!Array.isArray(configAny.headers)
			) {
				mapped.headers = configAny.headers;
			}
			if (typeof configAny.timeout === "number") {
				mapped.timeout = configAny.timeout;
			}

			if (!mapped.command && !mapped.url) {
				console.warn(
					`[CursorRunner] Skipping MCP server '${serverName}' because it has no serializable command/url transport`,
				);
				continue;
			}

			servers[serverName] = mapped;
		}

		return servers;
	}

	private syncProjectMcpConfig(): void {
		const workspacePath = this.config.workingDirectory;
		if (!workspacePath) {
			return;
		}

		const inlineServers = this.buildCursorMcpServersConfig();
		if (Object.keys(inlineServers).length === 0) {
			return;
		}

		const cursorDir = join(workspacePath, ".cursor");
		const configPath = join(cursorDir, "mcp.json");

		let existingConfig: CursorMcpConfig = { mcpServers: {} };
		try {
			if (existsSync(configPath)) {
				const parsed = JSON.parse(readFileSync(configPath, "utf8"));
				if (parsed && typeof parsed === "object") {
					existingConfig = parsed as CursorMcpConfig;
				}
			}
		} catch {
			// If existing config is malformed, overwrite with a valid mcpServers object.
		}

		const existingServers =
			existingConfig.mcpServers &&
			typeof existingConfig.mcpServers === "object" &&
			!Array.isArray(existingConfig.mcpServers)
				? (existingConfig.mcpServers as Record<string, CursorMcpServerConfig>)
				: {};

		const nextConfig: CursorMcpConfig = {
			...existingConfig,
			mcpServers: {
				...existingServers,
				...inlineServers,
			},
		};

		mkdirSync(cursorDir, { recursive: true });
		const backupPath = existsSync(configPath)
			? `${configPath}.cyrus-backup-${Date.now()}-${process.pid}`
			: null;

		try {
			if (backupPath) {
				renameSync(configPath, backupPath);
			}
			writeFileSync(
				configPath,
				`${JSON.stringify(nextConfig, null, "\t")}\n`,
				"utf8",
			);
			this.mcpConfigRestoreState = {
				configPath,
				backupPath,
			};
		} catch (error) {
			if (backupPath && existsSync(backupPath)) {
				try {
					renameSync(backupPath, configPath);
				} catch {
					// Best effort rollback; start() will surface the original failure.
				}
			}
			throw error;
		}

		console.log(
			`[CursorRunner] Synced project MCP servers at ${configPath} (servers=${Object.keys(nextConfig.mcpServers).length}, backup=${backupPath ? "yes" : "no"}; docs: ${CURSOR_MCP_CONFIG_DOCS_URL})`,
		);
	}

	private enableCursorMcpServers(): void {
		const workspacePath = this.config.workingDirectory;
		if (!workspacePath) {
			return;
		}

		const mcpCommand = process.env.CURSOR_MCP_COMMAND || "agent";
		const listResult = spawnSync(mcpCommand, ["mcp", "list"], {
			cwd: workspacePath,
			env: this.buildEnv(),
			encoding: "utf8",
		});

		if (
			(listResult.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
		) {
			console.warn(
				`[CursorRunner] Skipping MCP enable preflight: '${mcpCommand}' command not found`,
			);
			return;
		}

		const discoveredServers =
			(listResult.status ?? 1) === 0
				? parseMcpServersFromCursorListOutput(
						typeof listResult.stdout === "string" ? listResult.stdout : "",
					)
				: [];

		if ((listResult.status ?? 1) !== 0 && !listResult.error) {
			const detail =
				typeof listResult.stderr === "string" && listResult.stderr.trim()
					? listResult.stderr.trim()
					: `exit ${listResult.status ?? "unknown"}`;
			console.warn(
				`[CursorRunner] MCP list preflight failed: '${mcpCommand} mcp list' (${detail})`,
			);
		}

		// Cursor MCP enable preflight combines discovered servers and run-time inline config names.
		// MCP location/reference: https://cursor.com/docs/context/mcp#configuration-locations
		const inlineServers = Object.keys(this.config.mcpConfig || {});
		const allServers = [
			...new Set([...discoveredServers, ...inlineServers]),
		].sort((a, b) => a.localeCompare(b));

		for (const serverName of allServers) {
			const enableResult = spawnSync(
				mcpCommand,
				["mcp", "enable", serverName],
				{
					cwd: workspacePath,
					env: this.buildEnv(),
					encoding: "utf8",
				},
			);

			if (
				(enableResult.error as NodeJS.ErrnoException | undefined)?.code ===
				"ENOENT"
			) {
				console.warn(
					`[CursorRunner] Failed enabling MCP server '${serverName}': '${mcpCommand}' command not found`,
				);
				return;
			}

			if ((enableResult.status ?? 1) !== 0 || enableResult.error) {
				const detail = enableResult.error
					? enableResult.error.message
					: typeof enableResult.stderr === "string" &&
							enableResult.stderr.trim()
						? enableResult.stderr.trim()
						: `exit ${enableResult.status ?? "unknown"}`;
				console.warn(
					`[CursorRunner] Failed enabling MCP server '${serverName}' via '${mcpCommand} mcp enable ${serverName}': ${detail}`,
				);
				continue;
			}

			console.log(
				`[CursorRunner] Enabled MCP server '${serverName}' via '${mcpCommand} mcp enable ${serverName}'`,
			);
		}
	}

	private syncProjectPermissionsConfig(): void {
		const workspacePath = this.config.workingDirectory;
		if (!workspacePath) {
			return;
		}

		const mappedPermissions = this.buildCursorPermissionsConfig();

		const cursorDir = join(workspacePath, ".cursor");
		const configPath = join(cursorDir, "cli.json");

		let existingConfig: CursorPermissionsConfig = {
			permissions: { allow: [], deny: [] },
		};
		try {
			if (existsSync(configPath)) {
				const parsed = JSON.parse(readFileSync(configPath, "utf8"));
				if (parsed && typeof parsed === "object") {
					existingConfig = parsed as CursorPermissionsConfig;
				}
			}
		} catch {
			// If existing config is malformed, overwrite with a valid permissions object.
		}

		const nextConfig: CursorPermissionsConfig = {
			...existingConfig,
			permissions: mappedPermissions.permissions,
		};

		mkdirSync(cursorDir, { recursive: true });
		const backupPath = existsSync(configPath)
			? `${configPath}.cyrus-backup-${Date.now()}-${process.pid}`
			: null;

		try {
			if (backupPath) {
				renameSync(configPath, backupPath);
			}
			writeFileSync(
				configPath,
				`${JSON.stringify(nextConfig, null, "\t")}\n`,
				"utf8",
			);
			this.permissionsConfigRestoreState = {
				configPath,
				backupPath,
			};
		} catch (error) {
			if (backupPath && existsSync(backupPath)) {
				try {
					renameSync(backupPath, configPath);
				} catch {
					// Best effort rollback; start() will surface the original failure.
				}
			}
			throw error;
		}

		console.log(
			`[CursorRunner] Synced project permissions at ${configPath} (allow=${nextConfig.permissions.allow.length}, deny=${nextConfig.permissions.deny.length}, backup=${backupPath ? "yes" : "no"}; docs: ${CURSOR_CLI_PERMISSIONS_DOCS_URL})`,
		);
	}

	private restoreProjectPermissionsConfig(): void {
		const restoreState = this.permissionsConfigRestoreState;
		if (!restoreState) {
			return;
		}

		try {
			if (restoreState.backupPath) {
				if (existsSync(restoreState.configPath)) {
					unlinkSync(restoreState.configPath);
				}
				if (existsSync(restoreState.backupPath)) {
					renameSync(restoreState.backupPath, restoreState.configPath);
					console.log(
						`[CursorRunner] Restored original project permissions at ${restoreState.configPath}`,
					);
				}
				return;
			}

			if (existsSync(restoreState.configPath)) {
				unlinkSync(restoreState.configPath);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(
				`[CursorRunner] Failed to restore project permissions config at ${restoreState.configPath}: ${detail}`,
			);
		} finally {
			this.permissionsConfigRestoreState = null;
		}
	}

	private restoreProjectMcpConfig(): void {
		const restoreState = this.mcpConfigRestoreState;
		if (!restoreState) {
			return;
		}

		try {
			if (restoreState.backupPath) {
				if (existsSync(restoreState.configPath)) {
					unlinkSync(restoreState.configPath);
				}
				if (existsSync(restoreState.backupPath)) {
					renameSync(restoreState.backupPath, restoreState.configPath);
					console.log(
						`[CursorRunner] Restored original project MCP config at ${restoreState.configPath}`,
					);
				}
				return;
			}

			if (existsSync(restoreState.configPath)) {
				unlinkSync(restoreState.configPath);
			}
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			console.warn(
				`[CursorRunner] Failed to restore project MCP config at ${restoreState.configPath}: ${detail}`,
			);
		} finally {
			this.mcpConfigRestoreState = null;
		}
	}

	private checkCursorAgentVersion(
		cursorPath: string,
		expectedVersion: string,
	): string | null {
		const result = spawnSync(cursorPath, ["--version"], {
			encoding: "utf8",
			env: this.buildEnv(),
		});
		const actualVersion = result.stdout?.trim() || result.stderr?.trim() || "";
		if (!actualVersion) {
			return `cursor-agent version check failed: no output from \`${cursorPath} --version\``;
		}
		const normalizedActual = actualVersion.trim();
		const normalizedExpected = expectedVersion.trim();
		if (normalizedActual !== normalizedExpected) {
			return `cursor-agent version mismatch: expected \`${normalizedExpected}\` (tested), got \`${normalizedActual}\`. Set CYRUS_CURSOR_AGENT_VERSION to your version to skip this check, or upgrade cursor-agent to the tested version.`;
		}
		return null;
	}

	private buildArgs(prompt: string): string[] {
		const args: string[] = ["--print", "--output-format", "stream-json"];
		const normalizedModel = normalizeCursorModel(this.config.model);

		// needed or else it errors
		args.push("--trust");

		if (normalizedModel) {
			args.push("--model", normalizedModel);
		}

		if (this.config.resumeSessionId) {
			args.push("--resume", this.config.resumeSessionId);
		}

		if (this.config.workingDirectory) {
			args.push("--workspace", this.config.workingDirectory);
		}

		if (this.config.sandbox) {
			args.push("--sandbox", this.config.sandbox);
		}

		if (this.config.approveMcps ?? true) {
			args.push("--approve-mcps");
		}

		if (prompt) {
			args.push(prompt);
		}

		return args;
	}

	private buildEnv(): NodeJS.ProcessEnv {
		const env: NodeJS.ProcessEnv = { ...process.env };
		if (this.config.cursorApiKey) {
			env.CURSOR_API_KEY = this.config.cursorApiKey;
		}
		return env;
	}

	private handleStdoutLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}

		if (this.logStream) {
			this.logStream.write(`${trimmed}\n`);
		}

		const parsed = this.parseJsonLine(trimmed);
		if (!parsed) {
			this.fallbackOutputLines.push(trimmed);
			return;
		}

		this.handleEvent(parsed);
	}

	private parseJsonLine(line: string): CursorJsonEvent | null {
		if (!(line.startsWith("{") || line.startsWith("["))) {
			return null;
		}
		try {
			const parsed = JSON.parse(line);
			if (!parsed || typeof parsed !== "object") {
				return null;
			}
			return parsed as CursorJsonEvent;
		} catch {
			return null;
		}
	}

	private handleEvent(event: CursorJsonEvent): void {
		this.emit("streamEvent", event);

		const eventObj = event as Record<string, unknown>;
		const type = getStringValue(eventObj, "type");

		if (!type) {
			return;
		}

		if (
			type === "init" ||
			(type === "system" && getStringValue(eventObj, "subtype") === "init")
		) {
			const sessionId =
				getStringValue(eventObj, "session_id") || this.sessionInfo?.sessionId;
			if (sessionId && this.sessionInfo) {
				this.sessionInfo.sessionId = sessionId;
			}
			this.emitInitMessage();
			return;
		}

		if (type === "message") {
			this.emitInitMessage();
			this.handleMessageEvent(eventObj);
			return;
		}

		if (type === "assistant") {
			this.emitInitMessage();
			const messageObj = eventObj.message;
			const content =
				messageObj && typeof messageObj === "object"
					? extractTextFromMessageContent(
							(messageObj as Record<string, unknown>).content,
						)
					: "";
			if (content) {
				this.handleMessageEvent({
					role: "assistant",
					content,
				});
			}
			return;
		}

		if (type === "item.started" || type === "item.completed") {
			this.emitInitMessage();
			const item = eventObj.item;
			if (item && typeof item === "object") {
				this.handleItemEvent(type, item as Record<string, unknown>);
			}
			return;
		}

		if (type === "tool_call") {
			this.emitInitMessage();
			this.handleToolCallEvent(eventObj);
			return;
		}

		if (type === "turn.completed" || type === "result") {
			const usage = extractUsageFromEvent(eventObj);
			if (usage) {
				this.lastUsage = usage;
			}
			const stopReason = getStringValue(eventObj, "stop_reason");
			if (stopReason?.toLowerCase().includes("max")) {
				const result = this.createErrorResultMessage(
					`Cursor turn limit reached: ${stopReason}`,
				);
				this.pendingResultMessage = result;
			}
			return;
		}

		if (type === "error") {
			const message =
				getStringValue(eventObj, "message") || "Cursor execution failed";
			this.errorMessages.push(message);
			this.pendingResultMessage = this.createErrorResultMessage(message);
		}
	}

	private handleMessageEvent(event: Record<string, unknown>): void {
		const role = getStringValue(event, "role");
		const content = getStringValue(event, "content") || "";
		if (!content) {
			return;
		}

		if (role === "assistant") {
			this.lastAssistantText = content;
			const message: SDKAssistantMessage = {
				type: "assistant",
				message: createAssistantBetaMessage(content),
				parent_tool_use_id: null,
				uuid: crypto.randomUUID(),
				session_id: this.sessionInfo?.sessionId || "pending",
			};
			this.pushMessage(message);
			return;
		}

		if (role === "user") {
			const message: SDKUserMessage = {
				type: "user",
				message: {
					role: "user",
					content: [{ type: "text", text: content }],
				},
				parent_tool_use_id: null,
				session_id: this.sessionInfo?.sessionId || "pending",
			};
			this.pushMessage(message);
		}
	}

	private handleItemEvent(type: string, item: Record<string, unknown>): void {
		const projection = getProjectionForItem(item, this.config.workingDirectory);
		if (!projection) {
			return;
		}

		if (type === "item.started") {
			this.emitToolUse(projection);
			return;
		}

		this.emitToolUse(projection);
		this.emitToolResult(projection);
	}

	private handleToolCallEvent(event: Record<string, unknown>): void {
		const projection = getProjectionForToolCallEvent(
			event,
			this.config.workingDirectory,
		);
		if (!projection) {
			return;
		}

		const subtype = getStringValue(event, "subtype") || "started";
		if (subtype === "started") {
			this.emitToolUse(projection);
			return;
		}

		if (subtype === "completed" || subtype === "failed") {
			this.emitToolUse(projection);
			this.emitToolResult({
				...projection,
				isError: projection.isError || subtype === "failed",
			});
		}
	}

	private emitToolUse(projection: ToolProjection): void {
		if (this.emittedToolUseIds.has(projection.toolUseId)) {
			return;
		}
		this.emittedToolUseIds.add(projection.toolUseId);
		const message: SDKAssistantMessage = {
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
		this.pushMessage(message);
	}

	private emitToolResult(projection: ToolProjection): void {
		const message: SDKUserMessage = {
			type: "user",
			message: createUserToolResultMessage(
				projection.toolUseId,
				projection.result,
				projection.isError,
			),
			parent_tool_use_id: projection.toolUseId,
			session_id: this.sessionInfo?.sessionId || "pending",
		};
		this.pushMessage(message);
	}

	private emitInitMessage(): void {
		if (this.hasInitMessage) {
			return;
		}
		this.hasInitMessage = true;
		const sessionId = this.sessionInfo?.sessionId || crypto.randomUUID();
		const permissionModeByCursorConfig: Record<
			NonNullable<CursorRunnerConfig["askForApproval"]>,
			SDKSystemInitMessage["permissionMode"]
		> = {
			never: "dontAsk",
			"on-request": "default",
			"on-failure": "default",
			untrusted: "default",
		};
		const initMessage: SDKSystemInitMessage = {
			type: "system",
			subtype: "init",
			cwd: this.config.workingDirectory || cwd(),
			session_id: sessionId,
			tools: this.config.allowedTools || [],
			mcp_servers: [],
			model: this.config.model || "gpt-5",
			permissionMode: this.config.askForApproval
				? permissionModeByCursorConfig[this.config.askForApproval]
				: "default",
			apiKeySource: this.config.cursorApiKey ? "user" : "project",
			claude_code_version: "cursor-agent",
			slash_commands: [],
			output_style: "default",
			skills: [],
			plugins: [],
			uuid: crypto.randomUUID(),
			agents: undefined,
		};
		this.pushMessage(initMessage);
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
			errors: [errorMessage],
			stop_reason: null,
			total_cost_usd: 0,
			usage: createResultUsage(this.lastUsage),
			modelUsage: {},
			permission_denials: [],
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
	}

	private pushMessage(message: SDKMessage): void {
		this.messages.push(message);
		this.emit("message", message);
	}

	private setupLogging(sessionId: string): void {
		try {
			const logsDir = join(this.config.cyrusHome, "logs");
			mkdirSync(logsDir, { recursive: true });
			this.logStream = createWriteStream(
				join(logsDir, `cursor-${sessionId}.jsonl`),
				{ flags: "a" },
			);
		} catch {
			this.logStream = null;
		}
	}

	private finalizeSession(error?: unknown): void {
		if (!this.sessionInfo) {
			return;
		}

		this.emitInitMessage();
		this.sessionInfo.isRunning = false;
		this.restoreProjectMcpConfig();
		this.restoreProjectPermissionsConfig();

		let resultMessage: SDKResultMessage;
		if (this.pendingResultMessage) {
			resultMessage = this.pendingResultMessage;
		} else if (error || this.errorMessages.length > 0) {
			const message =
				normalizeError(error) ||
				this.errorMessages.at(-1) ||
				"Cursor execution failed";
			resultMessage = this.createErrorResultMessage(message);
		} else {
			const fallbackOutput = this.fallbackOutputLines.join("\n").trim();
			resultMessage = this.createSuccessResultMessage(
				this.lastAssistantText ||
					fallbackOutput ||
					"Cursor session completed successfully",
			);
		}

		this.pushMessage(resultMessage);
		this.emit("complete", [...this.messages]);

		if (error || this.errorMessages.length > 0) {
			const err =
				error instanceof Error
					? error
					: new Error(this.errorMessages.at(-1) || "Cursor execution failed");
			this.emit("error", err);
		}

		this.cleanupRuntimeState();
	}

	private cleanupRuntimeState(): void {
		if (this.readlineInterface) {
			this.readlineInterface.close();
			this.readlineInterface = null;
		}
		if (this.logStream) {
			this.logStream.end();
			this.logStream = null;
		}
		this.process = null;
		this.pendingResultMessage = null;
	}

	stop(): void {
		this.wasStopped = true;
		if (this.process && !this.process.killed) {
			this.process.kill();
		}
		if (this.sessionInfo) {
			this.sessionInfo.isRunning = false;
		}
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
