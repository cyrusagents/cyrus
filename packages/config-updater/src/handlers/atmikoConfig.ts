import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type EdgeConfig, getDefaultWorktreesDir } from "atmiko-core";
import {
	type ApiResponse,
	type AtmikoConfigPayload,
	AtmikoConfigPayloadSchema,
} from "../types.js";

/**
 * Handle Atmiko configuration update
 * Updates the ~/.atmiko/config.json file with the provided configuration
 *
 * @param rawPayload - Unvalidated payload from the request
 * @param atmikoHome - Path to the Atmiko home directory
 */
export async function handleAtmikoConfig(
	rawPayload: unknown,
	atmikoHome: string,
): Promise<ApiResponse> {
	try {
		// Validate payload with Zod schema
		const parseResult = AtmikoConfigPayloadSchema.safeParse(rawPayload);

		if (!parseResult.success) {
			const issues = parseResult.error.issues;
			const firstIssue = issues[0];
			const path = firstIssue?.path.join(".") || "unknown";
			const message = firstIssue?.message || "Invalid configuration";

			return {
				success: false,
				error: "Configuration validation failed",
				details: `${path}: ${message}`,
			};
		}

		const payload: AtmikoConfigPayload = parseResult.data;
		const configPath = join(atmikoHome, "config.json");

		// Ensure the .atmiko directory exists
		const configDir = dirname(configPath);
		if (!existsSync(configDir)) {
			mkdirSync(configDir, { recursive: true });
		}

		// Extract operation flags (not part of EdgeConfig)
		const { restartAtmiko, backupConfig, ...edgeConfig } = payload;

		// Process repositories to apply defaults
		const repositories = edgeConfig.repositories.map(
			(repo: AtmikoConfigPayload["repositories"][number]) => {
				return {
					...repo,
					// Set workspaceBaseDir (use provided or default to atmikoHome/worktrees)
					workspaceBaseDir:
						repo.workspaceBaseDir || getDefaultWorktreesDir(atmikoHome),
					// Set isActive (defaults to true)
					isActive: repo.isActive !== false,
					// Ensure teamKeys is always an array
					teamKeys: repo.teamKeys || [],
				};
			},
		);

		// Backwards compatibility: migrate legacy global model keys to Claude-specific keys
		const normalizedEdgeConfig = {
			...edgeConfig,
			claudeDefaultModel:
				edgeConfig.claudeDefaultModel || edgeConfig.defaultModel,
			claudeDefaultFallbackModel:
				edgeConfig.claudeDefaultFallbackModel ||
				edgeConfig.defaultFallbackModel,
		} as EdgeConfig & {
			defaultModel?: string;
			defaultFallbackModel?: string;
		};
		delete normalizedEdgeConfig.defaultModel;
		delete normalizedEdgeConfig.defaultFallbackModel;

		// Build complete config by spreading EdgeConfig fields and overriding repositories
		const config: EdgeConfig = {
			...normalizedEdgeConfig,
			repositories,
		};

		// Backup existing config if requested
		if (backupConfig && existsSync(configPath)) {
			try {
				const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
				const backupPath = join(atmikoHome, `config.backup-${timestamp}.json`);
				const existingConfig = readFileSync(configPath, "utf-8");
				writeFileSync(backupPath, existingConfig, "utf-8");
			} catch (backupError) {
				// Log but don't fail - backup is not critical
				console.warn(
					`Failed to backup config: ${backupError instanceof Error ? backupError.message : String(backupError)}`,
				);
			}
		}

		// Write config file
		try {
			writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

			return {
				success: true,
				message: "Atmiko configuration updated successfully",
				data: {
					configPath,
					repositoriesCount: repositories.length,
					restartAtmiko: restartAtmiko || false,
				},
			};
		} catch (error) {
			return {
				success: false,
				error: "Failed to save configuration file",
				details: `Could not write configuration to ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			};
		}
	} catch (error) {
		return {
			success: false,
			error: "Configuration update failed",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Read current Atmiko configuration
 */
export function readAtmikoConfig(atmikoHome: string): any {
	const configPath = join(atmikoHome, "config.json");

	if (!existsSync(configPath)) {
		return { repositories: [] };
	}

	try {
		const data = readFileSync(configPath, "utf-8");
		return JSON.parse(data);
	} catch {
		return { repositories: [] };
	}
}
