import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ResolvedCodexConfig } from "../backend/types.js";
import type {
	CodexConfigOverrides,
	CodexConfigValue,
	CodexRunnerConfig,
} from "../types.js";
import { buildCodexMcpServersConfig } from "./mcpConfigTranslator.js";
import { resolveCodexSandbox } from "./sandboxPolicy.js";

function getDefaultReasoningEffortForModel(
	model?: string,
): CodexRunnerConfig["modelReasoningEffort"] | undefined {
	// All gpt-5 variants (including plain "gpt-5") reject xhigh; pin to "high".
	return /^gpt-5/i.test(model || "") ? "high" : undefined;
}

/**
 * Assembles a transport-neutral {@link ResolvedCodexConfig} from a
 * {@link CodexRunnerConfig}. Single responsibility: configuration resolution
 * (model fallback, sandbox, reasoning effort, MCP translation, env, home dir).
 * Produces no side effects beyond ensuring the Codex home directory exists.
 */
export class CodexConfigBuilder {
	constructor(private readonly config: CodexRunnerConfig) {}

	async build(): Promise<ResolvedCodexConfig> {
		await this.resolveModelWithFallback();

		const codexHome = this.resolveCodexHome();
		const reasoningEffort =
			this.config.modelReasoningEffort ??
			getDefaultReasoningEffortForModel(this.config.model);
		const webSearchMode =
			this.config.webSearchMode ??
			(this.config.includeWebSearch ? "live" : undefined);

		return {
			model: this.config.model,
			sandbox: resolveCodexSandbox({
				mode: this.config.sandbox || "workspace-write",
				workingDirectory: this.config.workingDirectory,
				writableRoots: this.getAdditionalDirectories(),
				networkAccess: this.resolveNetworkAccess(),
				sandboxSettings: this.config.sandboxSettings,
			}),
			workingDirectory: this.config.workingDirectory,
			approvalPolicy: this.config.askForApproval || "never",
			skipGitRepoCheck: this.config.skipGitRepoCheck ?? true,
			modelReasoningEffort: reasoningEffort,
			webSearchMode,
			developerInstructions:
				(this.config.appendSystemPrompt ?? "").trim() || undefined,
			configOverrides: this.buildConfigOverrides(),
			env: this.buildEnvOverride(codexHome),
			codexHome,
			codexPath: this.config.codexPath,
			outputSchema: this.config.outputSchema,
			resumeSessionId: this.config.resumeSessionId,
		};
	}

	/**
	 * Network intent for the sandbox. Defaults to enabled (so common remote
	 * workflows — git/gh — work without danger-full-access); honors an explicit
	 * `sandbox_workspace_write.network_access` in the passed-through overrides.
	 */
	private resolveNetworkAccess(): boolean {
		const sww = this.config.configOverrides?.sandbox_workspace_write;
		if (
			sww &&
			typeof sww === "object" &&
			!Array.isArray(sww) &&
			typeof (sww as { network_access?: boolean }).network_access === "boolean"
		) {
			return (sww as { network_access: boolean }).network_access;
		}
		return true;
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

	/**
	 * Global Codex config overrides — currently just MCP servers. Sandbox
	 * (writable/readable roots, network) is owned by {@link resolveCodexSandbox}
	 * and `developer_instructions` is surfaced on
	 * {@link ResolvedCodexConfig.developerInstructions}, so neither is injected
	 * here. Any caller-supplied `sandbox_workspace_write` is dropped (its
	 * `network_access` is folded into the sandbox decision via
	 * {@link resolveNetworkAccess}) to keep a single source of truth.
	 */
	private buildConfigOverrides(): CodexConfigOverrides | undefined {
		const { sandbox_workspace_write: _dropped, ...rest } =
			this.config.configOverrides ?? {};
		const configOverrides: CodexConfigOverrides = { ...rest };

		const mcpServers = buildCodexMcpServersConfig({
			workingDirectory: this.config.workingDirectory,
			mcpConfigPath: this.config.mcpConfigPath,
			mcpConfig: this.config.mcpConfig,
			allowedTools: this.config.allowedTools,
		});
		if (mcpServers) {
			const existingMcpServers = configOverrides.mcp_servers;
			configOverrides.mcp_servers =
				existingMcpServers &&
				typeof existingMcpServers === "object" &&
				!Array.isArray(existingMcpServers)
					? {
							...(existingMcpServers as Record<string, CodexConfigValue>),
							...mcpServers,
						}
					: mcpServers;
		}

		return Object.keys(configOverrides).length > 0
			? configOverrides
			: undefined;
	}

	/**
	 * If the configured model is unreachable via the OpenAI API, swap to the
	 * fallback model before starting. Skipped when there is no API key (Codex
	 * native auth handles access) or when the user has a ChatGPT subscription.
	 */
	private async resolveModelWithFallback(): Promise<void> {
		const model = this.config.model;
		const fallback = this.config.fallbackModel;
		if (!model || !fallback || fallback === model) return;

		const apiKey = process.env.OPENAI_API_KEY;
		if (!apiKey) return;

		if (await this.hasCodexSubscription()) return;

		const baseUrl = (
			process.env.OPENAI_BASE_URL ||
			process.env.OPENAI_API_BASE ||
			"https://api.openai.com/v1"
		).replace(/\/+$/, "");

		try {
			const response = await fetch(
				`${baseUrl}/models/${encodeURIComponent(model)}`,
				{
					method: "GET",
					headers: { Authorization: `Bearer ${apiKey}` },
					signal: AbortSignal.timeout(10_000),
				},
			);
			if (response.status === 404) {
				console.log(
					`[CodexRunner] Model "${model}" not found (404), falling back to "${fallback}"`,
				);
				this.config.model = fallback;
			}
		} catch {
			// Network error or timeout — proceed with the original model and let
			// the backend surface any downstream failure.
		}
	}

	private async hasCodexSubscription(): Promise<boolean> {
		const codexBin = this.config.codexPath || "codex";
		try {
			const { execFile } = await import("node:child_process");
			const { promisify } = await import("node:util");
			const execFileAsync = promisify(execFile);
			const { stdout, stderr } = await execFileAsync(
				codexBin,
				["login", "status"],
				{ timeout: 5_000 },
			);
			const result = /logged in using chatgpt/i.test(stdout + stderr);
			console.log(
				`[CodexRunner] hasCodexSubscription: ${result} (stdout: "${stdout.trim()}"${stderr.trim() ? `, stderr: "${stderr.trim()}"` : ""})`,
			);
			return result;
		} catch (error) {
			console.warn(
				`[CodexRunner] hasCodexSubscription error (returning false): ${error instanceof Error ? error.message : String(error)}`,
			);
			return false;
		}
	}
}
