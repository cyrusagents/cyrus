// Translates Cyrus / Claude-style tool patterns into the simpler pattern
// vocabulary that the .cursor/cyrus-permission-check.mjs hook understands.
//
// Cyrus tool patterns look like (Claude SDK conventions):
//   Read(<glob>)           Bash(<cmd>:<args>)
//   Write(<glob>)          mcp__<server>__<tool>
//   Edit(<glob>)           Read | Bash | Edit | Write   (bare tool name)
//
// Cursor hook patterns look like:
//   Read(<glob>)
//   Write(<glob>)
//   Shell(<cmd>) / Shell(<cmd>:<args-glob>)
//   Mcp(<server>:<tool>)
//   Tool(<Name>)

import { type Dirent, readdirSync } from "node:fs";
import { join, parse as pathParse, resolve } from "node:path";

export interface CyrusPermissionsConfig {
	workspace: string;
	allow: string[];
	deny: string[];
	/**
	 * Lookup table the hook helper uses to derive the logical MCP server name
	 * (e.g. "linear") from the `beforeMCPExecution` payload, which only carries
	 * the `command`/`url` of the underlying transport — not the server name.
	 * Without this, server-scoped patterns like `Mcp(linear:*)` cannot match
	 * because we never see "linear" in the payload.
	 */
	mcpServers?: CyrusPermissionsMcpServer[];
}

export interface CyrusPermissionsMcpServer {
	name: string;
	/** stdio: full reconstructed command line `${command} ${args.join(' ')}`. */
	commandLine?: string;
	/** http/sse: the URL string. */
	url?: string;
}

interface ParsedPattern {
	name: string;
	argument: string | null;
}

function parseToolPattern(pattern: string): ParsedPattern | null {
	const trimmed = pattern.trim();
	if (!trimmed) return null;
	const match = trimmed.match(/^([A-Za-z][A-Za-z0-9_]*)(?:\((.*)\))?$/);
	if (!match) return null;
	return {
		name: match[1] || "",
		argument: match[2]?.trim() ?? null,
	};
}

function normalizeShellCommandBase(argument: string | null): string | null {
	if (!argument) return null;
	const firstRule = argument.split(",")[0]?.trim();
	if (!firstRule) return null;
	if (firstRule === "*" || firstRule === "**") return "*";
	const beforeColon = firstRule.split(":")[0]?.trim();
	return beforeColon || null;
}

function normalizeShellArgsGlob(argument: string | null): string | null {
	if (!argument) return null;
	const firstRule = argument.split(",")[0]?.trim();
	if (!firstRule) return null;
	const colonIdx = firstRule.indexOf(":");
	if (colonIdx < 0) return null;
	const args = firstRule.slice(colonIdx + 1).trim();
	return args || null;
}

function mapMcpPattern(pattern: string): string | null {
	const trimmed = pattern.trim();
	if (!trimmed.toLowerCase().startsWith("mcp__")) return null;
	const parts = trimmed.split("__");
	if (parts.length < 2) return null;
	const server = parts[1]?.trim() || "*";
	const tool =
		parts.length >= 3 ? parts.slice(2).join("__").trim() || "*" : "*";
	return `Mcp(${server}:${tool})`;
}

/**
 * Map a single Cyrus/Claude tool pattern into zero or more Cursor hook
 * patterns. Returns an empty array for unrecognized patterns.
 */
function mapToolPatternToHookPatterns(pattern: string): string[] {
	const mcp = mapMcpPattern(pattern);
	if (mcp) return [mcp];

	const parsed = parseToolPattern(pattern);
	if (!parsed) return [];

	const name = parsed.name.toLowerCase();
	const arg = parsed.argument;

	// Bare tool names (no parentheses) mean "allow this tool unrestricted" in
	// Claude SDK semantics. We must emit BOTH the preToolUse gate (`Tool(...)`)
	// AND the path/command-level gate (`Read(**)`, `Write(**)`, `Shell(*)`),
	// otherwise the SDK passes preToolUse but stops the actual file/shell
	// hook because nothing in the allow list matches the path/command.
	if (!arg) {
		if (name === "bash" || name === "shell") {
			return ["Tool(Shell)", "Shell(*)"];
		}
		if (name === "read" || name === "glob" || name === "grep") {
			return ["Tool(Read)", "Read(**)"];
		}
		if (
			name === "edit" ||
			name === "write" ||
			name === "multiedit" ||
			name === "notebookedit" ||
			name === "todowrite"
		) {
			return ["Tool(Write)", "Write(**)"];
		}
		// Pass-through for unrecognized bare names — only the preToolUse gate
		// applies; SDK does not have a path-level hook for these.
		const cap = parsed.name.charAt(0).toUpperCase() + parsed.name.slice(1);
		return [`Tool(${cap})`];
	}

	if (name === "bash" || name === "shell") {
		const base = normalizeShellCommandBase(arg);
		const argsGlob = normalizeShellArgsGlob(arg);
		const out: string[] = [];
		if (base) {
			out.push(`Shell(${base})`);
			if (argsGlob) out.push(`Shell(${base}:${argsGlob})`);
		}
		return out;
	}

	if (name === "read" || name === "glob" || name === "grep") {
		return [`Read(${arg})`];
	}

	if (
		name === "edit" ||
		name === "write" ||
		name === "multiedit" ||
		name === "notebookedit" ||
		name === "todowrite"
	) {
		return [`Write(${arg})`];
	}

	// Unknown — drop silently. Caller can log if needed.
	return [];
}

function isWildcardArg(argument: string | null): boolean {
	if (!argument) return true;
	const trimmed = argument.trim();
	return trimmed.length === 0 || trimmed === "**";
}

function isBroadReadPattern(pattern: string): boolean {
	const parsed = parseToolPattern(pattern);
	if (!parsed) return false;
	const n = parsed.name.toLowerCase();
	if (!(n === "read" || n === "glob" || n === "grep")) return false;
	return isWildcardArg(parsed.argument);
}

function isBroadWritePattern(pattern: string): boolean {
	const parsed = parseToolPattern(pattern);
	if (!parsed) return false;
	const n = parsed.name.toLowerCase();
	if (
		!(
			n === "edit" ||
			n === "write" ||
			n === "multiedit" ||
			n === "notebookedit" ||
			n === "todowrite"
		)
	) {
		return false;
	}
	return isWildcardArg(parsed.argument);
}

function toCursorPath(path: string): string {
	return path.replace(/\\/g, "/");
}

function buildWorkspaceSiblingDenyPatterns(
	workspacePath: string,
	permission: "Read" | "Write",
): string[] {
	const resolvedWorkspacePath = resolve(workspacePath);
	const parsed = pathParse(resolvedWorkspacePath);
	if (!parsed.root) return [];

	const segments = resolvedWorkspacePath
		.slice(parsed.root.length)
		.split(/[\\/]+/)
		.filter(Boolean);
	if (segments.length === 0) return [];

	const denies = new Set<string>();
	let parentPath = parsed.root;

	for (const segment of segments) {
		let entries: Dirent[];
		try {
			entries = readdirSync(parentPath, { withFileTypes: true });
		} catch {
			break;
		}
		for (const sibling of entries) {
			if (!sibling.isDirectory() || sibling.name === segment) continue;
			const siblingPath = join(parentPath, sibling.name);
			denies.add(`${permission}(${toCursorPath(siblingPath)}/**)`);
		}
		parentPath = join(parentPath, segment);
	}
	return [...denies];
}

function buildSystemRootDenyPatterns(
	workspacePath: string,
	permission: "Read" | "Write",
): string[] {
	const workspace = toCursorPath(resolve(workspacePath));
	const rootCandidates = [
		"/etc",
		"/bin",
		"/sbin",
		"/usr",
		"/opt",
		"/System",
		"/Library",
		"/Applications",
		"/dev",
		"/proc",
		"/sys",
		"/Volumes",
		"/home",
	];
	const denies: string[] = [];
	for (const rootPath of rootCandidates) {
		if (workspace === rootPath || workspace.startsWith(`${rootPath}/`))
			continue;
		denies.push(`${permission}(${rootPath}/**)`);
	}
	return denies;
}

/**
 * Auto-deny patterns that protect the host system and worktree siblings
 * whenever a session has broad Read/Write permissions. Mirrors the same
 * scoping the old CLI-based runner applied via .cursor/cli.json.
 */
export function buildAutoDenyPatterns(args: {
	workspace: string;
	allowedTools?: string[];
}): string[] {
	const { workspace, allowedTools = [] } = args;
	if (!workspace) return [];

	const denies = new Set<string>();
	if (allowedTools.some(isBroadReadPattern)) {
		for (const p of buildWorkspaceSiblingDenyPatterns(workspace, "Read"))
			denies.add(p);
		for (const p of buildSystemRootDenyPatterns(workspace, "Read"))
			denies.add(p);
	}
	if (allowedTools.some(isBroadWritePattern)) {
		for (const p of buildWorkspaceSiblingDenyPatterns(workspace, "Write"))
			denies.add(p);
		for (const p of buildSystemRootDenyPatterns(workspace, "Write"))
			denies.add(p);
	}
	return [...denies];
}

/**
 * Build the final permissions config that ships into the worktree
 * alongside the permission-check helper. Returns deduplicated
 * allow/deny pattern lists in Cursor hook syntax.
 */
export function buildCyrusPermissionsConfig(args: {
	workspace: string;
	allowedTools?: string[];
	disallowedTools?: string[];
	mcpServers?: Record<
		string,
		{ command?: string; args?: string[]; url?: string }
	>;
}): CyrusPermissionsConfig {
	const {
		workspace,
		allowedTools = [],
		disallowedTools = [],
		mcpServers: mcpServersIn = {},
	} = args;

	const allow = new Set<string>();
	for (const pattern of allowedTools) {
		for (const mapped of mapToolPatternToHookPatterns(pattern)) {
			allow.add(mapped);
		}
	}

	const deny = new Set<string>();
	for (const pattern of disallowedTools) {
		for (const mapped of mapToolPatternToHookPatterns(pattern)) {
			deny.add(mapped);
		}
	}
	for (const pattern of buildAutoDenyPatterns({ workspace, allowedTools })) {
		deny.add(pattern);
	}

	const mcpServers: CyrusPermissionsMcpServer[] = [];
	for (const [name, server] of Object.entries(mcpServersIn)) {
		if (!server || typeof server !== "object") continue;
		if (typeof server.url === "string" && server.url) {
			mcpServers.push({ name, url: server.url });
		} else if (typeof server.command === "string" && server.command) {
			const argv = Array.isArray(server.args) ? server.args : [];
			const commandLine = [server.command, ...argv].join(" ").trim();
			mcpServers.push({ name, commandLine });
		}
	}

	return {
		workspace: resolve(workspace),
		allow: [...allow],
		deny: [...deny],
		mcpServers,
	};
}
