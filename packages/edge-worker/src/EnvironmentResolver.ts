import { readFileSync } from "node:fs";
import type {
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	SandboxSettings,
	SdkPluginConfig,
} from "cyrus-claude-runner";
import type { EnvironmentConfig, ILogger } from "cyrus-core";
import { resolvePath } from "cyrus-core";

/**
 * Inputs the resolver consumes when computing effective per-session
 * config. These mirror the values that `RunnerConfigBuilder` would
 * otherwise inherit from the repository / global defaults.
 */
export interface EnvironmentResolverBaseInputs {
	systemPrompt?: string;
	allowedTools: string[];
	disallowedTools: string[];
	mcpConfigPath?: string | string[];
	mcpConfig?: Record<string, McpServerConfig>;
	plugins?: SdkPluginConfig[];
	sandboxSettings?: SandboxSettings;
	hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
	settingSources?: ("user" | "project" | "local")[];
	addChromeExtraArg: boolean;
	defaultAllowedDirectories: string[];
	envReadOnlyRepoPaths: string[];
	worktreePath: string;
	/**
	 * Whether the runtime should add the home-directory enumeration to
	 * `disallowedTools`. Defaults to `true` upstream; `false` opts out
	 * of the safety enumeration entirely.
	 */
	restrictHomeDirectoryReads: boolean;
	/**
	 * Whether the runtime's `canUseTool` callback should deny tools
	 * the SDK asks about (i.e., not in `allowedTools`). The default
	 * upstream is `false` (legacy rubber-stamp behavior); env-bound
	 * sessions flip to `true` so a small `allowedTools` is actually
	 * authoritative.
	 */
	strictToolPermissions: boolean;
}

/**
 * Output of resolving an environment against the base inputs. The
 * shape mirrors `EnvironmentResolverBaseInputs` so the caller can
 * destructure and pass each field straight to the runner config.
 */
export interface EnvironmentResolverResult {
	systemPrompt?: string;
	allowedTools: string[];
	disallowedTools: string[];
	mcpConfigPath?: string | string[];
	mcpConfig?: Record<string, McpServerConfig>;
	plugins?: SdkPluginConfig[];
	sandboxSettings?: SandboxSettings;
	hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
	settingSources?: ("user" | "project" | "local")[];
	addChromeExtraArg: boolean;
	allowedDirectories: string[];
	restrictHomeDirectoryReads: boolean;
	strictToolPermissions: boolean;
}

/**
 * Single source of truth for **how** an `EnvironmentConfig` overrides
 * or replaces the base/default per-session config produced by
 * EdgeWorker + RunnerConfigBuilder.
 *
 * Two modes:
 *   - **merge** (default, `env.isolated !== true`): per-field replace
 *     when the env defines a value, otherwise the base value is kept.
 *     Sandbox `filesystem.*` arrays are shallow-merged.
 *   - **isolated** (`env.isolated === true`): the env is the sole
 *     source of truth. Fields the env omits are emptied, not
 *     inherited. Two runtime-safety exceptions are documented in
 *     `EnvironmentConfigSchema.isolated`.
 *
 * Pure class: no IO except the optional `systemPromptPath` file read
 * (failure is logged and swallowed). All inputs are explicit so it is
 * trivially unit-testable without spinning up an EdgeWorker.
 */
export class EnvironmentResolver {
	constructor(private readonly logger: ILogger) {}

	resolve(
		env: EnvironmentConfig | undefined | null,
		base: EnvironmentResolverBaseInputs,
	): EnvironmentResolverResult {
		if (!env) {
			// No env bound — preserve the base config wholesale.
			return {
				systemPrompt: base.systemPrompt,
				allowedTools: base.allowedTools,
				disallowedTools: base.disallowedTools,
				mcpConfigPath: base.mcpConfigPath,
				mcpConfig: base.mcpConfig,
				plugins: base.plugins,
				sandboxSettings: base.sandboxSettings,
				hooks: base.hooks,
				settingSources: base.settingSources,
				addChromeExtraArg: base.addChromeExtraArg,
				allowedDirectories: base.defaultAllowedDirectories,
				restrictHomeDirectoryReads: base.restrictHomeDirectoryReads,
				strictToolPermissions: base.strictToolPermissions,
			};
		}

		const isolated = env.isolated === true;

		const envPrompt = this.resolveEnvSystemPrompt(env);
		const systemPrompt =
			envPrompt ?? (isolated ? undefined : base.systemPrompt);

		const allowedTools =
			env.allowedTools ?? (isolated ? [] : base.allowedTools);
		const disallowedTools =
			env.disallowedTools ?? (isolated ? [] : base.disallowedTools);

		const mcpConfigPath =
			env.mcpConfigPath ?? (isolated ? undefined : base.mcpConfigPath);
		const mcpConfig = isolated ? undefined : base.mcpConfig;

		const plugins = this.resolvePlugins(env, base.plugins, isolated);

		const sandboxSettings = env.sandbox
			? mergeSandboxFilesystem(base.sandboxSettings, env.sandbox)
			: isolated
				? undefined
				: base.sandboxSettings;

		const hooks = isolated ? {} : base.hooks;
		const addChromeExtraArg = isolated ? false : base.addChromeExtraArg;

		const settingSources =
			env.claudeSettingSources ?? (isolated ? [] : base.settingSources);

		const allowedDirectories = isolated
			? Array.from(new Set([base.worktreePath, ...base.envReadOnlyRepoPaths]))
			: base.defaultAllowedDirectories;

		const restrictHomeDirectoryReads =
			env.restrictHomeDirectoryReads ?? base.restrictHomeDirectoryReads;
		// Any env-bound session is strict by default — `allowedTools`
		// becomes authoritative. Envs can opt out explicitly.
		const strictToolPermissions = env.strictToolPermissions ?? true;

		return {
			systemPrompt,
			allowedTools,
			disallowedTools,
			mcpConfigPath,
			mcpConfig,
			plugins,
			sandboxSettings,
			hooks,
			settingSources,
			addChromeExtraArg,
			allowedDirectories,
			restrictHomeDirectoryReads,
			strictToolPermissions,
		};
	}

	/**
	 * Resolve the env's appended system prompt. Inline `systemPrompt`
	 * wins over `systemPromptPath`. File-read errors are logged and
	 * swallowed — a missing prompt file shouldn't block session start.
	 */
	private resolveEnvSystemPrompt(env: EnvironmentConfig): string | undefined {
		if (env.systemPrompt) return env.systemPrompt;
		if (!env.systemPromptPath) return undefined;
		try {
			return readFileSync(resolvePath(env.systemPromptPath), "utf8");
		} catch (err) {
			this.logger.warn(
				`Failed to read environment systemPromptPath ${env.systemPromptPath}: ${(err as Error).message}`,
			);
			return undefined;
		}
	}

	/**
	 * Compute the effective plugin list: env-declared plugins+skills if
	 * either is present, otherwise the base plugins (or empty when
	 * isolated).
	 */
	private resolvePlugins(
		env: EnvironmentConfig,
		basePlugins: SdkPluginConfig[] | undefined,
		isolated: boolean,
	): SdkPluginConfig[] | undefined {
		if (env.plugins || env.skills?.length) {
			const fromPlugins = (env.plugins ?? []).map((p) => ({
				type: "local" as const,
				path: resolvePath(p.path),
			}));
			const fromSkills = (env.skills ?? []).map((path) => ({
				type: "local" as const,
				path: resolvePath(path),
			}));
			return [...fromPlugins, ...fromSkills];
		}
		return isolated ? [] : basePlugins;
	}
}

/**
 * Returns true when the env opts into full isolation. Helper for code
 * paths that need to check the flag without instantiating a resolver
 * (e.g., `RunnerConfigBuilder.buildSandboxConfig` deciding whether to
 * apply hardcoded filesystem defaults).
 */
export function isEnvironmentIsolated(
	env: EnvironmentConfig | undefined | null,
): boolean {
	return env?.isolated === true;
}

/**
 * Merge an environment's sandbox filesystem overrides into the global
 * sandbox settings. Environment-specified arrays replace the
 * corresponding global arrays; omitted arrays pass through unchanged.
 *
 * Exported for direct use when the resolver is bypassed; also called
 * internally by `EnvironmentResolver.resolve`.
 */
export function mergeSandboxFilesystem(
	base: SandboxSettings | undefined,
	envSandbox: NonNullable<EnvironmentConfig["sandbox"]>,
): SandboxSettings | undefined {
	const baseSettings = (base ?? {}) as SandboxSettings & {
		filesystem?: Record<string, string[] | undefined>;
	};
	const baseFilesystem = baseSettings.filesystem ?? {};
	const envFilesystem = envSandbox.filesystem ?? {};
	const mergedFilesystem = {
		...baseFilesystem,
		...(envFilesystem.allowRead !== undefined && {
			allowRead: envFilesystem.allowRead,
		}),
		...(envFilesystem.denyRead !== undefined && {
			denyRead: envFilesystem.denyRead,
		}),
		...(envFilesystem.allowWrite !== undefined && {
			allowWrite: envFilesystem.allowWrite,
		}),
		...(envFilesystem.denyWrite !== undefined && {
			denyWrite: envFilesystem.denyWrite,
		}),
	};
	return {
		...baseSettings,
		...(envSandbox.enabled !== undefined && { enabled: envSandbox.enabled }),
		filesystem: mergedFilesystem,
	} as SandboxSettings;
}
