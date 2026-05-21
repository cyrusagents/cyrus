import type { RunnerSandbox, RuntimePlugin } from "../../types.js";
import { renderSkillMd } from "../skill-md.js";

export interface ClaudeMaterializeResult {
	/** Pass this to `claude` as `--plugin-dir <pluginDir>`. */
	pluginDir: string;
	/** Optional: pass this to `claude` as `--mcp-config <mcpConfigPath>`. */
	mcpConfigPath: string | null;
	/** Files written into the sandbox (sandbox-absolute paths). */
	filesWritten: string[];
}

/**
 * Materialize a single RuntimePlugin as a Claude Code plugin under
 * `<pluginsRoot>/<plugin.name>/`. Produces:
 *
 *   <root>/<name>/.claude-plugin/plugin.json
 *   <root>/<name>/.mcp.json                 (when mcpServers present)
 *   <root>/<name>/hooks/hooks.json          (when hooks present)
 *   <root>/<name>/skills/<skillName>/SKILL.md
 *   <root>/<name>/skills/<skillName>/<assetPath>...
 *
 * Caller wires `--plugin-dir <pluginDir>` into the `claude -p ...`
 * invocation.
 */
export async function materializePluginForClaude(
	plugin: RuntimePlugin,
	sandbox: RunnerSandbox,
	pluginsRoot: string,
): Promise<ClaudeMaterializeResult> {
	const pluginDir = joinPath(pluginsRoot, plugin.name);
	const filesWritten: string[] = [];

	const manifest: Record<string, unknown> = { name: plugin.name };
	if (plugin.version) manifest.version = plugin.version;
	if (plugin.description) manifest.description = plugin.description;

	await sandbox.filesystem.mkdir(joinPath(pluginDir, ".claude-plugin"));
	const manifestPath = joinPath(pluginDir, ".claude-plugin/plugin.json");
	await sandbox.filesystem.writeFile(
		manifestPath,
		JSON.stringify(manifest, null, 2),
	);
	filesWritten.push(manifestPath);

	let mcpConfigPath: string | null = null;
	if (plugin.mcpServers && Object.keys(plugin.mcpServers).length > 0) {
		mcpConfigPath = joinPath(pluginDir, ".mcp.json");
		await sandbox.filesystem.writeFile(
			mcpConfigPath,
			JSON.stringify({ mcpServers: plugin.mcpServers }, null, 2),
		);
		filesWritten.push(mcpConfigPath);
	}

	if (plugin.hooks && plugin.hooks.length > 0) {
		// Claude hooks.json shape: { hooks: { Event: [{ matcher, hooks: [{ type, command, timeout }] }] } }
		const grouped: Record<string, Array<Record<string, unknown>>> = {};
		for (const hook of plugin.hooks) {
			const entry: Record<string, unknown> = {
				hooks: [
					{
						type: "command",
						command: hook.command,
						...(hook.timeout ? { timeout: hook.timeout } : {}),
					},
				],
			};
			if (hook.matcher) entry.matcher = hook.matcher;
			if (!grouped[hook.event]) grouped[hook.event] = [];
			grouped[hook.event]!.push(entry);
		}
		const hooksPath = joinPath(pluginDir, "hooks/hooks.json");
		await sandbox.filesystem.mkdir(joinPath(pluginDir, "hooks"));
		await sandbox.filesystem.writeFile(
			hooksPath,
			JSON.stringify({ hooks: grouped }, null, 2),
		);
		filesWritten.push(hooksPath);
	}

	if (plugin.skills && plugin.skills.length > 0) {
		await sandbox.filesystem.mkdir(joinPath(pluginDir, "skills"));
		for (const skill of plugin.skills) {
			const skillDir = joinPath(pluginDir, "skills", skill.name);
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

	return { pluginDir, mcpConfigPath, filesWritten };
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
