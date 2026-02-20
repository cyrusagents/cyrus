import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { watch as chokidarWatch, type FSWatcher } from "chokidar";
import type { EdgeWorkerConfig, ILogger, RepositoryConfig } from "cyrus-core";

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

			if (
				changes.added.length === 0 &&
				changes.modified.length === 0 &&
				changes.removed.length === 0
			) {
				this.logger.info("ℹ️  No repository changes detected");
				return;
			}

			this.logger.info(
				`📊 Repository changes detected: ${changes.added.length} added, ${changes.modified.length} modified, ${changes.removed.length} removed`,
			);

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
				linearWorkspaceSlug:
					parsedConfig.linearWorkspaceSlug || this.config.linearWorkspaceSlug,
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
				// Preserve legacy fields while rolling out new config keys.
				defaultModel: parsedConfig.defaultModel || this.config.defaultModel,
				defaultFallbackModel:
					parsedConfig.defaultFallbackModel || this.config.defaultFallbackModel,
				defaultAllowedTools:
					parsedConfig.defaultAllowedTools || this.config.defaultAllowedTools,
				defaultDisallowedTools:
					parsedConfig.defaultDisallowedTools ||
					this.config.defaultDisallowedTools,
				// Issue update trigger: use parsed value if explicitly set,
				// otherwise keep current or default to true
				issueUpdateTrigger:
					parsedConfig.issueUpdateTrigger ?? this.config.issueUpdateTrigger,
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
	 * Deep equality check for repository configs.
	 */
	private deepEqual(obj1: unknown, obj2: unknown): boolean {
		return JSON.stringify(obj1) === JSON.stringify(obj2);
	}
}
