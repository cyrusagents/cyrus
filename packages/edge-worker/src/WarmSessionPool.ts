import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type { McpServerConfig, WarmQuery } from "cyrus-claude-runner";
import {
	buildBaseSessionEnv,
	normalizeMcpHttpTransport,
} from "cyrus-claude-runner";
import type {
	AccessPolicyInput,
	ClaudeToolPatterns,
	EdgeWorkerConfig,
	EffectiveAccessPolicy,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";
import {
	getReadParentDirectories,
	nodeDirLister,
	requireLinearWorkspaceId,
} from "cyrus-core";
import type { AgentSessionManager } from "./AgentSessionManager.js";
import type { GitService } from "./GitService.js";
import type { McpConfigService } from "./McpConfigService.js";
import { resolveIssueMcpConfigPath } from "./RunnerConfigBuilder.js";
import type { SkillsPluginResolver } from "./SkillsPluginResolver.js";

/**
 * The slice of AccessPolicy the warm path depends on. Injected so the warm
 * session pool and the cold `ClaudeRunner.start` path call the identical
 * `compute()` + `toClaudeToolPatterns()` (closing the historical warm/cold
 * home-directory-denial drift hole), and so the derivation is mockable in tests.
 */
export interface AccessPolicyPort {
	compute(input: AccessPolicyInput): EffectiveAccessPolicy;
	toClaudeToolPatterns(policy: EffectiveAccessPolicy): ClaudeToolPatterns;
}

export interface WarmSessionPoolDeps {
	agentSessionManager: AgentSessionManager;
	accessPolicy: AccessPolicyPort;
	mcpConfigService: McpConfigService;
	skillsPluginResolver: SkillsPluginResolver;
	gitService: GitService;
	logger: ILogger;
	cyrusHome: string;
	getConfig(): EdgeWorkerConfig;
	getRepositoryForSession(sessionId: string): RepositoryConfig | undefined;
	buildAllowedTools(repository: RepositoryConfig): string[];
	buildDisallowedTools(repository: RepositoryConfig): string[];
}

/**
 * Owns the pool of pre-warmed Claude session subprocesses keyed by agent
 * session ID.
 *
 * On startup {@link warmup} pre-warms the N most-recently-updated Claude
 * sessions so their first query after a restart skips the cold-start cost;
 * {@link acquireWarm} hands a warm query to the first live runner (consuming
 * it); {@link release} reclaims a slot whose session crashed/leaked.
 *
 * `warmup` derives its home-directory read denials via the injected
 * {@link AccessPolicyPort} — the SAME `compute()` + `toClaudeToolPatterns()` the
 * cold `ClaudeRunner.start` path uses — rather than re-deriving them by hand, so
 * a warm-resumed session can never read `~/.ssh` / `~/.aws` that a cold one
 * would deny.
 */
export class WarmSessionPool {
	/** Pre-warmed Claude sessions keyed by agentSessionId. */
	private warmInstances = new Map<string, WarmQuery>();

	constructor(private readonly deps: WarmSessionPoolDeps) {}

	/**
	 * Whether warm sessions are enabled. Disabled by default; opt in with
	 * `CYRUS_ENABLE_WARM_SESSIONS=1` (or `=true`).
	 */
	isEnabled(): boolean {
		const raw = process.env.CYRUS_ENABLE_WARM_SESSIONS;
		if (!raw) return false;
		const v = raw.toLowerCase().trim();
		return v === "1" || v === "true";
	}

	/**
	 * Pre-warm the N most recently updated Claude sessions so the first query
	 * after a CLI restart has near-zero cold-start latency (~20x faster). No-op
	 * when {@link isEnabled} is false.
	 *
	 * Uses `startup()` from `@anthropic-ai/claude-agent-sdk` with
	 * `MCP_CONNECTION_NONBLOCKING=true` so the warm instances are ready in ~500ms
	 * rather than ~4s. Warm instances are consumed by {@link acquireWarm} when the
	 * first message arrives.
	 */
	async warmup(count = 30): Promise<void> {
		if (!this.isEnabled()) return;

		const {
			agentSessionManager,
			accessPolicy,
			mcpConfigService,
			skillsPluginResolver,
			gitService,
			logger,
			cyrusHome,
		} = this.deps;

		const allSessions = agentSessionManager.getAllSessions();

		// Only warm Claude sessions that have a persisted session ID and a workspace path
		const candidates = allSessions
			.filter((s) => s.claudeSessionId && s.workspace?.path)
			.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
			.slice(0, count);

		if (candidates.length === 0) {
			logger.debug("No Claude sessions to pre-warm");
			return;
		}

		logger.info(
			`Pre-warming ${candidates.length} most recent Claude sessions...`,
		);

		const { startup } = await import("@anthropic-ai/claude-agent-sdk");

		// Resolve the skill plugins once — they are global (same for every
		// session), so there is no need to re-resolve per candidate. Without
		// these, warm-resumed sessions get the Skill tool but an empty skill set,
		// leaving them strictly weaker than a cold session (which resolves skills
		// in buildAgentRunnerConfig()).
		const warmPlugins = await skillsPluginResolver.resolve();

		await Promise.all(
			candidates.map(async (session) => {
				try {
					const repo = this.deps.getRepositoryForSession(session.id);
					if (!repo) {
						logger.debug(`No repo for session ${session.id}, skipping warmup`);
						return;
					}

					// Build MCP config for this session (same as the live runner would use)
					const linearWorkspaceId = requireLinearWorkspaceId(repo);
					const mcpConfig = mcpConfigService.buildMcpConfig(
						repo.id,
						linearWorkspaceId,
						session.id,
					);

					// Merge any file-based MCP configs (reuses shared normalization).
					// Warmup paths reconstruct Linear-triggered issue sessions:
					// if the repo has its own `allowedTools` override its
					// mcpConfigPath stays scoped to that repo, otherwise the
					// team-level `linearMcpConfigs` list applies. Same coupling
					// the live `buildIssueConfig` path uses.
					const mcpConfigPath = resolveIssueMcpConfigPath(
						repo,
						this.deps.getConfig().linearMcpConfigs,
						mcpConfigService.buildMergedMcpConfigPath.bind(mcpConfigService),
					);
					let mcpServers: Record<string, McpServerConfig> = { ...mcpConfig };
					if (mcpConfigPath) {
						const paths = Array.isArray(mcpConfigPath)
							? mcpConfigPath
							: [mcpConfigPath];
						for (const filePath of paths) {
							try {
								if (existsSync(filePath)) {
									const fileContent = JSON.parse(
										readFileSync(filePath, "utf8"),
									);
									const servers = fileContent.mcpServers || {};
									normalizeMcpHttpTransport(servers);
									mcpServers = { ...mcpServers, ...servers };
								}
							} catch {
								// Ignore unreadable MCP config files
							}
						}
					}

					const repoConfig = repo as unknown as Record<string, unknown>;
					const model =
						(session.metadata?.model as string | undefined) ||
						(repoConfig.claudeDefaultModel as string | undefined) ||
						(repoConfig.model as string | undefined) ||
						"claude-opus-4-6";

					// Build allowed/disallowed tools — same as what buildAgentRunnerConfig() uses.
					// Without these, startup() inherits the user's defaultMode ("default"),
					// which causes macOS permission prompts for file writes.
					const allowedTools = this.deps.buildAllowedTools(repo);

					// Reconstruct the home-directory Read denials that ClaudeRunner.start()
					// computes at query time. Warm sessions run warmSession.query()
					// directly and never see those query-time options, so without
					// re-deriving them here a resumed session could read ~/.ssh, ~/.aws,
					// etc. Use the SAME AccessPolicy.compute() + toClaudeToolPatterns the
					// cold path (ClaudeRunner.start) uses so warm and cold derive
					// disallowedTools identically — this is the drift-hole fix. Mirror the
					// live allowedDirectories composition so the attachments/repo/git dirs
					// stay readable.
					const workspaceFolderName = basename(session.workspace.path);
					const attachmentsDir = join(
						cyrusHome,
						workspaceFolderName,
						"attachments",
					);
					const allowedDirectories = [
						...new Set([
							attachmentsDir,
							repo.repositoryPath,
							session.workspace.path,
							// Opt-in read-only parent-directory access. Included here so a
							// pre-warmed session derives the SAME home-directory Read
							// denials as the cold path — without it, compute() would deny
							// the parent dir on resume even when fresh sessions allow it.
							...getReadParentDirectories([repo]),
							...gitService.getGitMetadataDirectoriesForWorkspace(
								session.workspace,
							),
						]),
					];
					const { disallowedTools } = accessPolicy.toClaudeToolPatterns(
						accessPolicy.compute({
							homeDir: homedir(),
							dirLister: nodeDirLister,
							cwd: session.workspace.path,
							allowReadDirectories: allowedDirectories,
							toolDisallow: this.deps.buildDisallowedTools(repo),
						}),
					);

					// Skills for this session's repo/worktree — mirrors the live
					// resolveSkillsConfig() path so warm sessions have the same skill
					// set (and skill allow-list) as cold ones.
					const skills = await skillsPluginResolver.discoverSkillNames(
						warmPlugins,
						{
							repositoryId: repo.id,
							repoPaths: [session.workspace.path],
						},
					);

					const warm = await startup({
						options: {
							resume: session.claudeSessionId,
							model,
							cwd: session.workspace.path,
							...(Object.keys(mcpServers).length > 0 && { mcpServers }),
							...(allowedTools.length > 0 && { allowedTools }),
							...(disallowedTools.length > 0 && { disallowedTools }),
							...(warmPlugins.length > 0 && { plugins: warmPlugins }),
							...(skills !== undefined && { skills }),
							settingSources: ["user", "project", "local"],
							// CLAUDE_CODE_SUBPROCESS_ENV_SCRUB is intentionally not set here;
							// see CYPACK-1108 and ClaudeRunner.start() for context.
							env: buildBaseSessionEnv(),
						},
					});

					this.warmInstances.set(session.id, warm);
					logger.info(
						`Pre-warmed session ${session.id} (${session.issueContext?.issueIdentifier ?? "unknown"})`,
					);
				} catch (err) {
					logger.debug(`Failed to pre-warm session ${session.id}:`, err);
				}
			}),
		);

		logger.info(
			`Session pre-warm complete: ${this.warmInstances.size} sessions ready`,
		);
	}

	/**
	 * Consume the warm slot for a session: returns and removes it. Returns
	 * `undefined` when warm sessions are disabled or no slot exists.
	 */
	acquireWarm(sessionId: string): WarmQuery | undefined {
		if (!this.isEnabled()) return undefined;
		const warm = this.warmInstances.get(sessionId);
		if (warm) {
			this.warmInstances.delete(sessionId);
		}
		return warm;
	}

	/**
	 * Reclaim a slot (crash / leak) so a crashed session doesn't leak a warm
	 * instance or hand a stale one to a later resume. Unconditional.
	 */
	release(sessionId: string): void {
		this.warmInstances.delete(sessionId);
	}

	size(): number {
		return this.warmInstances.size;
	}
}
