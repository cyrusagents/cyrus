import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { EdgeConfig } from "cyrus-core";
import {
	type ApiResponse,
	type CyrusConfigPayload,
	CyrusConfigPayloadSchema,
} from "../types.js";

/**
 * Handle Cyrus configuration update
 * Updates the ~/.cyrus/config.json file with the provided configuration
 *
 * @param rawPayload - Unvalidated payload from the request
 * @param cyrusHome - Path to the Cyrus home directory
 */
export async function handleCyrusConfig(
	rawPayload: unknown,
	cyrusHome: string,
): Promise<ApiResponse> {
	try {
		// Validate payload with Zod schema
		const parseResult = CyrusConfigPayloadSchema.safeParse(rawPayload);

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

		const payload: CyrusConfigPayload = parseResult.data;
		const configPath = join(cyrusHome, "config.json");

		// Ensure the .cyrus directory exists
		const configDir = dirname(configPath);
		if (!existsSync(configDir)) {
			mkdirSync(configDir, { recursive: true });
		}

		// Extract operation flags (not part of EdgeConfig)
		const { restartCyrus, backupConfig, ...edgeConfig } = payload;

		// Process repositories to apply defaults
		const repositories = edgeConfig.repositories.map(
			(repo: CyrusConfigPayload["repositories"][number]) => {
				return {
					...repo,
					// Set workspaceBaseDir (use provided or default to ~/.cyrus/workspaces)
					workspaceBaseDir:
						repo.workspaceBaseDir || join(cyrusHome, "workspaces"),
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
				const backupPath = join(cyrusHome, `config.backup-${timestamp}.json`);
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
				message: "Cyrus configuration updated successfully",
				data: {
					configPath,
					repositoriesCount: repositories.length,
					restartCyrus: restartCyrus || false,
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
 * Read current Cyrus configuration
 */
export function readCyrusConfig(cyrusHome: string): any {
	const configPath = join(cyrusHome, "config.json");

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
