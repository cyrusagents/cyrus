import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { EdgeConfig } from "../config/types.js";
import type { Logger } from "./Logger.js";

/**
 * Service responsible for configuration management
 * Handles loading, saving, and validation of edge configuration
 */
export class ConfigService {
	private configPath: string;

	constructor(
		cyrusHome: string,
		private logger: Logger,
	) {
		this.configPath = resolve(cyrusHome, "config.json");
	}

	/**
	 * Get the configuration file path
	 */
	getConfigPath(): string {
		return this.configPath;
	}

	/**
	 * Load edge configuration from disk
	 */
	load(): EdgeConfig {
		let config: EdgeConfig = { repositories: [] };

		if (existsSync(this.configPath)) {
			try {
				const content = readFileSync(this.configPath, "utf-8");
				config = JSON.parse(content);
			} catch (e) {
				this.logger.error(
					`Failed to load edge config: ${(e as Error).message}`,
				);
			}
		}

		// Strip promptTemplatePath from all repositories to ensure built-in template is used
		if (config.repositories) {
			config.repositories = config.repositories.map(
				(repo: EdgeConfig["repositories"][number]) => {
					const { promptTemplatePath, ...repoWithoutTemplate } = repo;
					if (promptTemplatePath) {
						this.logger.info(
							`Ignoring custom prompt template for repository: ${repo.name} (using built-in template)`,
						);
					}
					return repoWithoutTemplate;
				},
			);
		}

		// Run migrations on loaded config
		config = this.migrateConfig(config);

		return config;
	}

	/**
	 * Run migrations on config to ensure it's up to date
	 * Persists changes to disk if any migrations were applied
	 */
	private migrateConfig(config: EdgeConfig): EdgeConfig {
		let configModified = false;

		// Migration: Rename legacy global model fields to Claude-specific names
		// Keep old values but move them to the new keys and remove deprecated fields.
		if (config.defaultModel !== undefined) {
			if (!config.claudeDefaultModel) {
				config.claudeDefaultModel = config.defaultModel;
				this.logger.info(
					`[Migration] Moved "defaultModel" to "claudeDefaultModel"`,
				);
			}
			delete (config as EdgeConfig & { defaultModel?: string }).defaultModel;
			configModified = true;
		}

		if (config.defaultFallbackModel !== undefined) {
			if (!config.claudeDefaultFallbackModel) {
				config.claudeDefaultFallbackModel = config.defaultFallbackModel;
				this.logger.info(
					`[Migration] Moved "defaultFallbackModel" to "claudeDefaultFallbackModel"`,
				);
			}
			delete (config as EdgeConfig & { defaultFallbackModel?: string })
				.defaultFallbackModel;
			configModified = true;
		}

		// Migration: Add "Skill" to allowedTools arrays that don't have it
		// This enables Claude Skills functionality for existing configurations
		// See: https://code.claude.com/docs/en/skills
		// See: https://platform.claude.com/docs/en/agent-sdk/skills
		if (config.repositories) {
			for (const repo of config.repositories) {
				if (repo.allowedTools && Array.isArray(repo.allowedTools)) {
					if (!repo.allowedTools.includes("Skill")) {
						repo.allowedTools.push("Skill");
						configModified = true;
						this.logger.info(
							`[Migration] Added "Skill" to allowedTools for repository: ${repo.name}`,
						);
					}
				}
			}
		}

		// Persist changes if any migrations were applied
		if (configModified) {
			this.save(config);
			this.logger.info("[Migration] Configuration updated and saved to disk");
		}

		return config;
	}

	/**
	 * Save edge configuration to disk
	 */
	save(config: EdgeConfig): void {
		const configDir = dirname(this.configPath);

		// Ensure the ~/.cyrus directory exists
		if (!existsSync(configDir)) {
			mkdirSync(configDir, { recursive: true });
		}

		writeFileSync(this.configPath, JSON.stringify(config, null, 2));
	}

	/**
	 * Update a specific field in the configuration
	 */
	update(updater: (config: EdgeConfig) => EdgeConfig): void {
		const config = this.load();
		const updated = updater(config);
		this.save(updated);
	}

	/**
	 * Check if configuration exists
	 */
	exists(): boolean {
		return existsSync(this.configPath);
	}
}
