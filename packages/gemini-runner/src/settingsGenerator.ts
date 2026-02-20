import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpServerConfig } from "cyrus-core";
import type { GeminiMcpServerConfig } from "./types.js";

interface GeminiSettingsPaths {
	geminiDir: string;
	settingsPath: string;
	backupPath: string;
}

function resolveGeminiSettingsPaths(projectRoot?: string): GeminiSettingsPaths {
	const geminiDir = projectRoot
		? join(projectRoot, ".gemini")
		: join(homedir(), ".gemini");
	return {
		geminiDir,
		settingsPath: join(geminiDir, "settings.json"),
		backupPath: join(geminiDir, "settings.json.backup"),
	};
}

/**
 * Gemini settings.json structure
 */
interface GeminiSettings {
	general?: {
		previewFeatures?: boolean;
	};
	model?: {
		maxSessionTurns?: number;
	};
	mcpServers?: Record<string, GeminiMcpServerConfig>;
	allowMCPServers?: string[];
	excludeMCPServers?: string[];
}

/**
 * Options for generating Gemini settings
 */
export interface GeminiSettingsOptions {
	maxSessionTurns?: number;
	mcpServers?: Record<string, GeminiMcpServerConfig>;
	allowMCPServers?: string[];
	excludeMCPServers?: string[];
}

/**
 * Convert McpServerConfig (cyrus-core format) to GeminiMcpServerConfig (Gemini CLI format)
 * Gemini MCP config reference:
 * - https://geminicli.com/docs/cli/tutorials/mcp-setup/#how-to-configure-gemini-cli
 * - https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md
 *
 * Gemini CLI supports three transport types:
 * - stdio: command-based (spawns subprocess)
 * - sse: Server-Sent Events (url-based)
 * - http: Streamable HTTP (httpUrl-based)
 *
 * Claude SDK's McpServerConfig uses `type: "http"` with `url` for HTTP servers.
 * This function maps to Gemini CLI's format which uses `httpUrl` for HTTP transport.
 *
 * @param serverName - Name of the MCP server (for logging)
 * @param config - McpServerConfig from cyrus-core
 * @returns GeminiMcpServerConfig or null if conversion not possible
 */
export function convertToGeminiMcpConfig(
	serverName: string,
	config: McpServerConfig,
): GeminiMcpServerConfig | null {
	const configAny = config as Record<string, unknown>;

	// Detect SDK MCP server instances (in-process servers)
	// These have methods like listTools, callTool, etc. and are not convertible
	// to Gemini CLI's transport-based configuration format
	if (
		typeof configAny.listTools === "function" ||
		typeof configAny.callTool === "function" ||
		typeof configAny.name === "string"
	) {
		console.warn(
			`[GeminiRunner] MCP server "${serverName}" is an SDK server instance (in-process). ` +
				`Gemini CLI only supports external MCP servers with transport configurations. Skipping.`,
		);
		return null;
	}

	const geminiConfig: GeminiMcpServerConfig = {};

	// Determine transport type and configure accordingly
	if (configAny.type === "http" && configAny.url) {
		// Claude SDK HTTP transport -> Gemini HTTP transport (httpUrl)
		geminiConfig.httpUrl = configAny.url as string;
		console.log(
			`[GeminiRunner] MCP server "${serverName}" configured with HTTP transport: ${geminiConfig.httpUrl}`,
		);
	} else if (configAny.url && !configAny.command) {
		// URL without command and not explicitly HTTP -> treat as SSE
		geminiConfig.url = configAny.url as string;
		console.log(
			`[GeminiRunner] MCP server "${serverName}" configured with SSE transport: ${geminiConfig.url}`,
		);
	} else if (configAny.command) {
		// Command-based -> stdio transport
		geminiConfig.command = configAny.command as string;
		console.log(
			`[GeminiRunner] MCP server "${serverName}" configured with stdio transport: ${geminiConfig.command}`,
		);
	} else {
		// No valid transport configuration
		console.warn(
			`[GeminiRunner] MCP server "${serverName}" has no valid transport configuration (need command, url, or httpUrl). Skipping.`,
		);
		return null;
	}

	// Map stdio-specific fields
	if (configAny.args && Array.isArray(configAny.args)) {
		geminiConfig.args = configAny.args as string[];
	}

	if (configAny.cwd && typeof configAny.cwd === "string") {
		geminiConfig.cwd = configAny.cwd;
	}

	// Map HTTP headers (for SSE and HTTP transports)
	if (
		configAny.headers &&
		typeof configAny.headers === "object" &&
		!Array.isArray(configAny.headers)
	) {
		geminiConfig.headers = configAny.headers as Record<string, string>;
	}

	// Map common fields
	if (
		configAny.env &&
		typeof configAny.env === "object" &&
		!Array.isArray(configAny.env)
	) {
		geminiConfig.env = configAny.env as Record<string, string>;
	}

	if (configAny.timeout && typeof configAny.timeout === "number") {
		geminiConfig.timeout = configAny.timeout;
	}

	// Trust MCP servers by default for auto-approval (matches --yolo behavior)
	geminiConfig.trust = true;

	if (configAny.includeTools && Array.isArray(configAny.includeTools)) {
		geminiConfig.includeTools = configAny.includeTools as string[];
	}

	if (configAny.excludeTools && Array.isArray(configAny.excludeTools)) {
		geminiConfig.excludeTools = configAny.excludeTools as string[];
	}

	return geminiConfig;
}

/**
 * Load MCP configuration from file paths
 *
 * @param configPaths - Single path or array of paths to MCP config files
 *
 * @returns Merged MCP server configurations
 */
export function loadMcpConfigFromPaths(
	configPaths: string | string[] | undefined,
): Record<string, McpServerConfig> {
	if (!configPaths) {
		return {};
	}

	const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
	let mcpServers: Record<string, McpServerConfig> = {};

	for (const configPath of paths) {
		try {
			const mcpConfigContent = readFileSync(configPath, "utf8");
			const mcpConfig = JSON.parse(mcpConfigContent);
			const servers = mcpConfig.mcpServers || {};
			mcpServers = { ...mcpServers, ...servers };
			console.log(
				`[GeminiRunner] Loaded MCP config from ${configPath}: ${Object.keys(servers).join(", ")}`,
			);
		} catch (error) {
			console.error(
				`[GeminiRunner] Failed to load MCP config from ${configPath}:`,
				error,
			);
		}
	}

	return mcpServers;
}

/**
 * Auto-detect .mcp.json in working directory
 *
 * @param workingDirectory - Working directory to check
 * @returns Path to .mcp.json if valid, undefined otherwise
 */
export function autoDetectMcpConfig(
	workingDirectory?: string,
): string | undefined {
	if (!workingDirectory) {
		return undefined;
	}

	const mcpJsonPath = join(workingDirectory, ".mcp.json");
	if (existsSync(mcpJsonPath)) {
		try {
			// Validate it's valid JSON
			const content = readFileSync(mcpJsonPath, "utf8");
			JSON.parse(content);
			console.log(`[GeminiRunner] Auto-detected .mcp.json at ${mcpJsonPath}`);
			return mcpJsonPath;
		} catch {
			console.warn(
				`[GeminiRunner] Found .mcp.json at ${mcpJsonPath} but it's not valid JSON, skipping`,
			);
		}
	}
	return undefined;
}

/**
 * Generates settings.json structure with maxSessionTurns and MCP servers
 * Reference: https://github.com/google-gemini/gemini-cli/blob/main/docs/get-started/configuration.md
 *
 * Based on investigation of Gemini CLI source code, maxSessionTurns is a top-level
 * setting under "model", not a per-alias configuration. Aliases can only configure
 * generateContentConfig parameters (temperature, topP, etc).
 */
function generateSettings(options: GeminiSettingsOptions): GeminiSettings {
	const settings: GeminiSettings = {
		general: {
			previewFeatures: true,
		},
	};

	// Add model settings if maxSessionTurns specified
	if (options.maxSessionTurns !== undefined) {
		settings.model = {
			maxSessionTurns: options.maxSessionTurns,
		};
	}

	// Add MCP servers if provided
	if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
		settings.mcpServers = options.mcpServers;
		console.log(
			`[GeminiRunner] Including ${Object.keys(options.mcpServers).length} MCP server(s) in settings.json: ${Object.keys(options.mcpServers).join(", ")}`,
		);
	}

	// Add allowMCPServers whitelist if provided
	if (options.allowMCPServers && options.allowMCPServers.length > 0) {
		settings.allowMCPServers = options.allowMCPServers;
	}

	// Add excludeMCPServers blacklist if provided
	if (options.excludeMCPServers && options.excludeMCPServers.length > 0) {
		settings.excludeMCPServers = options.excludeMCPServers;
	}

	return settings;
}

/**
 * Backup existing settings.json if it exists
 * Returns true if backup was created, false if no file to backup
 */
export function backupGeminiSettings(projectRoot?: string): boolean {
	const { settingsPath, backupPath } = resolveGeminiSettingsPaths(projectRoot);
	if (!existsSync(settingsPath)) {
		return false;
	}

	// Create backup
	copyFileSync(settingsPath, backupPath);
	console.log(`[GeminiRunner] Backed up settings.json to ${backupPath}`);
	return true;
}

/**
 * Restore settings.json from backup
 * Returns true if restored, false if no backup exists
 */
export function restoreGeminiSettings(projectRoot?: string): boolean {
	const { settingsPath, backupPath } = resolveGeminiSettingsPaths(projectRoot);
	if (!existsSync(backupPath)) {
		return false;
	}

	// Restore from backup
	copyFileSync(backupPath, settingsPath);
	unlinkSync(backupPath);
	console.log(`[GeminiRunner] Restored settings.json from backup`);
	return true;
}

/**
 * Delete settings.json (used when no backup existed)
 */
export function deleteGeminiSettings(projectRoot?: string): void {
	const { settingsPath } = resolveGeminiSettingsPaths(projectRoot);
	if (existsSync(settingsPath)) {
		unlinkSync(settingsPath);
		console.log(`[GeminiRunner] Deleted temporary settings.json`);
	}
}

/**
 * Write settings.json with specified options
 * Creates project-local .gemini directory if `projectRoot` is set.
 * Otherwise falls back to ~/.gemini.
 *
 * @param options - Settings options including maxSessionTurns, mcpServers, etc.
 */
export function writeGeminiSettings(
	options: GeminiSettingsOptions,
	projectRoot?: string,
): void {
	const { geminiDir, settingsPath } = resolveGeminiSettingsPaths(projectRoot);

	if (!existsSync(geminiDir)) {
		mkdirSync(geminiDir, { recursive: true });
	}

	// Generate and write settings
	const settings = generateSettings(options);
	writeFileSync(settingsPath, JSON.stringify(settings, null, 2), "utf-8");

	const parts: string[] = [];
	if (options.maxSessionTurns !== undefined) {
		parts.push(`maxSessionTurns=${options.maxSessionTurns}`);
	}
	if (options.mcpServers && Object.keys(options.mcpServers).length > 0) {
		parts.push(`mcpServers=[${Object.keys(options.mcpServers).join(", ")}]`);
	}
	console.log(
		`[GeminiRunner] Wrote settings.json${parts.length > 0 ? ` with ${parts.join(", ")}` : ""}`,
	);
}

/**
 * Setup Gemini settings for a session
 * Returns cleanup function to call when session ends
 *
 * @param options - Settings options including maxSessionTurns, mcpServers, etc.
 */
export function setupGeminiSettings(
	options: GeminiSettingsOptions,
	projectRoot?: string,
): () => void {
	const hadBackup = backupGeminiSettings(projectRoot);

	// Write settings
	writeGeminiSettings(options, projectRoot);

	// Return cleanup function
	return () => {
		if (hadBackup) {
			restoreGeminiSettings(projectRoot);
		} else {
			deleteGeminiSettings(projectRoot);
		}
	};
}
