import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ApiResponse, ConfigureMcpPayload } from "../types.js";

/**
 * Handle MCP server configuration
 * Writes individual MCP config files to ~/.atmiko/mcp-{slug}.json
 */
export async function handleConfigureMcp(
	payload: ConfigureMcpPayload,
	atmikoHome: string,
): Promise<ApiResponse> {
	try {
		// Validate payload
		if (!payload.mcpServers || typeof payload.mcpServers !== "object") {
			return {
				success: false,
				error: "MCP configuration requires server definitions",
				details:
					"The mcpServers field must be an object containing server configurations.",
			};
		}

		const serverSlugs = Object.keys(payload.mcpServers);
		if (serverSlugs.length === 0) {
			return {
				success: false,
				error: "No MCP servers to configure",
				details: "At least one MCP server configuration must be provided.",
			};
		}

		// Ensure the mcp-configs subdirectory exists
		const mcpConfigsDir = join(atmikoHome, "mcp-configs");
		if (!existsSync(mcpConfigsDir)) {
			mkdirSync(mcpConfigsDir, { recursive: true });
		}

		const mcpFilesWritten: string[] = [];

		// Write each MCP server configuration to its own file
		for (const slug of serverSlugs) {
			const serverConfig = payload.mcpServers[slug];
			const mcpFilePath = join(mcpConfigsDir, `mcp-${slug}.json`);

			// Perform environment variable substitution
			const processedConfig = performEnvSubstitution(serverConfig);

			// Write the config file
			try {
				const configData = {
					mcpServers: {
						[slug]: processedConfig,
					},
				};

				writeFileSync(
					mcpFilePath,
					JSON.stringify(configData, null, 2),
					"utf-8",
				);

				mcpFilesWritten.push(mcpFilePath);
			} catch (error) {
				return {
					success: false,
					error: `Failed to save MCP server configuration for "${slug}"`,
					details: `Could not write to ${mcpFilePath}: ${error instanceof Error ? error.message : String(error)}`,
				};
			}
		}

		return {
			success: true,
			message: "MCP configuration files written successfully",
			data: {
				mcpFilesWritten,
				serversConfigured: serverSlugs,
			},
		};
	} catch (error) {
		return {
			success: false,
			error: "MCP server configuration failed",
			details: error instanceof Error ? error.message : String(error),
		};
	}
}

/**
 * Perform environment variable substitution on a config object
 * Replaces ${VAR_NAME} placeholders with values from the env map
 */
function performEnvSubstitution(config: any): any {
	if (!config) return config;

	// Get environment variables from the config
	const env = config.env || {};

	// Deep clone the config to avoid mutations
	const processed = JSON.parse(JSON.stringify(config));

	// Recursively process all string values
	function processValue(value: any): any {
		if (typeof value === "string") {
			// Replace ${VAR_NAME} with the actual value from env
			return value.replace(/\$\{([^}]+)\}/g, (match, varName) => {
				return env[varName] || match;
			});
		}

		if (Array.isArray(value)) {
			return value.map(processValue);
		}

		if (typeof value === "object" && value !== null) {
			const result: any = {};
			for (const key of Object.keys(value)) {
				result[key] = processValue(value[key]);
			}
			return result;
		}

		return value;
	}

	return processValue(processed);
}
