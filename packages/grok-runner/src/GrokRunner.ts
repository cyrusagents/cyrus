import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cwd } from "node:process";
import type {
	IAgentRunner,
	IMessageFormatter,
	SDKMessage,
	SDKResultMessage,
} from "miko-core";
import { GrokMessageFormatter } from "./formatter.js";
import type {
	GrokRunnerConfig,
	GrokRunnerEvents,
	GrokSessionInfo,
} from "./types.js";

const FORCE_KILL_DELAY_MS = 5_000;

function normalizeError(error: unknown): string {
	if (error instanceof Error) return error.message;
	if (typeof error === "string") return error;
	return "Grok execution failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function extractSessionId(
	message: SDKMessage | Record<string, unknown>,
): string | null {
	const sessionId = (message as { session_id?: unknown }).session_id;
	return typeof sessionId === "string" && sessionId.length > 0
		? sessionId
		: null;
}

export declare interface GrokRunner {
	on<K extends keyof GrokRunnerEvents>(
		event: K,
		listener: GrokRunnerEvents[K],
	): this;
	emit<K extends keyof GrokRunnerEvents>(
		event: K,
		...args: Parameters<GrokRunnerEvents[K]>
	): boolean;
}

/**
 * Spawns the Grok Build CLI headlessly and streams Claude-SDK-compatible
 * NDJSON (`--output-format streaming-messages-json`) into Miko's
 * IAgentRunner interface.
 */
export class GrokRunner extends EventEmitter implements IAgentRunner {
	readonly supportsStreamingInput = false;

	private readonly config: GrokRunnerConfig;
	private readonly formatter: IMessageFormatter;
	private sessionInfo: GrokSessionInfo | null = null;
	private messages: SDKMessage[] = [];
	private process: ChildProcessWithoutNullStreams | null = null;
	private hasInitMessage = false;
	private pendingResultMessage: SDKResultMessage | null = null;
	private lastAssistantText: string | null = null;
	private startTimestampMs = 0;
	private wasStopped = false;
	private hasFinalized = false;
	private stderr = "";
	private nonJsonStartupOutput: string[] = [];
	private promptDir: string | null = null;

	constructor(config: GrokRunnerConfig) {
		super();
		this.config = config;
		this.formatter = new GrokMessageFormatter();

		if (config.onMessage) this.on("message", config.onMessage);
		if (config.onError) this.on("error", config.onError);
		if (config.onComplete) this.on("complete", config.onComplete);
	}

	async start(prompt: string): Promise<GrokSessionInfo> {
		if (this.isRunning()) {
			throw new Error("Grok session already running");
		}

		this.resetSessionState();
		this.sessionInfo = {
			sessionId: this.config.resumeSessionId || null,
			startedAt: new Date(),
			isRunning: true,
		};

		return new Promise<GrokSessionInfo>((resolve) => {
			let stdoutBuffer = "";
			let inactivityTimer: NodeJS.Timeout | undefined;
			let forceKillTimer: NodeJS.Timeout | undefined;
			const inactivityTimeoutMs = this.config.inactivityTimeoutMs;

			let args: string[];
			try {
				args = this.buildArgs(prompt);
			} catch (error) {
				this.finalizeSession(error);
				resolve(this.sessionInfo as GrokSessionInfo);
				return;
			}

			const child = spawn(this.config.grokPath || "grok", args, {
				cwd: this.config.workingDirectory || cwd(),
				env: {
					...process.env,
					...this.config.additionalEnv,
					...this.config.env,
				},
				stdio: ["pipe", "pipe", "pipe"],
			});
			this.process = child;
			child.stdin.end();

			const clearInactivityTimers = () => {
				if (inactivityTimer) clearTimeout(inactivityTimer);
				if (forceKillTimer) clearTimeout(forceKillTimer);
			};
			const refreshInactivityTimer = () => {
				if (!inactivityTimeoutMs || inactivityTimeoutMs <= 0) {
					return;
				}
				if (inactivityTimer) clearTimeout(inactivityTimer);
				inactivityTimer = setTimeout(() => {
					const timeoutDescription =
						inactivityTimeoutMs >= 60_000
							? `${Math.round(inactivityTimeoutMs / 60_000)} minutes`
							: `${inactivityTimeoutMs}ms`;
					const error = new Error(
						`Grok produced no output for ${timeoutDescription} and was terminated`,
					);
					this.finalizeSession(error);
					resolve(this.sessionInfo as GrokSessionInfo);
					child.kill("SIGTERM");
					forceKillTimer = setTimeout(() => {
						if (child.exitCode === null && child.signalCode === null) {
							child.kill("SIGKILL");
						}
					}, FORCE_KILL_DELAY_MS);
				}, inactivityTimeoutMs);
			};
			refreshInactivityTimer();

			child.stdout.on("data", (chunk: Buffer) => {
				refreshInactivityTimer();
				stdoutBuffer += chunk.toString("utf8");
				const lines = stdoutBuffer.split(/\r?\n/);
				stdoutBuffer = lines.pop() || "";
				for (const line of lines) {
					this.handleLine(line);
				}
			});

			child.stderr.on("data", (chunk: Buffer) => {
				refreshInactivityTimer();
				this.stderr += chunk.toString("utf8");
			});

			child.on("error", (error) => {
				clearInactivityTimers();
				this.cleanupPromptDir();
				this.finalizeSession(error);
				resolve(this.sessionInfo as GrokSessionInfo);
			});

			child.on("close", (code, signal) => {
				clearInactivityTimers();
				this.cleanupPromptDir();
				if (stdoutBuffer.trim()) {
					this.handleLine(stdoutBuffer);
				}

				let error: Error | undefined;
				if (this.wasStopped) {
					error = new Error("Grok session stopped");
				} else if (typeof code === "number" && code !== 0) {
					const output =
						this.stderr.trim() || this.nonJsonStartupOutput.join("\n").trim();
					const suffix = output ? `: ${output}` : "";
					error = new Error(`Grok exited with code ${code}${suffix}`);
				} else if (signal) {
					error = new Error(`Grok exited with signal ${signal}`);
				}

				this.finalizeSession(error);
				resolve(this.sessionInfo as GrokSessionInfo);
			});
		});
	}

	async startStreaming(initialPrompt?: string): Promise<GrokSessionInfo> {
		return this.start(initialPrompt || "");
	}

	addStreamMessage(_content: string): void {
		throw new Error("GrokRunner does not support streaming input messages");
	}

	completeStream(): void {
		// No-op: GrokRunner does not support streaming input.
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
		this.pendingResultMessage = null;
		this.lastAssistantText = null;
		this.startTimestampMs = Date.now();
		this.wasStopped = false;
		this.hasFinalized = false;
		this.stderr = "";
		this.nonJsonStartupOutput = [];
		this.cleanupPromptDir();
	}

	private cleanupPromptDir(): void {
		if (!this.promptDir) return;
		try {
			rmSync(this.promptDir, { recursive: true, force: true });
		} catch {
			// Best-effort cleanup.
		}
		this.promptDir = null;
	}

	private buildArgs(prompt: string): string[] {
		const workingDirectory = this.config.workingDirectory || cwd();
		const fullPrompt = this.buildInputPrompt(prompt);

		this.promptDir = mkdtempSync(join(tmpdir(), "miko-grok-prompt-"));
		const promptFile = join(this.promptDir, "prompt.txt");
		writeFileSync(promptFile, fullPrompt, "utf8");

		const args = [
			"--output-format",
			"streaming-messages-json",
			"--always-approve",
			"--cwd",
			workingDirectory,
			"--prompt-file",
			promptFile,
		];

		if (this.config.model) {
			args.push("-m", this.config.model);
		}
		if (this.config.maxTurns !== undefined) {
			args.push("--max-turns", String(this.config.maxTurns));
		}
		if (this.config.resumeSessionId) {
			args.push("-r", this.config.resumeSessionId);
		}
		if (this.config.allowedTools && this.config.allowedTools.length > 0) {
			args.push("--tools", this.config.allowedTools.join(","));
		}
		if (this.config.disallowedTools && this.config.disallowedTools.length > 0) {
			args.push("--disallowed-tools", this.config.disallowedTools.join(","));
		}

		return args;
	}

	private buildInputPrompt(prompt: string): string {
		const systemPrompt = this.config.appendSystemPrompt?.trim();
		if (!systemPrompt) return prompt;
		// Prepend rather than --system-prompt-override so Grok keeps its
		// built-in agent instructions.
		return `${systemPrompt}\n\n${prompt}`;
	}

	private handleLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch (error) {
			if (!this.hasInitMessage) {
				this.nonJsonStartupOutput.push(trimmed);
				return;
			}
			this.emitError(
				new Error(
					`Failed to parse Grok JSON event: ${normalizeError(error)} (${trimmed})`,
				),
			);
			return;
		}

		if (!isRecord(parsed) || typeof parsed.type !== "string") {
			return;
		}

		this.handleMessage(parsed as SDKMessage);
	}

	private handleMessage(message: SDKMessage): void {
		const sessionId = extractSessionId(message);
		if (sessionId && this.sessionInfo) {
			this.sessionInfo.sessionId = sessionId;
		}

		if (
			message.type === "system" &&
			(message as { subtype?: string }).subtype === "init"
		) {
			this.hasInitMessage = true;
		}

		if (message.type === "assistant") {
			const content = (message as { message?: { content?: unknown } }).message
				?.content;
			if (Array.isArray(content)) {
				for (const block of content) {
					if (
						isRecord(block) &&
						block.type === "text" &&
						typeof block.text === "string" &&
						block.text.trim()
					) {
						this.lastAssistantText = block.text.trim();
					}
				}
			}
		}

		if (message.type === "result") {
			this.pendingResultMessage = message as SDKResultMessage;
			// Defer emitting until process close so result stays terminal.
			return;
		}

		this.pushMessage(message);
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
			} as SDKResultMessage["usage"],
			modelUsage: {},
			permission_denials: [],
			uuid: randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		} as SDKResultMessage;
	}

	private createSuccessResultMessage(result: string): SDKResultMessage {
		return {
			type: "result",
			subtype: "success",
			duration_ms: Math.max(Date.now() - this.startTimestampMs, 0),
			duration_api_ms: 0,
			is_error: false,
			num_turns: 1,
			result,
			stop_reason: null,
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
			} as SDKResultMessage["usage"],
			modelUsage: {},
			permission_denials: [],
			uuid: randomUUID(),
			session_id: this.sessionInfo?.sessionId || "pending",
		} as SDKResultMessage;
	}

	private finalizeSession(error?: unknown): void {
		if (this.hasFinalized) {
			return;
		}
		this.hasFinalized = true;

		if (!this.sessionInfo) {
			return;
		}

		this.sessionInfo.isRunning = false;
		this.process = null;

		if (!this.hasInitMessage) {
			const sessionId =
				this.sessionInfo.sessionId || this.config.resumeSessionId || "pending";
			this.pushMessage({
				type: "system",
				subtype: "init",
				agents: undefined,
				apiKeySource: "user",
				claude_code_version: "grok-cli",
				cwd: this.config.workingDirectory || cwd(),
				tools: this.config.allowedTools || [],
				mcp_servers: [],
				model: this.config.model || "grok-4.6",
				permissionMode: "default",
				slash_commands: [],
				output_style: "default",
				skills: [],
				plugins: [],
				uuid: randomUUID(),
				session_id: sessionId,
			} as SDKMessage);
			this.hasInitMessage = true;
			this.sessionInfo.sessionId = sessionId;
		}

		if (error) {
			const normalized = normalizeError(error);
			if (!this.pendingResultMessage) {
				this.pendingResultMessage = this.createErrorResultMessage(normalized);
			}
			this.emitError(error instanceof Error ? error : new Error(normalized));
		}

		if (!this.pendingResultMessage) {
			this.pendingResultMessage = this.createSuccessResultMessage(
				this.lastAssistantText || "Grok session completed successfully",
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
