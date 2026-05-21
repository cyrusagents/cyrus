import type {
	PluginHookEvent,
	RunnerSandbox,
	RuntimePlugin,
} from "../../types.js";
import { renderSkillMd } from "../skill-md.js";

export interface CursorMaterializeResult {
	/** True when at least one MCP server was declared — caller should pass `--approve-mcps` to cursor-agent. */
	hasMcpServers: boolean;
	filesWritten: string[];
}

/**
 * Map Claude-style hook event names to Cursor-style names.
 * Cursor uses lowerCamelCase and has a different set; events without
 * a clean translation are silently dropped.
 */
const CURSOR_HOOK_EVENT_MAP: Partial<Record<PluginHookEvent, string>> = {
	PreToolUse: "preToolUse",
	PostToolUse: "afterFileEdit", // closest Cursor analog
	Stop: "stop",
	UserPromptSubmit: "beforeSubmitPrompt",
	// SessionStart: no Cursor equivalent — dropped.
};

/**
 * Materialize a RuntimePlugin into Cursor's workspace-level config tree
 * at `<workspaceRoot>/.cursor/`:
 *
 *   <workspaceRoot>/.cursor/mcp.json                  (when mcpServers)
 *   <workspaceRoot>/.cursor/hooks.json                (when hooks)
 *   <workspaceRoot>/.cursor/skills/<name>/SKILL.md    (per skill)
 *
 * Caller adds `--approve-mcps` to the cursor-agent invocation when
 * `hasMcpServers` is true so headless runs don't silently skip
 * unapproved servers.
 *
 * If multiple plugins materialize into the same workspace, the
 * materializer merges into the existing files (last-wins per key).
 */
export async function materializePluginForCursor(
	plugin: RuntimePlugin,
	sandbox: RunnerSandbox,
	workspaceRoot: string,
): Promise<CursorMaterializeResult> {
	const cursorDir = joinPath(workspaceRoot, ".cursor");
	await sandbox.filesystem.mkdir(cursorDir);
	const filesWritten: string[] = [];

	let hasMcpServers = false;
	if (plugin.mcpServers && Object.keys(plugin.mcpServers).length > 0) {
		hasMcpServers = true;
		const mcpPath = joinPath(cursorDir, "mcp.json");
		// Merge into any existing mcp.json so multiple plugins don't trample.
		const existing = await tryReadJson(sandbox, mcpPath);
		const merged = {
			mcpServers: {
				...(existing?.mcpServers ?? {}),
				...plugin.mcpServers,
			},
		};
		await sandbox.filesystem.writeFile(
			mcpPath,
			JSON.stringify(merged, null, 2),
		);
		filesWritten.push(mcpPath);
	}

	if (plugin.hooks && plugin.hooks.length > 0) {
		const hooksPath = joinPath(cursorDir, "hooks.json");
		const existing = await tryReadJson(sandbox, hooksPath);
		const existingHooks = (existing?.hooks ?? {}) as Record<
			string,
			Array<Record<string, unknown>>
		>;
		for (const hook of plugin.hooks) {
			const cursorEvent = CURSOR_HOOK_EVENT_MAP[hook.event];
			if (!cursorEvent) continue;
			const entry: Record<string, unknown> = {
				command: hook.command,
				failClosed: hook.failClosed ?? false,
			};
			if (!existingHooks[cursorEvent]) existingHooks[cursorEvent] = [];
			existingHooks[cursorEvent]!.push(entry);
		}
		await sandbox.filesystem.writeFile(
			hooksPath,
			JSON.stringify({ version: 1, hooks: existingHooks }, null, 2),
		);
		filesWritten.push(hooksPath);
	}

	if (plugin.skills && plugin.skills.length > 0) {
		await sandbox.filesystem.mkdir(joinPath(cursorDir, "skills"));
		for (const skill of plugin.skills) {
			const skillDir = joinPath(cursorDir, "skills", skill.name);
			await sandbox.filesystem.mkdir(skillDir);
			const skillPath = joinPath(skillDir, "SKILL.md");
			await sandbox.filesystem.writeFile(skillPath, renderSkillMd(skill));
			filesWritten.push(skillPath);
			for (const asset of skill.assets ?? []) {
				const assetPath = joinPath(skillDir, asset.path);
				const assetDir = dirnameOf(assetPath);
				if (assetDir) await sandbox.filesystem.mkdir(assetDir);
				await sandbox.filesystem.writeFile(assetPath, asset.content);
				filesWritten.push(assetPath);
			}
		}
	}

	return { hasMcpServers, filesWritten };
}

async function tryReadJson(
	sandbox: RunnerSandbox,
	path: string,
): Promise<Record<string, unknown> | undefined> {
	if (!(await sandbox.filesystem.exists(path))) return undefined;
	try {
		return JSON.parse(await sandbox.filesystem.readFile(path)) as Record<
			string,
			unknown
		>;
	} catch {
		return undefined;
	}
}

function joinPath(...parts: string[]): string {
	return parts
		.filter((p) => p !== "")
		.map((p) => p.replace(/\/+$/, ""))
		.join("/")
		.replace(/\/{2,}/g, "/");
}

function dirnameOf(path: string): string | undefined {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : undefined;
}
