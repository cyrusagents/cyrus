import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type {
	EdgeConfig,
	EdgeWorkerConfig,
	ILogger,
	RepositoryConfig,
} from "cyrus-core";

// ------------------------------------------------------------------
// Exhaustiveness guard for hot-reload key handling
// ------------------------------------------------------------------

/**
 * Every persisted `EdgeConfig` key that `loadConfigSafely()` explicitly
 * merges from the reloaded file. `detectGlobalConfigChanges()` also watches
 * this same list (minus a small exempt set), so merge and watch can never
 * drift apart again.
 *
 * Hand-maintained config-copy sites silently dropping new EdgeConfigSchema
 * fields has bitten us repeatedly (`slackAllowedTools` & friends in
 * CYHOST-967, `strictMcpConfig` in CYPACK-1478). The
 * `_everyEdgeConfigKeyClassified` check below turns that mistake into a
 * compile error: every top-level EdgeConfig key MUST appear in exactly one
 * of RELOAD_MERGED_KEYS or RELOAD_EXEMPT_KEYS. When you add a field to
 * EdgeConfigSchema, the build breaks here until you either merge it in
 * `loadConfigSafely()` (and list it here) or consciously exempt it.
 */
const RELOAD_MERGED_KEYS = [
	"repositories",
	"ngrokAuthToken",
	"stripeCustomerId",
	"global_setup_script",
	"linearWorkspaces",
	"claudeDefaultModel",
	"claudeDefaultFallbackModel",
	"geminiDefaultModel",
	"codexDefaultModel",
	"cursorDefaultModel",
	"cursorDefaultFallbackModel",
	"opencodeDefaultModel",
	"opencodeDefaultFallbackModel",
	"opencode",
	"inferOpenCodeRunnerFromProviderModel",
	"defaultRunner",
	"promptDefaults",
	"defaultModel",
	"defaultFallbackModel",
	"linearAllowedTools",
	"slackAllowedTools",
	"githubAllowedTools",
	"slackMcpConfigs",
	"linearMcpConfigs",
	"githubMcpConfigs",
	"strictMcpConfig",
	"defaultDisallowedTools",
	"issueUpdateTrigger",
	"slackThreadFollowing",
	"prReviewTrigger",
	"singleSessionPerIssue",
	"userAccessControl",
	"sandbox",
] as const satisfies readonly (keyof EdgeConfig)[];

/**
 * EdgeConfig keys deliberately NOT merged on hot reload — deprecated fields
 * whose replacements are merged instead (`defaultAllowedTools` is folded
 * into `linearAllowedTools` by `migrateEdgeConfig` at startup;
 * `linearWorkspaceSlug` migrated into `linearWorkspaces` entries).
 */
const RELOAD_EXEMPT_KEYS = [
	"linearWorkspaceSlug",
	"defaultAllowedTools",
] as const satisfies readonly (keyof EdgeConfig)[];

/**
 * Keys merged on reload but excluded from `detectGlobalConfigChanges()`:
 * `repositories` has its own add/modify/remove diff pipeline, and the two
 * startup-only credentials are not consumed by any hot-reload listener.
 */
const GLOBAL_WATCH_EXEMPT_KEYS: ReadonlySet<keyof EdgeConfig> = new Set([
	"repositories",
	"ngrokAuthToken",
	"stripeCustomerId",
]);

type ClassifiedReloadKey =
	| (typeof RELOAD_MERGED_KEYS)[number]
	| (typeof RELOAD_EXEMPT_KEYS)[number];
type UnclassifiedReloadKey = Exclude<keyof EdgeConfig, ClassifiedReloadKey>;
/**
 * Compile error on this line = a new EdgeConfigSchema field needs to be
 * classified into RELOAD_MERGED_KEYS (and merged in `loadConfigSafely()`)
 * or RELOAD_EXEMPT_KEYS above.
 */
const _everyEdgeConfigKeyClassified: UnclassifiedReloadKey extends never
	? true
	: {
			"Unclassified EdgeConfig key(s) — see RELOAD_MERGED_KEYS doc": UnclassifiedReloadKey;
		} = true;
void _everyEdgeConfigKeyClassified;

/**
 * Describes the set of repository-level changes detected after a config
 * file reload.  Emitted as the payload of the `configChanged` event.
 */
export interface RepositoryChanges {
	added: RepositoryConfig[];
	modified: RepositoryConfig[];
	removed: RepositoryConfig[];
	/** The fully-merged new config (caller should replace its reference). */
	newConfig: EdgeWorkerConfig;
}

/**
 * Events emitted by ConfigManager.
 */
export interface ConfigManagerEvents {
	configChanged: (changes: RepositoryChanges) => void;
}

/**
 * ConfigManager is responsible for watching, loading, validating, and
 * diffing the EdgeWorker configuration file.  It does **not** perform any
 * repository lifecycle operations (adding / updating / removing session
 * managers, issue trackers, etc.) -- instead it emits a `configChanged`
 * event that the EdgeWorker listens to and acts upon.
 *
 * Usage:
 * ```ts
 * const configManager = new ConfigManager(config, logger, configPath, repositories);
 * configManager.on("configChanged", async (changes) => {
 *   await removeDeletedRepositories(changes.removed);
 *   await updateModifiedRepositories(changes.modified);
 *   await addNewRepositories(changes.added);
 *   this.config = changes.newConfig;
 * });
 * configManager.startConfigWatcher();
 * ```
 */
export class ConfigManager extends EventEmitter {
	private config: EdgeWorkerConfig;
	private readonly logger: ILogger;
	private configPath?: string;
	/** Live reference to EdgeWorker's repository map -- used for diffing. */
	private readonly repositories: Map<string, RepositoryConfig>;
	private configWatcher?: FSWatcher;

	constructor(
		config: EdgeWorkerConfig,
		logger: ILogger,
		configPath: string | undefined,
		repositories: Map<string, RepositoryConfig>,
	) {
		super();
		this.config = config;
		this.logger = logger;
		this.configPath = configPath;
		this.repositories = repositories;
	}

	// ------------------------------------------------------------------
	// Public API
	// ------------------------------------------------------------------

	/**
	 * Start watching the config file for changes.  Each detected change
	 * triggers a reload-and-diff cycle; if repository-level changes are
	 * found a `configChanged` event is emitted.
	 */
	startConfigWatcher(): void {
		if (!this.configPath) {
			this.logger.warn("⚠️  No config path set, skipping config file watcher");
			return;
		}

		this.logger.info(`👀 Watching config file for changes: ${this.configPath}`);

		this.configWatcher = chokidarWatch(this.configPath, {
			persistent: true,
			ignoreInitial: true,
			awaitWriteFinish: {
				stabilityThreshold: 500,
				pollInterval: 100,
			},
		});

		this.configWatcher.on("change", async () => {
			this.logger.info("🔄 Config file changed, reloading...");
			await this.handleConfigChange();
		});

		this.configWatcher.on("error", (error: unknown) => {
			this.logger.error("❌ Config watcher error:", error);
		});
	}

	/**
	 * Stop the config file watcher and release resources.
	 */
	async stop(): Promise<void> {
		if (this.configWatcher) {
			await this.configWatcher.close();
			this.configWatcher = undefined;
			this.logger.info("✅ Config file watcher stopped");
		}
	}

	/**
	 * Return the current (possibly reloaded) config snapshot.
	 */
	getConfig(): EdgeWorkerConfig {
		return this.config;
	}

	/**
	 * Update the internal config reference.  This is useful when the
	 * EdgeWorker needs to push an externally-modified config back into
	 * the ConfigManager (e.g. after applying the changes from a
	 * `configChanged` event).
	 */
	setConfig(config: EdgeWorkerConfig): void {
		this.config = config;
	}

	/**
	 * Update the config file path (e.g. when set after construction).
	 */
	setConfigPath(configPath: string): void {
		this.configPath = configPath;
	}

	// ------------------------------------------------------------------
	// Internal helpers
	// ------------------------------------------------------------------

	/**
	 * Handle a config file change event: load, validate, diff, and emit.
	 */
	private async handleConfigChange(): Promise<void> {
		try {
			const newConfig = await this.loadConfigSafely();
			if (!newConfig) {
				return;
			}

			const changes = this.detectRepositoryChanges(newConfig);

			const hasRepoChanges =
				changes.added.length > 0 ||
				changes.modified.length > 0 ||
				changes.removed.length > 0;

			// Detect non-repository (global) config changes
			const hasGlobalChanges = this.detectGlobalConfigChanges(newConfig);

			if (!hasRepoChanges && !hasGlobalChanges) {
				this.logger.info("ℹ️  No config changes detected");
				return;
			}

			if (hasRepoChanges) {
				this.logger.info(
					`📊 Repository changes detected: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.removed.length} removed`,
				);
			}
			if (hasGlobalChanges) {
				this.logger.info("📊 Global config changes detected");
			}

			// Emit the diff so EdgeWorker can orchestrate the mutations.
			this.emit("configChanged", {
				added: changes.added,
				modified: changes.modified,
				removed: changes.removed,
				newConfig,
			} satisfies RepositoryChanges);
		} catch (error) {
			this.logger.error("❌ Failed to reload configuration:", error);
		}
	}

	/**
	 * Safely load configuration from the file, merging with the current
	 * in-memory config for fields that are not present in the file.
	 */
	private async loadConfigSafely(): Promise<EdgeWorkerConfig | null> {
		try {
			if (!this.configPath) {
				this.logger.error("❌ No config path set");
				return null;
			}

			const configContent = await readFile(this.configPath, "utf-8");
			const parsedConfig = JSON.parse(configContent);

			// Merge with current EdgeWorker config structure
			const newConfig: EdgeWorkerConfig = {
				...this.config,
				repositories: parsedConfig.repositories || [],
				ngrokAuthToken:
					parsedConfig.ngrokAuthToken || this.config.ngrokAuthToken,
				linearWorkspaces:
					parsedConfig.linearWorkspaces || this.config.linearWorkspaces,
				claudeDefaultModel:
					parsedConfig.claudeDefaultModel ||
					parsedConfig.defaultModel ||
					this.config.claudeDefaultModel ||
					this.config.defaultModel,
				claudeDefaultFallbackModel:
					parsedConfig.claudeDefaultFallbackModel ||
					parsedConfig.defaultFallbackModel ||
					this.config.claudeDefaultFallbackModel ||
					this.config.defaultFallbackModel,
				geminiDefaultModel:
					parsedConfig.geminiDefaultModel || this.config.geminiDefaultModel,
				codexDefaultModel:
					parsedConfig.codexDefaultModel || this.config.codexDefaultModel,
				cursorDefaultModel:
					parsedConfig.cursorDefaultModel || this.config.cursorDefaultModel,
				cursorDefaultFallbackModel:
					parsedConfig.cursorDefaultFallbackModel ||
					this.config.cursorDefaultFallbackModel,
				opencodeDefaultModel:
					parsedConfig.opencodeDefaultModel || this.config.opencodeDefaultModel,
				opencodeDefaultFallbackModel:
					parsedConfig.opencodeDefaultFallbackModel ||
					this.config.opencodeDefaultFallbackModel,
				opencode: parsedConfig.opencode ?? this.config.opencode,
				inferOpenCodeRunnerFromProviderModel:
					parsedConfig.inferOpenCodeRunnerFromProviderModel ??
					this.config.inferOpenCodeRunnerFromProviderModel,
				defaultRunner: parsedConfig.defaultRunner || this.config.defaultRunner,
				promptDefaults:
					parsedConfig.promptDefaults || this.config.promptDefaults,
				// Preserve legacy fields while rolling out new config keys.
				defaultModel: parsedConfig.defaultModel || this.config.defaultModel,
				defaultFallbackModel:
					parsedConfig.defaultFallbackModel || this.config.defaultFallbackModel,
				linearAllowedTools:
					parsedConfig.linearAllowedTools || this.config.linearAllowedTools,
				slackAllowedTools:
					parsedConfig.slackAllowedTools || this.config.slackAllowedTools,
				githubAllowedTools:
					parsedConfig.githubAllowedTools || this.config.githubAllowedTools,
				slackMcpConfigs:
					parsedConfig.slackMcpConfigs || this.config.slackMcpConfigs,
				linearMcpConfigs:
					parsedConfig.linearMcpConfigs || this.config.linearMcpConfigs,
				githubMcpConfigs:
					parsedConfig.githubMcpConfigs || this.config.githubMcpConfigs,
				strictMcpConfig:
					parsedConfig.strictMcpConfig ?? this.config.strictMcpConfig,
				defaultDisallowedTools:
					parsedConfig.defaultDisallowedTools ||
					this.config.defaultDisallowedTools,
				// Issue update trigger: use parsed value if explicitly set,
				// otherwise keep current or default to true
				issueUpdateTrigger:
					parsedConfig.issueUpdateTrigger ?? this.config.issueUpdateTrigger,
				// Slack thread following: use parsed value if explicitly set,
				// otherwise keep current or default to true
				slackThreadFollowing:
					parsedConfig.slackThreadFollowing ?? this.config.slackThreadFollowing,
				// PR review trigger: use parsed value if explicitly set,
				// otherwise keep current or default to true
				prReviewTrigger:
					parsedConfig.prReviewTrigger ?? this.config.prReviewTrigger,
				// Single session per issue: use parsed value if explicitly set,
				// otherwise keep current or default to false
				singleSessionPerIssue:
					parsedConfig.singleSessionPerIssue ??
					this.config.singleSessionPerIssue,
				userAccessControl:
					parsedConfig.userAccessControl ?? this.config.userAccessControl,
				stripeCustomerId:
					parsedConfig.stripeCustomerId ?? this.config.stripeCustomerId,
				global_setup_script:
					parsedConfig.global_setup_script ?? this.config.global_setup_script,
				// Sandbox / egress proxy config
				sandbox: parsedConfig.sandbox ?? this.config.sandbox,
			};

			// Basic validation
			if (!Array.isArray(newConfig.repositories)) {
				this.logger.error("❌ Invalid config: repositories must be an array");
				return null;
			}

			// Validate each repository has required fields
			for (const repo of newConfig.repositories) {
				if (
					!repo.id ||
					!repo.name ||
					!repo.repositoryPath ||
					!repo.baseBranch
				) {
					this.logger.error(
						`❌ Invalid repository config: missing required fields (id, name, repositoryPath, baseBranch)`,
						repo,
					);
					return null;
				}
			}

			return newConfig;
		} catch (error) {
			this.logger.error("❌ Failed to load config file:", error);
			return null;
		}
	}

	/**
	 * Detect changes between the current in-memory repository map and
	 * the repositories declared in `newConfig`.
	 */
	private detectRepositoryChanges(newConfig: EdgeWorkerConfig): {
		added: RepositoryConfig[];
		modified: RepositoryConfig[];
		removed: RepositoryConfig[];
	} {
		const currentRepos = new Map(this.repositories);
		const newRepos = new Map<string, RepositoryConfig>(
			newConfig.repositories.map((r: RepositoryConfig) => [r.id, r]),
		);

		const added: RepositoryConfig[] = [];
		const modified: RepositoryConfig[] = [];
		const removed: RepositoryConfig[] = [];

		// Find added and modified repositories
		for (const [id, repo] of newRepos) {
			if (!currentRepos.has(id)) {
				added.push(repo);
			} else {
				const currentRepo = currentRepos.get(id);
				if (currentRepo && !this.deepEqual(currentRepo, repo)) {
					modified.push(repo);
				}
			}
		}

		// Find removed repositories
		for (const [id, repo] of currentRepos) {
			if (!newRepos.has(id)) {
				removed.push(repo);
			}
		}

		return { added, modified, removed };
	}

	/**
	 * Detect changes to non-repository (global) config fields such as
	 * `defaultRunner`, `claudeDefaultModel`, `promptDefaults`, etc.
	 */
	private detectGlobalConfigChanges(newConfig: EdgeWorkerConfig): boolean {
		// Watch everything we merge on reload (single source of truth — see
		// RELOAD_MERGED_KEYS), except the keys with their own pipeline or no
		// hot-reload consumer (GLOBAL_WATCH_EXEMPT_KEYS).
		for (const key of RELOAD_MERGED_KEYS) {
			if (GLOBAL_WATCH_EXEMPT_KEYS.has(key)) {
				continue;
			}
			if (!this.deepEqual(this.config[key], newConfig[key])) {
				return true;
			}
		}
		return false;
	}

	/**
	 * Deep equality check for repository configs.
	 */
	private deepEqual(obj1: unknown, obj2: unknown): boolean {
		return JSON.stringify(obj1) === JSON.stringify(obj2);
	}
}
