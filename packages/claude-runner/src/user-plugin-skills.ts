import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function userPluginSkillsEnabled(): boolean {
	return process.env.CYRUS_ENABLE_USER_PLUGIN_SKILLS === "1";
}

/**
 * Claude Code owns plugin installation and enablement. Ask it for the
 * effective installations in this workspace instead of reading its cache index.
 * The SDK loads the plugins natively. We only add qualified skill names.
 */
export async function discoverUserPluginSkills(options: {
	cwd?: string;
	configDir?: string;
}): Promise<string[]> {
	const { stdout } = await execFileAsync(
		"claude",
		["plugin", "list", "--json"],
		{
			cwd: options.cwd,
			env: { ...process.env, CLAUDE_CONFIG_DIR: options.configDir },
			timeout: 3000,
			maxBuffer: 1024 * 1024,
		},
	);
	return readUserPluginSkills(JSON.parse(stdout));
}

export async function readUserPluginSkills(
	installed: unknown,
): Promise<string[]> {
	if (!Array.isArray(installed)) {
		throw new Error("Unexpected Claude Code plugin list");
	}
	const skills = await Promise.all(
		installed.map(async (plugin: unknown) => {
			if (!plugin || typeof plugin !== "object") return [];
			if (
				!("scope" in plugin) ||
				plugin.scope !== "user" ||
				!("enabled" in plugin) ||
				plugin.enabled !== true ||
				!("installPath" in plugin) ||
				typeof plugin.installPath !== "string" ||
				!isAbsolute(plugin.installPath) ||
				!("id" in plugin) ||
				typeof plugin.id !== "string"
			) {
				return [];
			}
			const root =
				"readFromFolder" in plugin &&
				typeof plugin.readFromFolder === "string" &&
				isAbsolute(plugin.readFromFolder)
					? plugin.readFromFolder
					: plugin.installPath;
			const name = plugin.id.split("@")[0];
			// These namespaces belong to Cyrus and may contain scoped skills.
			if (
				!name ||
				name.includes(":") ||
				name === "cyrus-skills" ||
				name === "user-skills"
			) {
				return [];
			}

			try {
				const skillsDir = join(root, "skills");
				const entries = await readdir(skillsDir, { withFileTypes: true });
				return (
					await Promise.all(
						entries.map(async (entry) => {
							if (
								entry.name.includes(":") ||
								(!entry.isDirectory() && !entry.isSymbolicLink())
							) {
								return null;
							}
							const file = await stat(
								join(skillsDir, entry.name, "SKILL.md"),
							).catch(() => null);
							return file?.isFile() ? `${name}:${entry.name}` : null;
						}),
					)
				).filter((skill): skill is string => skill !== null);
			} catch {
				return [];
			}
		}),
	);
	return [...new Set(skills.flat())].sort();
}
