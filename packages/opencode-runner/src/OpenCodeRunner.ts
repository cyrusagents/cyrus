import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";
import { cwd } from "node:process";
import type {
	IAgentRunner,
	IMessageFormatter,
	SDKAssistantMessage,
	SDKMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import { OpenCodeMessageFormatter } from "./formatter.js";
import type {
	OpenCodeJsonEvent,
	OpenCodeRunnerConfig,
	OpenCodeRunnerEvents,
	OpenCodeSessionInfo,
	OpenCodeStepFinishEvent,
	OpenCodeToolUseEvent,
} from "./types.js";

type SDKSystemInitMessage = Extract<
	SDKMessage,
	{ type: "system"; subtype: "init" }
>;

type ToolInput = Record<string, unknown>;

interface ParsedUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

interface ToolProjection {
	toolUseId: string;
	toolName: string;
	toolInput: ToolInput;
	result: string;
	isError: boolean;
	hasResult: boolean;
}

const DEFAULT_OPENCODE_MODEL = "opencode";

function asRecord(value: unknown): Record<string, unknown> | null {
	if (value && typeof value === "object" && !Array.isArray(value)) {
		return value as Record<string, unknown>;
	}
	return null;
}

function safeStringify(value: unknown): string {
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "OpenCode execution failed";
}

function toFiniteNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function normalizeToolName(toolName: string): string {
	const normalized = toolName.toLowerCase().replace(/[\s_-]+/g, "");
	switch (normalized) {
		case "bash":
		case "shell":
		case "terminal":
			return "Bash";
		case "edit":
		case "patch":
			return "Edit";
		case "read":
			return "Read";
		case "write":
			return "Write";
		case "grep":
			return "Grep";
		case "glob":
			return "Glob";
		case "webfetch":
		case "fetch":
			return "WebFetch";
		case "websearch":
		case "search":
			return "WebSearch";
		default:
			return toolName || "tool";
	}
}

function normalizeToolInput(input: unknown): ToolInput {
	const record = asRecord(input);
	if (!record) {
		return {};
	}

	const normalized: ToolInput = { ...record };
	if (typeof record.filePath === "string" && !normalized.file_path) {
		normalized.file_path = record.filePath;
	}
	return normalized;
}

function outputToString(output: unknown, metadata: unknown): string {
	if (typeof output === "string") {
		return output;
	}
	if (output !== undefined) {
		return safeStringify(output);
	}
	if (metadata !== undefined) {
		return safeStringify(metadata);
	}
	return "Tool completed";
}

function createAssistantToolUseMessage(
	toolUseId: string,
	toolName: string,
	toolInput: ToolInput,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	return {
		id: messageId,
		type: "message",
		role: "assistant",
		content: [
			{ type: "tool_use", id: toolUseId, name: toolName, input: toolInput },
		] as unknown as SDKAssistantMessage["message"]["content"],
		model: DEFAULT_OPENCODE_MODEL,
		stop_reason: null,
		stop_sequence: null,
		stop_details: null,
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

function createAssistantTextMessage(
	text: string,
	messageId: string = crypto.randomUUID(),
): SDKAssistantMessage["message"] {
	return {
		id: messageId,
		type: "message",
		role: "assistant",
		content: [
			{ type: "text", text },
		] as unknown as SDKAssistantMessage["message"]["content"],
		model: DEFAULT_OPENCODE_MODEL,
		stop_reason: null,
		stop_sequence: null,
		stop_details: null,
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
	return {
		role: "user",
		content: [
			{
				type: "tool_result",
				tool_use_id: toolUseId,
				content: result,
				is_error: isError,
			},
		] as unknown as SDKUserMessage["message"]["content"],
	};
}

function createResultUsage(usage: ParsedUsage): SDKResultMessage["usage"] {
	return {
		input_tokens: usage.inputTokens,
		output_tokens: usage.outputTokens,
		cache_creation_input_tokens: usage.cacheWriteTokens,
		cache_read_input_tokens: usage.cacheReadTokens,
		cache_creation: {
			ephemeral_1h_input_tokens: 0,
			ephemeral_5m_input_tokens: 0,
		},
	} as SDKResultMessage["usage"];
}

function parseUsage(event: OpenCodeStepFinishEvent): ParsedUsage {
	const usage = event.usage || {};
	return {
		inputTokens: toFiniteNumber(usage.inputTokens ?? usage.input_tokens),
		outputTokens: toFiniteNumber(usage.outputTokens ?? usage.output_tokens),
		cacheReadTokens: toFiniteNumber(
			usage.cacheReadTokens ?? usage.cache_read_input_tokens,
		),
		cacheWriteTokens: toFiniteNumber(
			usage.cacheWriteTokens ?? usage.cache_creation_input_tokens,
		),
	};
}

function parseCost(event: OpenCodeStepFinishEvent): number {
	return toFiniteNumber(
		event.cost ?? event.totalCostUSD ?? event.total_cost_usd,
	);
}

export declare interface OpenCodeRunner {
	on<K extends keyof OpenCodeRunnerEvents>(
		event: K,
		listener: OpenCodeRunnerEvents[K],
	): this;
	emit<K extends keyof OpenCodeRunnerEvents>(
		event: K,
		...args: Parameters<OpenCodeRunnerEvents[K]>
	): boolean;
}

export class OpenCodeRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = false;

	private readonly config: OpenCodeRunnerConfig;
	private readonly formatter: IMessageFormatter;
	private sessionInfo: OpenCodeSessionInfo | null = null;
	private messages: SDKMessage[] = [];
	private process: ChildProcessWithoutNullStreams | null = null;
	private hasInitMessage = false;
	private emittedToolUseIds = new Set<string>();
	private pendingResultMessage: SDKResultMessage | null = null;
	private lastAssistantText: string | null = null;
	private lastUsage: ParsedUsage = {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0,
	};
	private totalCostUsd = 0;
	private startTimestampMs = 0;
	private wasStopped = false;
	private stderr = "";

	constructor(config: OpenCodeRunnerConfig) {
		super();
		this.config = config;
		this.formatter = new OpenCodeMessageFormatter();

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<OpenCodeSessionInfo> {
		if (this.isRunning()) {
			throw new Error("OpenCode session already running");
		}

		this.resetSessionState();
		this.sessionInfo = {
			sessionId: this.config.resumeSessionId || null,
			startedAt: new Date(),
			isRunning: true,
		};

		return new Promise<OpenCodeSessionInfo>((resolve) => {
			let stdoutBuffer = "";
			const args = this.buildArgs();
			const child = spawn(this.config.openCodePath || "opencode", args, {
				cwd: this.config.workingDirectory || cwd(),
				env: {
					...process.env,
					...this.config.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.process = child;

			child.stdout.on("data", (chunk: Buffer) => {
				stdoutBuffer += chunk.toString("utf8");
				const lines = stdoutBuffer.split(/\r?\n/);
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) {
					this.handleLine(line);
				}
			});

			child.stderr.on("data", (chunk: Buffer) => {
				this.stderr += chunk.toString("utf8");
			});

			child.on("error", (error) => {
				this.emitError(error);
				this.finalizeSession(error);
				resolve(this.sessionInfo as OpenCodeSessionInfo);
			});

			child.on("close", (code, signal) => {
				if (stdoutBuffer.trim()) {
					this.handleLine(stdoutBuffer);
				}

				let error: Error | undefined;
				if (this.wasStopped) {
					error = new Error("OpenCode session stopped");
				} else if (typeof code === "number" && code !== 0) {
					const suffix = this.stderr.trim() ? `: ${this.stderr.trim()}` : "";
					error = new Error(`OpenCode exited with code ${code}${suffix}`);
				} else if (signal) {
					error = new Error(`OpenCode exited with signal ${signal}`);
				}

				this.finalizeSession(error);
				resolve(this.sessionInfo as OpenCodeSessionInfo);
			});

			child.stdin.end(prompt);
		});
	}

	async startStreaming(initialPrompt?: string): Promise<OpenCodeSessionInfo> {
		return this.start(initialPrompt || "");
	}

	addStreamMessage(_content: string): void {
		throw new Error("OpenCodeRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op: OpenCodeRunner does not support streaming input.
	}

	stop(): void {
		if (!this.sessionInfo?.isRunning) {
			return;
		}
		this.wasStopped = true;
		this.process?.kill("SIGTERM");
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

	private resetSessionState(): void {
		this.messages = [];
		this.process = null;
		this.hasInitMessage = false;
		this.emittedToolUseIds = new Set();
		this.pendingResultMessage = null;
		this.lastAssistantText = null;
		this.lastUsage = {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
		};
		this.totalCostUsd = 0;
		this.startTimestampMs = Date.now();
		this.wasStopped = false;
		this.stderr = "";
	}

	private buildArgs(): string[] {
		const args = [
			"run",
			"--format",
			"json",
			"--dir",
			this.config.workingDirectory || cwd(),
			"--title",
			this.config.title || "Cyrus OpenCode session",
		];

		if (this.config.model) {
			args.push("--model", this.config.model);
		}
		if (this.config.agent) {
			args.push("--agent", this.config.agent);
		}
		if (this.config.resumeSessionId) {
			args.push("--session", this.config.resumeSessionId);
		}

		return args;
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}

		try {
			this.handleEvent(JSON.parse(trimmed) as OpenCodeJsonEvent);
		} catch (error) {
			this.emitError(
				new Error(
					`Failed to parse OpenCode JSON event: ${normalizeError(error)} (${trimmed})`,
				),
			);
		}
	}

	private handleEvent(event: OpenCodeJsonEvent): void {
		this.emit("streamEvent", event);

		switch (event.type) {
			case "step_start": {
				const sessionId =
					event.sessionID || event.sessionId || event.session_id || "pending";
				if (this.sessionInfo) {
					this.sessionInfo.sessionId = sessionId;
				}
				this.emitSystemInitMessage(sessionId);
				break;
			}
			case "tool_use":
				this.emitToolMessages(event);
				break;
			case "text":
				this.emitAssistantMessage(event.part?.text || "");
				break;
			case "step_finish":
				this.lastUsage = parseUsage(event);
				this.totalCostUsd = parseCost(event);
				this.pendingResultMessage = this.createSuccessResultMessage(
					this.lastAssistantText || "OpenCode session completed successfully",
					event.reason || event.stopReason || event.stop_reason || null,
				);
				break;
			default:
				break;
		}
	}

	private projectToolUse(event: OpenCodeToolUseEvent): ToolProjection | null {
		const part = event.part;
		const callId = part?.callID || part?.callId || part?.call_id;
		if (!callId) {
			return null;
		}

		const state = part.state || {};
		const status = (state.status || "").toLowerCase();
		const isError =
			status === "error" ||
			status === "failed" ||
			status === "cancelled" ||
			state.error !== undefined;
		const hasResult =
			state.output !== undefined ||
			state.metadata !== undefined ||
			isError ||
			status === "completed" ||
			status === "success";

		return {
			toolUseId: callId,
			toolName: normalizeToolName(part.tool || "tool"),
			toolInput: normalizeToolInput(state.input),
			result: outputToString(state.output ?? state.error, state.metadata),
			isError,
			hasResult,
		};
	}

	private emitToolMessages(event: OpenCodeToolUseEvent): void {
		const projection = this.projectToolUse(event);
		if (!projection) {
			return;
		}

		if (!this.emittedToolUseIds.has(projection.toolUseId)) {
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
			this.emittedToolUseIds.add(projection.toolUseId);
		}

		if (!projection.hasResult) {
			return;
		}

		const message: SDKUserMessage = {
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
		this.pushMessage(message);
		this.emittedToolUseIds.delete(projection.toolUseId);
	}

	private emitAssistantMessage(text: string): void {
		const normalized = text.trim();
		if (!normalized) {
			return;
		}

		this.lastAssistantText = normalized;
		const message: SDKAssistantMessage = {
			type: "assistant",
			message: createAssistantTextMessage(normalized),
			parent_tool_use_id: null,
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
		this.pushMessage(message);
	}

	private emitSystemInitMessage(sessionId: string): void {
		if (this.hasInitMessage) {
			return;
		}
		this.hasInitMessage = true;

		const message: SDKSystemInitMessage = {
			type: "system",
			subtype: "init",
			agents: undefined,
			apiKeySource: "user",
			claude_code_version: "opencode-cli",
			cwd: this.config.workingDirectory || cwd(),
			tools: [],
			mcp_servers: [],
			model: this.config.model || DEFAULT_OPENCODE_MODEL,
			permissionMode: "default",
			slash_commands: [],
			output_style: "default",
			skills: [],
			plugins: [],
			uuid: crypto.randomUUID(),
			session_id: sessionId,
		};
		this.pushMessage(message);
	}

	private createSuccessResultMessage(
		result: string,
		stopReason: string | null = null,
	): SDKResultMessage {
		return {
			type: "result",
			subtype: "success",
			duration_ms: Math.max(Date.now() - this.startTimestampMs, 0),
			duration_api_ms: 0,
			is_error: false,
			num_turns: 1,
			result,
			stop_reason: stopReason,
			total_cost_usd: this.totalCostUsd,
			usage: createResultUsage(this.lastUsage),
			modelUsage: {},
			permission_denials: [],
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
	}

	private createErrorResultMessage(errorMessage: string): SDKResultMessage {
		return {
			type: "result",
			subtype: "error_during_execution",
			duration_ms: Math.max(Date.now() - this.startTimestampMs, 0),
			duration_api_ms: 0,
			is_error: true,
			num_turns: 1,
			stop_reason: null,
			errors: [errorMessage],
			total_cost_usd: this.totalCostUsd,
			usage: createResultUsage(this.lastUsage),
			modelUsage: {},
			permission_denials: [],
			uuid: crypto.randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		};
	}

	private finalizeSession(error?: unknown): void {
		if (!this.sessionInfo) {
			return;
		}

		this.sessionInfo.isRunning = false;
		this.process = null;

		if (!this.hasInitMessage) {
			this.emitSystemInitMessage(
				this.sessionInfo.sessionId || this.config.resumeSessionId || "pending",
			);
		}

		if (error) {
			const normalized = normalizeError(error);
			this.pendingResultMessage = this.createErrorResultMessage(normalized);
			this.emitError(error instanceof Error ? error : new Error(normalized));
		}

		if (!this.pendingResultMessage) {
			this.pendingResultMessage = this.createSuccessResultMessage(
				this.lastAssistantText || "OpenCode session completed successfully",
			);
		}

		this.pushMessage(this.pendingResultMessage);
		this.pendingResultMessage = null;
		this.emit("complete", [...this.messages]);
	}

	private pushMessage(message: SDKMessage): void {
		this.messages.push(message);
		this.emit("message", message);
	}

	private emitError(error: Error): void {
		if (this.listenerCount("error") > 0) {
			this.emit("error", error);
		}
	}
}
