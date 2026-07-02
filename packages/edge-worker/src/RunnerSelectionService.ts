import type { EdgeWorkerConfig, RunnerType } from "cyrus-core";

export class RunnerSelectionService {
	private config: EdgeWorkerConfig;

	constructor(config: EdgeWorkerConfig) {
		this.config = config;
	}

	/**
	 * Update the internal config reference (e.g. after hot-reload).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Determine the default runner type.
	 *
	 * Priority:
	 * 1. Explicit `defaultRunner` in config
	 * 2. Auto-detect from available API keys (if exactly one runner has keys)
	 * 3. Fall back to "claude"
	 */
	public getDefaultRunner(): RunnerType {
		if (this.config.defaultRunner) {
			return this.config.defaultRunner;
		}

		// Auto-detect from environment: if exactly one runner's API key is set, use it
		const available: Array<RunnerType> = [];
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
	public getDefaultModelForRunner(runnerType: RunnerType): string {
		if (runnerType === "claude") {
			return (
				this.config.claudeDefaultModel || this.config.defaultModel || "opus"
			);
		}
		if (runnerType === "gemini") {
			return this.config.geminiDefaultModel || "gemini-2.5-pro";
		}
		if (runnerType === "cursor") {
			return this.config.cursorDefaultModel || "composer-2";
		}
		return this.config.codexDefaultModel || "gpt-5.5";
	}

	/**
	 * Resolve default fallback model for a given runner from config with sensible built-in defaults.
	 * Supports legacy Claude fallback key for backwards compatibility.
	 */
	public getDefaultFallbackModelForRunner(runnerType: RunnerType): string {
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
		if (runnerType === "codex") {
			return "gpt-5.2-codex";
		}
		if (runnerType === "cursor") {
			return this.config.cursorDefaultFallbackModel || "composer-2";
		}
		return "gpt-5";
	}

	/**
	 * Detect whether a model name looks like a Codex/GPT model.
	 */
	private isCodexModel(model: string): boolean {
		return (
			/gpt-[a-z0-9.-]*codex$/i.test(model) || /^gpt-[a-z0-9.-]+$/i.test(model)
		);
	}

	/**
	 * Infer which runner a model name implies, if any — e.g. "opus" -> claude,
	 * "gemini-2.5-pro" -> gemini, a GPT/Codex-shaped name -> codex. Returns
	 * undefined when the model name gives no evidence either way (custom /
	 * proxy model names, or an unset model).
	 */
	public inferRunnerFromModel(model?: string): RunnerType | undefined {
		if (!model) return undefined;
		const normalizedModel = model.toLowerCase();
		if (normalizedModel.startsWith("gemini")) return "gemini";
		if (
			normalizedModel === "fable" ||
			normalizedModel === "opus" ||
			normalizedModel === "sonnet" ||
			normalizedModel === "haiku" ||
			normalizedModel.startsWith("claude")
		) {
			return "claude";
		}
		if (this.isCodexModel(normalizedModel)) return "codex";
		return undefined;
	}

	/**
	 * Whether a model name is compatible with a given runner type — i.e. safe
	 * to hand that model string to that runner. Compatible when:
	 * - `inferRunnerFromModel(model)` is undefined (no evidence either way,
	 *   e.g. a custom/proxy model name — assume compatible), OR
	 * - it equals `runnerType` exactly, OR
	 * - the model looks like a Codex/GPT model and `runnerType` is "cursor"
	 *   (Cursor accepts GPT model ids directly — see
	 *   `CursorRunner.normalizeCursorModel` and the `cursorDefaultModel`
	 *   schema docs in `packages/core/src/config-schemas.ts`).
	 */
	public isModelCompatibleWithRunner(
		model: string | undefined,
		runnerType: RunnerType,
	): boolean {
		const inferredRunner = this.inferRunnerFromModel(model);
		if (inferredRunner === undefined) return true;
		if (inferredRunner === runnerType) return true;
		if (inferredRunner === "codex" && runnerType === "cursor") return true;
		return false;
	}

	/**
	 * Infer a sensible fallback (retry) model for a given primary model and
	 * runner type — e.g. "opus" -> "sonnet" for Claude, one tier down for
	 * Gemini, etc. Used both to infer a fallback for an explicit model
	 * override, and (via `RunnerConfigBuilder`) to infer a fallback for the
	 * *resolved* primary model when no explicit override was requested.
	 */
	public inferFallbackModel(
		model: string,
		runnerType: RunnerType,
	): string | undefined {
		const normalizedModel = model.toLowerCase();
		if (runnerType === "claude") {
			if (normalizedModel === "fable") return "opus";
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
		if (this.isCodexModel(normalizedModel)) {
			return "gpt-5.2-codex";
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
		runnerType: RunnerType;
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

		const resolveAgentFromLabel = (
			lowercaseLabels: string[],
		): RunnerType | undefined => {
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
				this.isCodexModel(label),
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

			if (lowercaseLabels.includes("fable")) return "fable";
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

		const runnerType: RunnerType =
			resolvedAgentFromDescription ||
			resolvedAgentFromLabels ||
			this.inferRunnerFromModel(explicitModel) ||
			this.getDefaultRunner();

		// If an explicit agent conflicts with model's implied runner, keep the agent and reset model.
		const modelRunner = this.inferRunnerFromModel(explicitModel);
		let modelOverride = explicitModel;
		if (modelOverride && modelRunner && modelRunner !== runnerType) {
			modelOverride = undefined;
		}

		const fallbackModelOverride = modelOverride
			? this.inferFallbackModel(modelOverride, runnerType)
			: undefined;

		return {
			runnerType,
			modelOverride,
			fallbackModelOverride,
		};
	}
}
