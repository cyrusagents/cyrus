import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpServerConfig } from "atmiko-core";
import type { CodexConfigOverrides } from "../types.js";

const CODEX_MCP_DOCS_URL = "https://platform.openai.com/docs/docs-mcp";
const CODEX_MCP_APPROVE_MODE = "approve";

interface McpAllowedToolsFilter {
	allowAll: boolean;
	tools: string[];
}

/** Inputs the MCP translator needs from a runner config. */
export interface McpTranslationInput {
	workingDirectory?: string;
	mcpConfigPath?: string | string[];
	mcpConfig?: Record<string, McpServerConfig>;
	allowedTools?: string[];
}

function autoDetectMcpConfigPath(
	workingDirectory?: string,
): string | undefined {
	if (!workingDirectory) {
		return undefined;
	}

	const mcpPath = join(workingDirectory, ".mcp.json");
	if (!existsSync(mcpPath)) {
		return undefined;
	}

	try {
		JSON.parse(readFileSync(mcpPath, "utf8"));
		return mcpPath;
	} catch {
		console.warn(
			`[CodexRunner] Found .mcp.json at ${mcpPath} but it is invalid JSON, skipping`,
		);
		return undefined;
	}
}

function loadMcpConfigFromPaths(
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
			const servers =
				mcpConfig &&
				typeof mcpConfig === "object" &&
				!Array.isArray(mcpConfig) &&
				mcpConfig.mcpServers &&
				typeof mcpConfig.mcpServers === "object" &&
				!Array.isArray(mcpConfig.mcpServers)
					? (mcpConfig.mcpServers as Record<string, McpServerConfig>)
					: {};
			mcpServers = { ...mcpServers, ...servers };
			console.log(
				`[CodexRunner] Loaded MCP config from ${configPath}: ${Object.keys(servers).join(", ")}`,
			);
		} catch (error) {
			console.warn(
				`[CodexRunner] Failed to load MCP config from ${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return mcpServers;
}

function parseMcpAllowedTool(
	toolPattern: string,
): { serverName: string; toolName?: string } | null {
	const trimmed = toolPattern.trim();
	if (!trimmed.startsWith("mcp__")) {
		return null;
	}

	const parts = trimmed.split("__");
	const serverName = parts[1]?.trim();
	if (!serverName) {
		return null;
	}

	if (parts.length === 2) {
		return { serverName };
	}

	const toolName = parts.slice(2).join("__").trim();
	return toolName ? { serverName, toolName } : { serverName };
}

function buildMcpAllowedToolsFilters(
	allowedTools: string[] | undefined,
): Map<string, McpAllowedToolsFilter> {
	const filters = new Map<string, McpAllowedToolsFilter>();
	for (const allowedTool of allowedTools ?? []) {
		const parsed = parseMcpAllowedTool(allowedTool);
		if (!parsed) {
			continue;
		}

		const filter = filters.get(parsed.serverName) ?? {
			allowAll: false,
			tools: [],
		};

		if (!parsed.toolName) {
			filter.allowAll = true;
			filter.tools = [];
		} else if (!filter.allowAll && !filter.tools.includes(parsed.toolName)) {
			filter.tools.push(parsed.toolName);
		}

		filters.set(parsed.serverName, filter);
	}

	return filters;
}

function normalizeMcpServerFilterName(serverName: string): string {
	return serverName.replace(/[-_]+/g, "").toLowerCase();
}

function mergeMcpAllowedToolsFilters(
	filters: McpAllowedToolsFilter[],
): McpAllowedToolsFilter | undefined {
	if (filters.length === 0) {
		return undefined;
	}

	const merged: McpAllowedToolsFilter = {
		allowAll: false,
		tools: [],
	};

	for (const filter of filters) {
		if (filter.allowAll) {
			return { allowAll: true, tools: [] };
		}

		for (const tool of filter.tools) {
			if (!merged.tools.includes(tool)) {
				merged.tools.push(tool);
			}
		}
	}

	return merged;
}

function getMcpAllowedToolsFilter(
	filters: Map<string, McpAllowedToolsFilter>,
	serverName: string,
): McpAllowedToolsFilter | undefined {
	const matchingFilters: McpAllowedToolsFilter[] = [];
	const exact = filters.get(serverName);
	if (exact) {
		matchingFilters.push(exact);
	}

	const normalizedServerName = normalizeMcpServerFilterName(serverName);
	for (const [allowedServerName, filter] of filters.entries()) {
		if (allowedServerName === serverName) {
			continue;
		}
		if (
			normalizeMcpServerFilterName(allowedServerName) === normalizedServerName
		) {
			matchingFilters.push(filter);
		}
	}

	return mergeMcpAllowedToolsFilters(matchingFilters);
}

function applyAtmikoMcpAllowedToolsSemantics(
	mapped: CodexConfigOverrides,
	allowedToolsFilter: McpAllowedToolsFilter,
	options: { hasNativeToolFilter: boolean },
): void {
	const shouldGenerateToolFilter =
		!allowedToolsFilter.allowAll &&
		allowedToolsFilter.tools.length > 0 &&
		!options.hasNativeToolFilter;

	if (shouldGenerateToolFilter) {
		mapped.enabled_tools = allowedToolsFilter.tools;
	}

	// Codex separates tool visibility (`enabled_tools`) from MCP approval. Atmiko
	// allowedTools are already the operator's allow-list, so generated allowances
	// must also be approved for non-interactive Codex exec runs.
	if (!Object.hasOwn(mapped, "default_tools_approval_mode")) {
		mapped.default_tools_approval_mode = CODEX_MCP_APPROVE_MODE;
	}
}

function copyConfigString(
	target: CodexConfigOverrides,
	source: Record<string, unknown>,
	key: string,
): void {
	if (typeof source[key] === "string") {
		target[key] = source[key] as string;
	}
}

function copyConfigNumber(
	target: CodexConfigOverrides,
	source: Record<string, unknown>,
	key: string,
): void {
	if (typeof source[key] === "number") {
		target[key] = source[key] as number;
	}
}

function copyConfigBoolean(
	target: CodexConfigOverrides,
	source: Record<string, unknown>,
	key: string,
): void {
	if (typeof source[key] === "boolean") {
		target[key] = source[key] as boolean;
	}
}

function copyConfigArray(
	target: CodexConfigOverrides,
	source: Record<string, unknown>,
	key: string,
): void {
	if (Array.isArray(source[key])) {
		target[key] = source[
			key
		] as CodexConfigOverrides[keyof CodexConfigOverrides];
	}
}

function copyConfigObject(
	target: CodexConfigOverrides,
	source: Record<string, unknown>,
	sourceKey: string,
	targetKey: string = sourceKey,
): void {
	const value = source[sourceKey];
	if (value && typeof value === "object" && !Array.isArray(value)) {
		target[targetKey] =
			value as CodexConfigOverrides[keyof CodexConfigOverrides];
	}
}

/**
 * Translate Atmiko MCP server configs (file-based + inline) and Atmiko
 * `allowedTools` semantics into Codex-native `mcp_servers` config overrides.
 *
 * Reference: {@link https://platform.openai.com/docs/docs-mcp}
 */
export function buildCodexMcpServersConfig(
	input: McpTranslationInput,
): Record<string, CodexConfigOverrides> | undefined {
	const autoDetectedPath = autoDetectMcpConfigPath(input.workingDirectory);
	const configPaths = autoDetectedPath ? [autoDetectedPath] : ([] as string[]);
	if (input.mcpConfigPath) {
		const explicitPaths = Array.isArray(input.mcpConfigPath)
			? input.mcpConfigPath
			: [input.mcpConfigPath];
		configPaths.push(...explicitPaths);
	}

	const fileBasedServers = loadMcpConfigFromPaths(configPaths);
	const mergedServers = input.mcpConfig
		? { ...fileBasedServers, ...input.mcpConfig }
		: fileBasedServers;
	if (Object.keys(mergedServers).length === 0) {
		return undefined;
	}

	const allowedToolsFilters = buildMcpAllowedToolsFilters(input.allowedTools);

	const codexServers: Record<string, CodexConfigOverrides> = {};
	for (const [serverName, rawConfig] of Object.entries(mergedServers)) {
		const configAny = rawConfig as Record<string, unknown>;
		if (
			typeof configAny.listTools === "function" ||
			typeof configAny.callTool === "function"
		) {
			console.warn(
				`[CodexRunner] Skipping MCP server '${serverName}' because in-process SDK server instances cannot be mapped to codex config`,
			);
			continue;
		}

		const mapped: CodexConfigOverrides = {};
		copyConfigString(mapped, configAny, "command");
		copyConfigArray(mapped, configAny, "args");
		copyConfigObject(mapped, configAny, "env");
		copyConfigArray(mapped, configAny, "env_vars");
		copyConfigString(mapped, configAny, "cwd");
		copyConfigString(mapped, configAny, "experimental_environment");
		copyConfigString(mapped, configAny, "url");
		copyConfigObject(mapped, configAny, "http_headers");
		copyConfigObject(mapped, configAny, "headers", "http_headers");
		copyConfigObject(mapped, configAny, "env_http_headers");
		copyConfigString(mapped, configAny, "bearer_token_env_var");
		copyConfigNumber(mapped, configAny, "timeout");
		copyConfigNumber(mapped, configAny, "startup_timeout_sec");
		copyConfigNumber(mapped, configAny, "tool_timeout_sec");
		copyConfigBoolean(mapped, configAny, "enabled");
		copyConfigBoolean(mapped, configAny, "required");
		copyConfigArray(mapped, configAny, "enabled_tools");
		copyConfigArray(mapped, configAny, "disabled_tools");
		copyConfigString(mapped, configAny, "default_tools_approval_mode");
		copyConfigObject(mapped, configAny, "tools");

		if (!mapped.command && !mapped.url) {
			console.warn(
				`[CodexRunner] Skipping MCP server '${serverName}' because it has no command/url transport`,
			);
			continue;
		}

		const allowedToolsFilter = getMcpAllowedToolsFilter(
			allowedToolsFilters,
			serverName,
		);
		const hasNativeToolFilter =
			Object.hasOwn(mapped, "enabled_tools") ||
			Object.hasOwn(mapped, "disabled_tools");
		if (allowedToolsFilter) {
			applyAtmikoMcpAllowedToolsSemantics(mapped, allowedToolsFilter, {
				hasNativeToolFilter,
			});
		}
		// If the MCP config already contains Codex-native enabled_tools or
		// disabled_tools, keep those exact filters. They are more specific to
		// Codex than Claude-style Atmiko allowedTools entries. A bare
		// `mcp__server` intentionally emits no enabled_tools filter because it
		// means "allow every tool exposed by this configured server".

		codexServers[serverName] = mapped;
	}

	if (Object.keys(codexServers).length === 0) {
		return undefined;
	}

	console.log(
		`[CodexRunner] Configured ${Object.keys(codexServers).length} MCP server(s) for codex config (docs: ${CODEX_MCP_DOCS_URL})`,
	);
	return codexServers;
}
