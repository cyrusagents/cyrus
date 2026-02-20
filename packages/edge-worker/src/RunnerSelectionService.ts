import {
	getAllTools,
	getCoordinatorTools,
	getReadOnlyTools,
	getSafeTools,
} from "cyrus-claude-runner";
import type {
	CyrusAgentSession,
	EdgeWorkerConfig,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";

import type { ProcedureAnalyzer } from "./procedures/index.js";

export class RunnerSelectionService {
	private config: EdgeWorkerConfig;
	private logger: ILogger;

	constructor(config: EdgeWorkerConfig, logger: ILogger) {
		this.config = config;
		this.logger = logger;
	}

	/**
	 * Determine the default runner type.
	 *
	 * Priority:
	 * 1. Explicit `defaultRunner` in config
	 * 2. Auto-detect from available API keys (if exactly one runner has keys)
	 * 3. Fall back to "claude"
	 */
	public getDefaultRunner(): "claude" | "gemini" | "codex" | "cursor" {
		if (this.config.defaultRunner) {
			return this.config.defaultRunner;
		}

		// Auto-detect from environment: if exactly one runner's API key is set, use it
		const available: Array<"claude" | "gemini" | "codex" | "cursor"> = [];
		if (process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY) {
			available.push("claude");
		}
		if (process.env.GEMINI_API_KEY) {
			available.push("gemini");
		}
		if (process.env.OPENAI_API_KEY) {
			available.push("codex");
		}
		if (process.env.CURSOR_API_KEY) {
			available.push("cursor");
		}

		if (available.length === 1 && available[0]) {
			return available[0];
		}

		return "claude";
	}

	/**
	 * Resolve default model for a given runner from config with sensible built-in defaults.
	 */
	public getDefaultModelForRunner(
		runnerType: "claude" | "gemini" | "codex" | "cursor",
	): string {
		if (runnerType === "claude") {
			return (
				this.config.claudeDefaultModel || this.config.defaultModel || "opus"
			);
		}
		if (runnerType === "gemini") {
			return this.config.geminiDefaultModel || "gemini-2.5-pro";
		}
		if (runnerType === "cursor") {
			return "gpt-5";
		}
		return this.config.codexDefaultModel || "gpt-5.3-codex";
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	public getDefaultFallbackModelForRunner(
		runnerType: "claude" | "gemini" | "codex" | "cursor",
	): string {
		if (runnerType === "claude") {
			return (
				this.config.claudeDefaultFallbackModel ||
				this.config.defaultFallbackModel ||
				"sonnet"
			);
		}
		if (runnerType === "gemini") {
			return "gemini-2.5-flash";
		}
		if (runnerType === "cursor") {
			return "gpt-5";
		}
		return "gpt-5";
	}

	/**
	 * Parse a bracketed tag from issue description.
	 *
	 * Supports escaped brackets (`\\[tag=value\\]`) which Linear can emit.
	 */
	public parseDescriptionTag(
		description: string,
		tagName: string,
	): string | undefined {
		const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		const pattern = new RegExp(
			`\\\\?\\[${escapedTag}=([a-zA-Z0-9_.:/-]+)\\\\?\\]`,
			"i",
		);
		const match = description.match(pattern);
		return match?.[1];
	}

	/**
	 * Determine runner type and model using labels + issue description tags.
	 *
	 * Supported description tags:
	 * - [agent=claude|gemini|codex|cursor]
	 * - [model=<model-name>]
	 *
	 * Precedence:
	 * 1. Description tags override labels
	 * 2. Agent labels override model labels
	 * 3. Model labels can infer agent type
	 * 4. Defaults to claude runner
	 */
	public determineRunnerSelection(
		labels: string[],
		issueDescription?: string,
	): {
		runnerType: "claude" | "gemini" | "codex" | "cursor";
		modelOverride?: string;
		fallbackModelOverride?: string;
	} {
		const normalizedLabels = (labels || []).map((label) => label.toLowerCase());
		const normalizedDescription = issueDescription || "";
		const descriptionAgentTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"agent",
		);
		const descriptionModelTagRaw = this.parseDescriptionTag(
			normalizedDescription,
			"model",
		);

		const defaultModelByRunner: Record<
			"claude" | "gemini" | "codex" | "cursor",
			string
		> = {
			claude: this.getDefaultModelForRunner("claude"),
			gemini: this.getDefaultModelForRunner("gemini"),
			codex: this.getDefaultModelForRunner("codex"),
			cursor: this.getDefaultModelForRunner("cursor"),
		};
		const defaultFallbackByRunner: Record<
			"claude" | "gemini" | "codex" | "cursor",
			string
		> = {
			claude: this.getDefaultFallbackModelForRunner("claude"),
			gemini: this.getDefaultFallbackModelForRunner("gemini"),
			codex: this.getDefaultFallbackModelForRunner("codex"),
			cursor: this.getDefaultFallbackModelForRunner("cursor"),
		};

		const isCodexModel = (model: string): boolean =>
			/gpt-[a-z0-9.-]*codex$/i.test(model) || /^gpt-[a-z0-9.-]+$/i.test(model);

		const inferRunnerFromModel = (
			model?: string,
		): "claude" | "gemini" | "codex" | "cursor" | undefined => {
			if (!model) return undefined;
			const normalizedModel = model.toLowerCase();
			if (normalizedModel.startsWith("gemini")) return "gemini";
			if (
				normalizedModel === "opus" ||
				normalizedModel === "sonnet" ||
				normalizedModel === "haiku" ||
				normalizedModel.startsWith("claude")
			) {
				return "claude";
			}
			if (isCodexModel(normalizedModel)) return "codex";
			return undefined;
		};

		const inferFallbackModel = (
			model: string,
			runnerType: "claude" | "gemini" | "codex" | "cursor",
		): string | undefined => {
			const normalizedModel = model.toLowerCase();
			if (runnerType === "claude") {
				if (normalizedModel === "opus") return "sonnet";
				if (normalizedModel === "sonnet") return "haiku";
				// Keep haiku fallback on sonnet for retry behavior
				if (normalizedModel === "haiku") return "sonnet";
				return "sonnet";
			}
			if (runnerType === "gemini") {
				if (
					normalizedModel === "gemini-3" ||
					normalizedModel === "gemini-3-pro" ||
					normalizedModel === "gemini-3-pro-preview"
				) {
					return "gemini-2.5-pro";
				}
				if (
					normalizedModel === "gemini-2.5-pro" ||
					normalizedModel === "gemini-2.5"
				) {
					return "gemini-2.5-flash";
				}
				if (normalizedModel === "gemini-2.5-flash") {
					return "gemini-2.5-flash-lite";
				}
				if (normalizedModel === "gemini-2.5-flash-lite") {
					return "gemini-2.5-flash-lite";
				}
				return "gemini-2.5-flash";
			}
			if (isCodexModel(normalizedModel)) {
				if (normalizedModel.endsWith("-codex")) {
					return model.slice(0, -"-codex".length);
				}
				return "gpt-5";
			}
			return "gpt-5";
		};

		const resolveAgentFromLabel = (
			lowercaseLabels: string[],
		): "claude" | "gemini" | "codex" | "cursor" | undefined => {
			if (lowercaseLabels.includes("cursor")) {
				return "cursor";
			}
			if (
				lowercaseLabels.includes("codex") ||
				lowercaseLabels.includes("openai")
			) {
				return "codex";
			}
			if (lowercaseLabels.includes("gemini")) {
				return "gemini";
			}
			if (lowercaseLabels.includes("claude")) {
				return "claude";
			}
			return undefined;
		};

		const resolveModelFromLabel = (
			lowercaseLabels: string[],
		): string | undefined => {
			const codexModelLabel = lowercaseLabels.find((label) =>
				/gpt-[a-z0-9.-]*codex$/i.test(label),
			);
			if (codexModelLabel) {
				return codexModelLabel;
			}

			if (
				lowercaseLabels.includes("gemini-2.5-pro") ||
				lowercaseLabels.includes("gemini-2.5")
			) {
				return "gemini-2.5-pro";
			}
			if (lowercaseLabels.includes("gemini-2.5-flash")) {
				return "gemini-2.5-flash";
			}
			if (lowercaseLabels.includes("gemini-2.5-flash-lite")) {
				return "gemini-2.5-flash-lite";
			}
			if (
				lowercaseLabels.includes("gemini-3") ||
				lowercaseLabels.includes("gemini-3-pro") ||
				lowercaseLabels.includes("gemini-3-pro-preview")
			) {
				return "gemini-3-pro-preview";
			}

			if (lowercaseLabels.includes("opus")) return "opus";
			if (lowercaseLabels.includes("sonnet")) return "sonnet";
			if (lowercaseLabels.includes("haiku")) return "haiku";

			return undefined;
		};

		const agentFromDescription = descriptionAgentTagRaw?.toLowerCase();
		const resolvedAgentFromDescription =
			agentFromDescription === "cursor"
				? "cursor"
				: agentFromDescription === "codex" || agentFromDescription === "openai"
					? "codex"
					: agentFromDescription === "gemini"
						? "gemini"
						: agentFromDescription === "claude"
							? "claude"
							: undefined;
		const resolvedAgentFromLabels = resolveAgentFromLabel(normalizedLabels);

		const modelFromDescription = descriptionModelTagRaw;
		const modelFromLabels = resolveModelFromLabel(normalizedLabels);
		const explicitModel = modelFromDescription || modelFromLabels;

		const runnerType: "claude" | "gemini" | "codex" | "cursor" =
			resolvedAgentFromDescription ||
			resolvedAgentFromLabels ||
			inferRunnerFromModel(explicitModel) ||
			this.getDefaultRunner();

		// If an explicit agent conflicts with model's implied runner, keep the agent and reset model.
		const modelRunner = inferRunnerFromModel(explicitModel);
		let modelOverride = explicitModel;
		if (modelOverride && modelRunner && modelRunner !== runnerType) {
			modelOverride = undefined;
		}

		if (!modelOverride) {
			modelOverride = defaultModelByRunner[runnerType];
		}

		let fallbackModelOverride = inferFallbackModel(modelOverride, runnerType);
		if (!fallbackModelOverride) {
			fallbackModelOverride = defaultFallbackByRunner[runnerType];
		}

		return {
			runnerType,
			modelOverride,
			fallbackModelOverride,
		};
	}

	/**
	 * Resolve a tool preset string to an array of tool names.
	 */
	public resolveToolPreset(preset: string | string[]): string[] {
		if (Array.isArray(preset)) {
			return preset;
		}

		switch (preset) {
			case "readOnly":
				return getReadOnlyTools();
			case "safe":
				return getSafeTools();
			case "all":
				return getAllTools();
			case "coordinator":
				return getCoordinatorTools();
			default:
				// If it's a string but not a preset, treat it as a single tool
				return [preset];
		}
	}

	/**
	 * Build allowed tools list with Linear MCP tools automatically included
	 */
	public buildAllowedTools(
		repository: RepositoryConfig,
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		// graphite-orchestrator uses the same tool config as orchestrator
		const effectivePromptType =
			promptType === "graphite-orchestrator" ? "orchestrator" : promptType;
		let baseTools: string[] = [];
		let toolSource = "";

		// Priority order:
		// 1. Repository-specific prompt type configuration
		const promptConfig = effectivePromptType
			? repository.labelPrompts?.[effectivePromptType]
			: undefined;
		// Only access allowedTools if config is object form (not simple string[])
		const promptAllowedTools =
			promptConfig && !Array.isArray(promptConfig)
				? promptConfig.allowedTools
				: undefined;
		if (promptAllowedTools) {
			baseTools = this.resolveToolPreset(promptAllowedTools);
			toolSource = `repository label prompt (${effectivePromptType})`;
		}
		// 2. Global prompt type defaults
		else if (
			effectivePromptType &&
			this.config.promptDefaults?.[effectivePromptType]?.allowedTools
		) {
			baseTools = this.resolveToolPreset(
				this.config.promptDefaults[effectivePromptType].allowedTools,
			);
			toolSource = `global prompt defaults (${effectivePromptType})`;
		}
		// 3. Repository-level allowed tools
		else if (repository.allowedTools) {
			baseTools = repository.allowedTools;
			toolSource = "repository configuration";
		}
		// 4. Global default allowed tools
		else if (this.config.defaultAllowedTools) {
			baseTools = this.config.defaultAllowedTools;
			toolSource = "global defaults";
		}
		// 5. Fall back to safe tools
		else {
			baseTools = getSafeTools();
			toolSource = "safe tools fallback";
		}

		// Linear MCP tools that should always be available
		// See: https://docs.anthropic.com/en/docs/claude-code/iam#tool-specific-permission-rules
		const linearMcpTools = ["mcp__linear", "mcp__cyrus-tools"];

		// Combine and deduplicate
		const allTools = [...new Set([...baseTools, ...linearMcpTools])];

		this.logger.debug(
			`Tool selection for ${repository.name}: ${allTools.length} tools from ${toolSource}`,
		);

		return allTools;
	}

	/**
	 * Build disallowed tools list from repository and global config
	 */
	public buildDisallowedTools(
		repository: RepositoryConfig,
		promptType?:
			| "debugger"
			| "builder"
			| "scoper"
			| "orchestrator"
			| "graphite-orchestrator",
	): string[] {
		// graphite-orchestrator uses the same tool config as orchestrator
		const effectivePromptType =
			promptType === "graphite-orchestrator" ? "orchestrator" : promptType;
		let disallowedTools: string[] = [];
		let toolSource = "";

		// Priority order (same as allowedTools):
		// 1. Repository-specific prompt type configuration
		const promptConfig = effectivePromptType
			? repository.labelPrompts?.[effectivePromptType]
			: undefined;
		// Only access disallowedTools if config is object form (not simple string[])
		const promptDisallowedTools =
			promptConfig && !Array.isArray(promptConfig)
				? promptConfig.disallowedTools
				: undefined;
		if (promptDisallowedTools) {
			disallowedTools = promptDisallowedTools;
			toolSource = `repository label prompt (${effectivePromptType})`;
		}
		// 2. Global prompt type defaults
		else if (
			effectivePromptType &&
			this.config.promptDefaults?.[effectivePromptType]?.disallowedTools
		) {
			disallowedTools =
				this.config.promptDefaults[effectivePromptType].disallowedTools;
			toolSource = `global prompt defaults (${effectivePromptType})`;
		}
		// 3. Repository-level disallowed tools
		else if (repository.disallowedTools) {
			disallowedTools = repository.disallowedTools;
			toolSource = "repository configuration";
		}
		// 4. Global default disallowed tools
		else if (this.config.defaultDisallowedTools) {
			disallowedTools = this.config.defaultDisallowedTools;
			toolSource = "global defaults";
		}
		// 5. No defaults for disallowedTools (as per requirements)
		else {
			disallowedTools = [];
			toolSource = "none (no defaults)";
		}

		if (disallowedTools.length > 0) {
			this.logger.debug(
				`Disallowed tools for ${repository.name}: ${disallowedTools.length} tools from ${toolSource}`,
			);
		}

		return disallowedTools;
	}

	/**
	 * Merge subroutine-level disallowedTools with base disallowedTools
	 * @param session Current agent session
	 * @param baseDisallowedTools Base disallowed tools from repository/global config
	 * @param logContext Context string for logging (e.g., "EdgeWorker", "resumeClaudeSession")
	 * @param procedureAnalyzer ProcedureAnalyzer instance to resolve current subroutine
	 * @returns Merged disallowed tools list
	 */
	public mergeSubroutineDisallowedTools(
		session: CyrusAgentSession,
		baseDisallowedTools: string[],
		logContext: string,
		procedureAnalyzer: ProcedureAnalyzer,
	): string[] {
		const currentSubroutine = procedureAnalyzer.getCurrentSubroutine(session);
		if (currentSubroutine?.disallowedTools) {
			const mergedTools = [
				...new Set([
					...baseDisallowedTools,
					...currentSubroutine.disallowedTools,
				]),
			];
			this.logger.debug(
				`[${logContext}] Merged subroutine-level disallowedTools for ${currentSubroutine.name}:`,
				currentSubroutine.disallowedTools,
			);
			return mergedTools;
		}
		return baseDisallowedTools;
	}
}
