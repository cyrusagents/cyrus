import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { OpenCodeRunnerConfig } from "./types.js";

export type OpenCodePermissionAction = "ask" | "allow" | "deny";
export type OpenCodePermissionRule =
	| OpenCodePermissionAction
	| Record<string, OpenCodePermissionAction>;

export interface OpenCodeMcpLocalConfig {
	type: "local";
	command: string[];
	environment?: Record<string, string>;
	enabled?: boolean;
}

export interface OpenCodeMcpRemoteConfig {
	type: "remote";
	url: string;
	headers?: Record<string, string>;
	enabled?: boolean;
}

export interface OpenCodeRuntimeConfig extends Record<string, unknown> {
	$schema?: string;
	mcp?: Record<string, OpenCodeMcpLocalConfig | OpenCodeMcpRemoteConfig>;
	permission?: Record<string, OpenCodePermissionRule>;
}

export interface OpenCodeConfigBuildResult {
	config: OpenCodeRuntimeConfig;
	unsupported: string[];
}

interface ParsedPattern {
	name: string;
	argument: string | null;
	original: string;
}

interface CyrusMcpServerConfig {
	type?: string;
	transport?: string;
	command?: string;
	args?: string[];
	env?: Record<string, string>;
	url?: string;
	headers?: Record<string, string>;
}

const ENV_DENY_PATTERNS = ["*.env", "*.env.*"];

function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parseToolPattern(pattern: string): ParsedPattern | null {
	const trimmed = pattern.trim();
	if (!trimmed) return null;

	const mcpPattern = parseMcpPattern(trimmed);
	if (mcpPattern) {
		return { name: "mcp", argument: trimmed, original: trimmed };
	}

	const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/);
	if (!match) return null;
	return {
		name: match[1] || "",
		argument: match[2]?.trim() ?? null,
		original: trimmed,
	};
}

function parseMcpPattern(
	pattern: string,
): { server: string; tool: string | null } | null {
	if (!pattern.toLowerCase().startsWith("mcp__")) return null;
	const parts = pattern.split("__");
	if (parts.length < 2) return null;
	const server = parts[1]?.trim();
	if (!server) return null;
	const tool = parts.length >= 3 ? parts.slice(2).join("__").trim() : null;
	return { server, tool: tool || null };
}

function normalizeMcpToolName(server: string, tool: string | null): string {
	return `${server}_${tool || "*"}`;
}

function normalizeBashRule(argument: string): string[] {
	const rules = argument
		.split(",")
		.map((rule) => rule.trim())
		.filter(Boolean);
	return rules.flatMap((rule) => {
		if (rule === "*" || rule === "**") return ["*"];
		const colonIdx = rule.indexOf(":");
		if (colonIdx < 0) return [rule];
		const command = rule.slice(0, colonIdx).trim();
		const args = rule.slice(colonIdx + 1).trim();
		if (!command) return [];
		return [args ? `${command} ${args}` : command];
	});
}

function addPermissionRule(
	permission: Record<string, OpenCodePermissionRule>,
	tool: string,
	target: string | null,
	action: OpenCodePermissionAction,
): void {
	if (!target) {
		permission[tool] = action;
		return;
	}

	const existing = permission[tool];
	let rules: Record<string, OpenCodePermissionAction>;
	if (isRecord(existing)) {
		rules = existing as Record<string, OpenCodePermissionAction>;
	} else {
		rules = { "*": "deny" };
		permission[tool] = rules;
	}
	rules[target] = action;
}

function addFileToolRule(
	permission: Record<string, OpenCodePermissionRule>,
	tool: string,
	argument: string | null,
	action: OpenCodePermissionAction,
): void {
	const target = argument || "*";
	addPermissionRule(permission, tool, target, action);
}

function addOpenCodePermission(
	permission: Record<string, OpenCodePermissionRule>,
	pattern: string,
	action: OpenCodePermissionAction,
	unsupported: string[],
): void {
	const mcp = parseMcpPattern(pattern.trim());
	if (mcp) {
		addPermissionRule(
			permission,
			normalizeMcpToolName(mcp.server, mcp.tool),
			null,
			action,
		);
		return;
	}

	const parsed = parseToolPattern(pattern);
	if (!parsed) {
		unsupported.push(
			`permission:${pattern}: Unsupported Cyrus tool pattern for OpenCode`,
		);
		return;
	}

	const name = parsed.name.toLowerCase();
	switch (name) {
		case "read":
			addFileToolRule(permission, "read", parsed.argument, action);
			return;
		case "glob":
			addFileToolRule(permission, "glob", parsed.argument, action);
			return;
		case "grep":
			addFileToolRule(permission, "grep", parsed.argument, action);
			return;
		case "edit":
		case "write":
		case "multiedit":
		case "notebookedit":
			addFileToolRule(permission, "edit", parsed.argument, action);
			return;
		case "bash":
		case "shell": {
			if (!parsed.argument) {
				addPermissionRule(permission, "bash", "*", action);
				return;
			}
			const rules = normalizeBashRule(parsed.argument);
			if (rules.length === 0) {
				unsupported.push(
					`permission:${pattern}: Unsupported Cyrus tool pattern for OpenCode`,
				);
				return;
			}
			for (const rule of rules)
				addPermissionRule(permission, "bash", rule, action);
			return;
		}
		case "webfetch":
			addPermissionRule(permission, "webfetch", null, action);
			return;
		case "websearch":
			addPermissionRule(permission, "websearch", null, action);
			return;
		case "task":
		case "taskcreate":
		case "taskupdate":
		case "taskget":
		case "tasklist":
		case "taskoutput":
		case "taskstop":
			addPermissionRule(permission, "task", null, action);
			return;
		case "skill":
			addFileToolRule(permission, "skill", parsed.argument, action);
			return;
		case "todowrite":
			addPermissionRule(permission, "todowrite", null, action);
			return;
		case "askuserquestion":
		case "question":
			addPermissionRule(permission, "question", null, action);
			return;
		default:
			unsupported.push(
				`permission:${pattern}: Unsupported Cyrus tool pattern for OpenCode`,
			);
	}
}

function applySensitiveFileDenies(
	permission: Record<string, OpenCodePermissionRule>,
): void {
	const existing = permission.read;
	if (!isRecord(existing)) return;
	for (const pattern of ENV_DENY_PATTERNS) {
		existing[pattern] = "deny";
	}
	existing["*.env.example"] = "allow";
}

function addExternalDirectoryPermissions(
	permission: Record<string, OpenCodePermissionRule>,
	workingDirectory: string,
	allowedDirectories: string[] | undefined,
): void {
	const workspace = resolve(workingDirectory);
	for (const directory of allowedDirectories ?? []) {
		const resolved = resolve(directory);
		if (resolved === workspace || resolved.startsWith(`${workspace}/`)) {
			continue;
		}
		addPermissionRule(
			permission,
			"external_directory",
			`${resolved}/**`,
			"allow",
		);
	}
}

function mapMcpServer(
	name: string,
	server: CyrusMcpServerConfig,
	unsupported: string[],
): OpenCodeMcpLocalConfig | OpenCodeMcpRemoteConfig | null {
	if (!server || typeof server !== "object") return null;

	if (typeof server.url === "string" && server.url) {
		const transport = server.transport || server.type || "http";
		if (transport === "sse") {
			unsupported.push(
				`mcp:${name}: OpenCode runner supports stdio and streamable HTTP MCP servers, not sse`,
			);
			return null;
		}
		return {
			type: "remote",
			url: server.url,
			...(server.headers ? { headers: server.headers } : {}),
			enabled: true,
		};
	}

	if (typeof server.command === "string" && server.command) {
		return {
			type: "local",
			command: [server.command, ...(server.args ?? [])],
			...(server.env ? { environment: server.env } : {}),
			enabled: true,
		};
	}

	unsupported.push(
		`mcp:${name}: OpenCode runner requires either a command or streamable HTTP url`,
	);
	return null;
}

function loadMcpConfigFromPaths(
	configPaths: string | string[] | undefined,
	unsupported: string[],
): Record<string, CyrusMcpServerConfig> {
	if (!configPaths) return {};
	const paths = Array.isArray(configPaths) ? configPaths : [configPaths];
	let servers: Record<string, CyrusMcpServerConfig> = {};

	for (const configPath of paths) {
		try {
			const parsed = JSON.parse(readFileSync(configPath, "utf8"));
			if (isRecord(parsed.mcpServers)) {
				servers = {
					...servers,
					...(parsed.mcpServers as Record<string, CyrusMcpServerConfig>),
				};
			}
		} catch (error) {
			unsupported.push(
				`mcpConfigPath:${configPath}: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return servers;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return isRecord(value);
}

function deepMergeConfig(
	base: Record<string, unknown>,
	override: Record<string, unknown> | undefined,
): Record<string, unknown> {
	if (!override) return { ...base };
	const merged: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const existing = merged[key];
		if (isPlainObject(existing) && isPlainObject(value)) {
			merged[key] = deepMergeConfig(existing, value);
		} else {
			merged[key] = value;
		}
	}
	return merged;
}

export function buildOpenCodeConfig(
	config: OpenCodeRunnerConfig,
): OpenCodeConfigBuildResult {
	const unsupported: string[] = [];
	const workingDirectory = config.workingDirectory || process.cwd();
	// OpenCode defaults to allowing tools unless permission rules say
	// otherwise. Cyrus sessions must be deny-by-default so hosted/sandboxed
	// runs do not inherit a permissive project or user config unexpectedly.
	const permission: Record<string, OpenCodePermissionRule> = { "*": "deny" };

	for (const pattern of config.allowedTools ?? []) {
		addOpenCodePermission(permission, pattern, "allow", unsupported);
	}
	for (const pattern of config.disallowedTools ?? []) {
		addOpenCodePermission(permission, pattern, "deny", unsupported);
	}
	applySensitiveFileDenies(permission);
	addExternalDirectoryPermissions(
		permission,
		workingDirectory,
		config.allowedDirectories,
	);

	const mcpServers = {
		...loadMcpConfigFromPaths(config.mcpConfigPath, unsupported),
		...((config.mcpConfig ?? {}) as Record<string, CyrusMcpServerConfig>),
	};
	const mcp: Record<string, OpenCodeMcpLocalConfig | OpenCodeMcpRemoteConfig> =
		{};
	for (const [name, server] of Object.entries(mcpServers)) {
		const mapped = mapMcpServer(name, server, unsupported);
		if (mapped) mcp[name] = mapped;
	}

	const userConfig = deepMergeConfig(
		deepMergeConfig({}, config.opencodeGlobalConfig),
		config.opencodeRepositoryConfig,
	) as OpenCodeRuntimeConfig;

	const generatedConfig: OpenCodeRuntimeConfig = {
		$schema: "https://opencode.ai/config.json",
		...(Object.keys(mcp).length > 0 ? { mcp } : {}),
		permission,
	};
	const runtimeConfig = deepMergeConfig(
		userConfig,
		generatedConfig,
	) as OpenCodeRuntimeConfig;
	if (isRecord(userConfig.mcp) || Object.keys(mcp).length > 0) {
		runtimeConfig.mcp = {
			...(isRecord(userConfig.mcp) ? userConfig.mcp : {}),
			...mcp,
		} as Record<string, OpenCodeMcpLocalConfig | OpenCodeMcpRemoteConfig>;
	}
	// Cyrus permissions are safety controls, so they replace user-provided
	// permission config instead of preserving non-conflicting entries.
	runtimeConfig.permission = permission;

	return { config: runtimeConfig, unsupported };
}

function sanitizePathSegment(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}

export function buildOpenCodeStateRoot(config: OpenCodeRunnerConfig): string {
	const workingDirectory = resolve(config.workingDirectory || process.cwd());
	const workspaceName =
		config.workspaceName || sanitizePathSegment(basename(workingDirectory));
	const safeWorkspaceName = sanitizePathSegment(workspaceName) || "workspace";
	return join(config.cyrusHome, "opencode-state", safeWorkspaceName);
}

export function buildOpenCodeRuntimeEnv(
	config: OpenCodeRunnerConfig,
): Record<string, string> {
	const built = buildOpenCodeConfig(config);
	const stateRoot = buildOpenCodeStateRoot(config);
	// OpenCode loads OPENCODE_CONFIG_CONTENT after project config, making this
	// the safest supported place for Cyrus-enforced MCP and permission rules.
	// Keep XDG_DATA_HOME unset so OpenCode can use its CLI-managed auth and
	// provider catalog from the user's data home.
	return {
		OPENCODE_CONFIG_CONTENT: JSON.stringify(built.config),
		OPENCODE_CONFIG_DIR: join(stateRoot, "opencode-config"),
		XDG_STATE_HOME: join(stateRoot, "state"),
		XDG_CACHE_HOME: join(stateRoot, "cache"),
		XDG_CONFIG_HOME: join(stateRoot, "config"),
	};
}

export function hasOpenCodeRuntimeConfig(
	config: OpenCodeRuntimeConfig,
): boolean {
	return Boolean(
		config.permission ||
			(config.mcp && Object.keys(config.mcp).length > 0) ||
			config.$schema,
	);
}

export function ensureOpenCodeStateDirectories(
	env: Record<string, string>,
): void {
	for (const key of [
		"OPENCODE_CONFIG_DIR",
		"XDG_STATE_HOME",
		"XDG_CACHE_HOME",
		"XDG_CONFIG_HOME",
	] as const) {
		const dir = env[key];
		if (!dir || existsSync(dir)) continue;
		// OpenCode imports its global path module before running, so these XDG
		// roots must already exist when the child process starts.
		mkdirSync(dir, { recursive: true });
	}
}
