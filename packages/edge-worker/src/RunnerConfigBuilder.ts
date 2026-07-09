import { execSync } from "node:child_process";
import { homedir } from "node:os";
import type {
	ClaudeRunnerConfig,
	HookCallbackMatcher,
	HookEvent,
	McpServerConfig,
	PostToolUseHookInput,
	SandboxSettings,
	SdkPluginConfig,
	StopHookInput,
} from "cyrus-claude-runner";
import type {
	AgentMessage,
	CyrusAgentSession,
	ILogger,
	OnAskUserQuestion,
	RepositoryConfig,
	RunnerType,
} from "cyrus-core";
import { compute, nodeDirLister, toSandboxFilesystem } from "cyrus-core";
import type { CursorRunnerConfig } from "cyrus-cursor-runner";

/**
 * The concrete runner config the builder produces — a Claude or Cursor config.
 * Both extend the neutral `AgentRunnerConfig` base; this union preserves the
 * provider-specific extras without an untyped `& Record<string, unknown>`
 * escape hatch.
 */
export type RunnerConfig = ClaudeRunnerConfig | CursorRunnerConfig;

import { buildIntentToAddHook } from "./hooks/IntentToAddHook.js";
import { buildPrMarkerHook } from "./hooks/PrMarkerHook.js";
import { appendBrowserUseAddendum } from "./prompts/browserUsePromptAddendum.js";
import { appendCloudRuntimeAddendum } from "./prompts/cloudRuntimePromptAddendum.js";
import { appendContextDisciplineAddendum } from "./prompts/contextDisciplinePromptAddendum.js";
import { appendFailureModeAddendum } from "./prompts/failureModePromptAddendum.js";

/**
 * Subset of McpConfigService consumed by RunnerConfigBuilder.
 */
export interface IMcpConfigProvider {
	buildMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId?: string,
	): Record<string, McpServerConfig>;
	buildMergedMcpConfigPath(
		repositories: RepositoryConfig | RepositoryConfig[],
	): string | string[] | undefined;
}

/**
 * Subset of RunnerSelectionService consumed by RunnerConfigBuilder.
 */
export interface IRunnerSelector {
	determineRunnerSelection(
		labels: string[],
		issueDescription?: string,
	): {
		runnerType: RunnerType;
		modelOverride?: string;
		fallbackModelOverride?: string;
	};
	getDefaultModelForRunner(runnerType: RunnerType): string;
	getDefaultFallbackModelForRunner(runnerType: RunnerType): string;
}

/**
 * Input for building an issue session runner config.
 */
export interface IssueRunnerConfigInput {
	session: CyrusAgentSession;
	repository: RepositoryConfig;
	sessionId: string;
	systemPrompt: string | undefined;
	allowedTools: string[];
	allowedDirectories: string[];
	disallowedTools: string[];
	resumeSessionId?: string;
	labels?: string[];
	issueDescription?: string;
	maxTurns?: number;
	/**
	 * Effective context-window size (tokens) at which Claude sessions
	 * auto-compact (`EdgeWorkerConfig.claudeAutoCompactWindow`). Claude runner
	 * only; ignored for Cursor. Undefined preserves the SDK's default
	 * (model-context-sized) auto-compaction behavior.
	 */
	autoCompactWindow?: number;
	/**
	 * Filesystem paths to custom-integration `.mcp.json` files for this
	 * issue session: `EdgeWorkerConfig.linearMcpConfigs` for Linear, or
	 * `githubMcpConfigs` for GitHub. The list is NOT a blanket
	 * override — it's only consulted when the routed repo does NOT have its
	 * own `allowedTools` override. If the repo has its own allow-list set,
	 * the agent uses `repository.mcpConfigPath` instead so the repo's
	 * permission rules and its server set always come from the same scope
	 * (see `buildIssueConfig`).
	 */
	platformMcpConfigOverrides?: readonly string[];
	linearWorkspaceId?: string;
	cyrusHome: string;
	logger: ILogger;
	onMessage: (message: AgentMessage) => void | Promise<void>;
	onError: (error: Error) => void;
	/** Factory to create AskUserQuestion callback (Claude runner only) */
	createAskUserQuestionCallback?: (
		sessionId: string,
		workspaceId: string,
	) => OnAskUserQuestion;
	/** Resolve the Linear workspace ID for a repository */
	requireLinearWorkspaceId: (repo: RepositoryConfig) => string;
	/** Plugins to load for the session (provides skills, hooks, etc.) */
	plugins?: SdkPluginConfig[];
	/**
	 * Allow-list of skill names enabled for the session (after scope filtering),
	 * or `"all"` to enable every discovered skill, or `undefined` to defer to
	 * provider defaults. Claude passes this to the SDK directly.
	 */
	skills?: string[] | "all";
	/** SDK sandbox settings (enabled, network proxy ports) for Claude runner */
	sandboxSettings?: SandboxSettings;
	/** CA cert path for MITM TLS termination — passed via child process env */
	egressCaCertPath?: string;
}

export function resolveIssueMcpConfigPath(
	repository: RepositoryConfig,
	platformMcpConfigOverrides: readonly string[] | undefined,
	buildMergedMcpConfigPath: (
		repositories: RepositoryConfig | RepositoryConfig[],
	) => string | string[] | undefined,
): string | string[] | undefined {
	const repoHasAllowedToolsOverride =
		Array.isArray(repository.allowedTools) &&
		repository.allowedTools.length > 0;
	if (repoHasAllowedToolsOverride) {
		return buildMergedMcpConfigPath(repository);
	}

	if (!platformMcpConfigOverrides || platformMcpConfigOverrides.length === 0) {
		return undefined;
	}

	if (platformMcpConfigOverrides.length === 1) {
		return platformMcpConfigOverrides[0];
	}

	return [...platformMcpConfigOverrides];
}

/**
 * Runner config assembly for issue sessions.
 *
 * Produces AgentRunnerConfig objects for EdgeWorker.buildAgentRunnerConfig()
 * using injected services.
 */
export class RunnerConfigBuilder {
	private mcpConfigProvider: IMcpConfigProvider;
	private runnerSelector: IRunnerSelector;

	constructor(
		mcpConfigProvider: IMcpConfigProvider,
		runnerSelector: IRunnerSelector,
	) {
		this.mcpConfigProvider = mcpConfigProvider;
		this.runnerSelector = runnerSelector;
	}

	/**
	 * Build a runner config for issue sessions (Linear issues, GitHub PRs).
	 *
	 * Issue sessions get full tool sets, model overrides, and hooks.
	 */
	buildIssueConfig(input: IssueRunnerConfigInput): {
		config: RunnerConfig;
		runnerType: RunnerType;
	} {
		const log = input.logger;

		// Configure hooks: PostToolUse for screenshot tools + PR-marker enforcement,
		// plus the Stop hook that blocks the session when work is unshipped.
		const screenshotHooks = this.buildScreenshotHooks(log);
		const prMarkerHook = buildPrMarkerHook(log);
		const intentToAddHook = buildIntentToAddHook(log);
		const stopHook = this.buildStopHook(log);
		const hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>> = {
			...stopHook,
			PostToolUse: [
				...(screenshotHooks.PostToolUse ?? []),
				...(prMarkerHook.PostToolUse ?? []),
				...(intentToAddHook.PostToolUse ?? []),
			],
		};

		// Determine runner type and model override from selectors.
		const runnerSelection = this.runnerSelector.determineRunnerSelection(
			input.labels || [],
			input.issueDescription,
		);
		let runnerType = runnerSelection.runnerType;
		let modelOverride = runnerSelection.modelOverride;
		let fallbackModelOverride = runnerSelection.fallbackModelOverride;

		// When resuming a session, keep the runner that originally created it —
		// even if the labels/tags now select a different one — so a session never
		// switches harness mid-flight. The runner-specific session id recorded on
		// the session tells us which one to stick with.
		if (input.session.claudeSessionId && runnerType !== "claude") {
			runnerType = "claude";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("claude");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("claude");
		} else if (input.session.cursorSessionId && runnerType !== "cursor") {
			runnerType = "cursor";
			modelOverride = this.runnerSelector.getDefaultModelForRunner("cursor");
			fallbackModelOverride =
				this.runnerSelector.getDefaultFallbackModelForRunner("cursor");
		}

		// Log model override if found
		if (modelOverride) {
			log.debug(`Model override via selector: ${modelOverride}`);
		}

		// Determine final model from selectors, repository override, then runner-specific defaults
		const finalModel =
			modelOverride ||
			input.repository.model ||
			this.runnerSelector.getDefaultModelForRunner(runnerType);

		const resolvedWorkspaceId =
			input.linearWorkspaceId ??
			input.requireLinearWorkspaceId(input.repository);
		const mcpConfig = this.mcpConfigProvider.buildMcpConfig(
			input.repository.id,
			resolvedWorkspaceId,
			input.sessionId,
		);
		// Repo-override vs platform-default resolution for MCP config paths:
		//   - If the routed repo has its own `allowedTools` override, it
		//     also owns its own MCP config — use `repository.mcpConfigPath`
		//     so the repo-scoped allow-list lines up with the repo-scoped
		//     server set. The two travel as a unit.
		//   - Otherwise the repo inherits the platform's allow-list, and
		//     should likewise inherit the platform's MCP config list
		//     (`linearMcpConfigs` / `githubMcpConfigs`).
		// This guarantees the agent's permission rules and the loaded MCP
		// server set always come from the same scope.
		const mcpConfigPath = resolveIssueMcpConfigPath(
			input.repository,
			input.platformMcpConfigOverrides,
			this.mcpConfigProvider.buildMergedMcpConfigPath.bind(
				this.mcpConfigProvider,
			),
		);

		// Multi-repo sessions place each repo in a sibling sub-worktree of the
		// cwd (the workspace container). Register those sub-worktrees as
		// `--add-dir` roots so the runner auto-loads each one's `.claude/skills/`
		// — the cwd-rooted project-skill scan alone would miss them. Single-repo
		// sessions have cwd === the worktree, so there is nothing extra to add.
		const cwd = input.session.workspace.path;
		const additionalDirectories = Object.values(
			input.session.workspace.repoPaths ?? {},
		).filter((p): p is string => typeof p === "string" && p !== cwd);

		// Typed superset: a Claude config plus the optional Cursor-only fields.
		// The cursor-branch assignments below type-check against the
		// Partial<CursorRunnerConfig> half; no untyped escape hatch needed.
		const config: ClaudeRunnerConfig & Partial<CursorRunnerConfig> = {
			workingDirectory: cwd,
			allowedTools: input.allowedTools,
			disallowedTools: input.disallowedTools,
			allowedDirectories: input.allowedDirectories,
			...(additionalDirectories.length > 0 && { additionalDirectories }),
			workspaceName: input.session.issue?.identifier || input.session.issueId,
			cyrusHome: input.cyrusHome,
			mcpConfigPath,
			mcpConfig,
			appendSystemPrompt: appendCloudRuntimeAddendum(
				appendBrowserUseAddendum(
					appendFailureModeAddendum(
						appendContextDisciplineAddendum(input.systemPrompt),
					),
				),
			),
			// Priority order: label override > repository config > global default
			model: finalModel,
			fallbackModel:
				fallbackModelOverride ||
				input.repository.fallbackModel ||
				this.runnerSelector.getDefaultFallbackModelForRunner(runnerType),
			logger: log,
			hooks,
			// Plugins providing managed skills.
			...(this.runnerSupportsManagedSkills(runnerType) &&
				input.plugins?.length && { plugins: input.plugins }),
			// Skill scope allow-list. Claude passes this through to the SDK's
			// `query()` `skills` option.
			...(this.runnerSupportsManagedSkills(runnerType) &&
				input.skills !== undefined && { skills: input.skills }),
			// SDK sandbox settings (Claude runner only):
			// - Merge base settings with per-session filesystem.allowWrite (worktree path)
			// - Pass CA cert path via env for MITM TLS termination
			...(runnerType === "claude" &&
				input.sandboxSettings &&
				this.buildSandboxConfig(input)),
			// AskUserQuestion callback - only for Claude runner
			...(runnerType === "claude" &&
				input.createAskUserQuestionCallback && {
					onAskUserQuestion: input.createAskUserQuestionCallback(
						input.sessionId,
						resolvedWorkspaceId,
					),
				}),
			onMessage: input.onMessage,
			onError: input.onError,
		};

		// Cursor runner uses @cursor/sdk. Pass through the API key, the same
		// sandboxSettings shape Claude consumes (the runner translates it to
		// Cursor's `.cursor/sandbox.json` schema), and the egress CA bundle path
		// for MITM TLS trust in sandboxed children.
		if (runnerType === "cursor") {
			config.cursorApiKey = process.env.CURSOR_API_KEY || undefined;
			if (input.sandboxSettings) {
				config.sandboxSettings = input.sandboxSettings;
			}
			if (input.egressCaCertPath) {
				config.egressCaCertPath = input.egressCaCertPath;
			}
		}

		if (input.resumeSessionId) {
			config.resumeSessionId = input.resumeSessionId;
		}

		if (input.maxTurns !== undefined) {
			config.maxTurns = input.maxTurns;
		}

		// Claude-only: forward the early auto-compaction window. Cursor manages
		// its own context, so this is a no-op there and intentionally not set.
		if (runnerType === "claude" && input.autoCompactWindow !== undefined) {
			config.autoCompactWindow = input.autoCompactWindow;
		}

		return { config, runnerType };
	}

	/**
	 * Build a Stop hook that reminds the agent to commit, push, and open a PR
	 * before ending the session. Blocks the first stop attempt and feeds the
	 * guidance back to the agent via the SDK's native `decision: "block"` +
	 * `reason` mechanism. The `stop_hook_active` flag prevents infinite loops —
	 * once the hook has already fired, the next stop is always allowed through.
	 */
	private buildStopHook(
		log: ILogger,
	): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		return buildStopHook(log);
	}

	private runnerSupportsManagedSkills(runnerType: RunnerType): boolean {
		return runnerType === "claude";
	}

	/**
	 * Build sandbox and env config for a Claude runner session.
	 * Merges base sandbox settings with per-session filesystem restrictions
	 * (worktree as the only writable directory) and passes the CA cert
	 * for MITM TLS termination via additionalEnv instead of process.env.
	 */
	private buildSandboxConfig(
		input: IssueRunnerConfigInput,
	): Partial<Pick<ClaudeRunnerConfig, "sandbox" | "additionalEnv">> {
		const result: Partial<
			Pick<ClaudeRunnerConfig, "sandbox" | "additionalEnv">
		> = {};

		if (input.sandboxSettings) {
			result.sandbox = {
				...input.sandboxSettings,
				// When sandbox is enabled, do not allow commands to run unsandboxed
				allowUnsandboxedCommands: false,
				// Required for Go-based tools (gh, gcloud, terraform) to verify TLS certs
				// when using httpProxyPort with a MITM proxy and custom CA. macOS only —
				// opens access to com.apple.trustd.agent, which is a potential data
				// exfiltration path. See: https://code.claude.com/docs/en/settings#sandbox-settings
				enableWeakerNetworkIsolation: true,
				filesystem: {
					...input.sandboxSettings.filesystem,
					// Derive the OS-sandbox filesystem allow/deny from the SAME
					// AccessPolicy.compute() the cold + warm Claude tool-permission
					// paths use, guaranteeing the sandbox layer and the tool layer
					// agree. "." resolves to the cwd of the primary folder Claude is
					// working in; allowedDirectories contains the attachments dir,
					// repo paths, and git metadata dirs — all of which need OS-level
					// read access alongside the worktree. `denyRead` keeps the literal
					// "~/" token, which bubblewrap / macOS sandbox honor as a true
					// deny+whitelist root. Writes are restricted to the worktree.
					// See: https://code.claude.com/docs/en/settings#sandbox-path-prefixes
					...toSandboxFilesystem(
						compute({
							homeDir: homedir(),
							dirLister: nodeDirLister,
							cwd: input.session.workspace.path,
							allowReadDirectories: input.allowedDirectories,
							writeDirectories: [input.session.workspace.path],
						}),
					),
				},
			};
		}

		if (input.egressCaCertPath) {
			result.additionalEnv = {
				// Node.js (SDK, npm, etc.)
				NODE_EXTRA_CA_CERTS: input.egressCaCertPath,
				// OpenSSL-based tools (general fallback — also covers Ruby)
				SSL_CERT_FILE: input.egressCaCertPath,
				// Git HTTPS operations
				GIT_SSL_CAINFO: input.egressCaCertPath,
				// Python requests/pip
				REQUESTS_CA_BUNDLE: input.egressCaCertPath,
				PIP_CERT: input.egressCaCertPath,
				// curl (when compiled against OpenSSL, not SecureTransport)
				CURL_CA_BUNDLE: input.egressCaCertPath,
				// Rust/Cargo
				CARGO_HTTP_CAINFO: input.egressCaCertPath,
				// AWS CLI / boto3
				AWS_CA_BUNDLE: input.egressCaCertPath,
				// Deno
				DENO_CERT: input.egressCaCertPath,
			};
		}

		return result;
	}

	/**
	 * Build PostToolUse hooks for screenshot/GIF tools that guide Claude
	 * to upload files to Linear using linear_upload_file.
	 */
	private buildScreenshotHooks(
		log: ILogger,
	): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
		return {
			PostToolUse: [
				{
					matcher: "playwright_screenshot",
					hooks: [
						async (input, _toolUseID, { signal: _signal }) => {
							const postToolUseInput = input as PostToolUseHookInput;
							log.debug(
								`Tool ${postToolUseInput.tool_name} completed with response:`,
								postToolUseInput.tool_response,
							);
							const response = postToolUseInput.tool_response as {
								path?: string;
							};
							const filePath = response?.path || "the screenshot file";
							return {
								continue: true,
								additionalContext: `Screenshot taken successfully. To share this screenshot in Linear comments, use the linear_upload_file tool to upload ${filePath}. This will return an asset URL that can be embedded in markdown. You can also use the Read tool to view the screenshot file to analyze the visual content.`,
							};
						},
					],
				},
				{
					matcher: "mcp__chrome-devtools__take_screenshot",
					hooks: [
						async (input, _toolUseID, { signal: _signal }) => {
							const postToolUseInput = input as PostToolUseHookInput;
							// Extract file path from input (the tool saves to filePath parameter)
							const toolInput = postToolUseInput.tool_input as {
								filePath?: string;
							};
							const filePath = toolInput?.filePath || "the screenshot file";
							return {
								continue: true,
								additionalContext: `Screenshot saved. To share this screenshot in Linear comments, use the linear_upload_file tool to upload ${filePath}. This will return an asset URL that can be embedded in markdown.`,
							};
						},
					],
				},
			],
		};
	}
}

/**
 * Build a Stop hook that ensures the agent ships work before ending the
 * session. Inspects the working tree at the session cwd and blocks the first
 * stop attempt when there are uncommitted tracked changes or commits ahead
 * of the upstream branch. The `stop_hook_active` flag prevents infinite
 * loops — once the hook has fired, the next stop is allowed through.
 *
 * Pre-existing untracked files (local scratch files, env files, IDE
 * artifacts outside `.gitignore`) do not trigger the guardrail; new files
 * the agent writes are marked via `IntentToAddHook` so they still appear as
 * a tracked diff and re-trigger the block when forgotten. See CYPACK-1196.
 */
export function buildStopHook(
	log: ILogger,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		Stop: [
			{
				matcher: ".*",
				hooks: [
					async (input) => {
						const stopInput = input as StopHookInput;

						// Prevent infinite loops: if the hook already fired, allow the stop.
						if (stopInput.stop_hook_active) {
							return {};
						}

						const guardrail = inspectGitGuardrail(stopInput.cwd, log);
						if (!guardrail) {
							return {};
						}

						return {
							decision: "block",
							reason: guardrail,
						};
					},
				],
			},
		],
	};
}

/**
 * Inspect the working tree at `cwd` and return a guardrail message if there
 * is unshipped work (uncommitted tracked changes or commits ahead of the
 * upstream). Returns null when the tree is clean, when `cwd` isn't a git
 * repo, or when git is unavailable — in those cases the stop is not blocked.
 *
 * Uses `--untracked-files=no` so that pre-existing untracked files in the
 * customer's worktree (scratch files, local env files, IDE artifacts) do not
 * wedge the session. Files Cyrus creates via Write/Edit are marked with
 * `git add --intent-to-add` by `IntentToAddHook` so they still show as a
 * tracked diff and block the stop when left uncommitted.
 */
export function inspectGitGuardrail(cwd: string, log: ILogger): string | null {
	const runGit = (args: string): string => {
		return execSync(`git ${args}`, {
			cwd,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		}).trim();
	};

	let status: string;
	try {
		status = runGit("status --porcelain --untracked-files=no");
	} catch (err) {
		log.debug(
			`PR guardrail: skipping (cwd is not a git repo or git failed): ${(err as Error).message}`,
		);
		return null;
	}

	const uncommittedFiles = status
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0);
	const hasUncommitted = uncommittedFiles.length > 0;

	let unpushedCount = 0;
	try {
		unpushedCount = parseInt(runGit("rev-list --count @{u}..HEAD"), 10) || 0;
	} catch {
		// No upstream configured — fall back to comparing against origin's default branch.
		try {
			const baseRef = runGit("rev-parse --verify --abbrev-ref origin/HEAD");
			if (baseRef) {
				unpushedCount =
					parseInt(runGit(`rev-list --count ${baseRef}..HEAD`), 10) || 0;
			}
		} catch {
			// Can't determine a base — be conservative and don't block on commits alone.
		}
	}

	if (!hasUncommitted && unpushedCount === 0) {
		return null;
	}

	const parts: string[] = [];
	if (hasUncommitted) {
		parts.push(
			`${uncommittedFiles.length} uncommitted file change${uncommittedFiles.length === 1 ? "" : "s"}`,
		);
	}
	if (unpushedCount > 0) {
		parts.push(
			`${unpushedCount} commit${unpushedCount === 1 ? "" : "s"} not yet on the remote`,
		);
	}

	return (
		`You appear to be ending the session, but the working tree has ${parts.join(" and ")}. ` +
		"Before stopping:\n" +
		"1. Commit any uncommitted changes with a descriptive message.\n" +
		"2. Push the branch to the remote.\n" +
		"3. Create or update a pull request that summarizes the change.\n\n" +
		"If the work is genuinely complete and a PR is not appropriate (for example, a question or research task with no intended code changes), you may stop again — this guardrail only blocks once per session."
	);
}
