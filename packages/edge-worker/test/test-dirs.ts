import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _base = mkdtempSync(join(tmpdir(), "miko-edge-worker-"));

/**
 * Unique per-run temp paths for tests. Uses mkdtempSync so simultaneous
 * test runs from different worktrees or processes use separate directories.
 * Also avoids EACCES on shared /tmp across multiple user accounts.
 */
export const TEST_MIKO_HOME = join(_base, "miko-home");
export const TEST_MIKO_CHAT = join(_base, "chat");
export const TEST_WORKING_DIR = join(_base, "workspace");

// Deploy bundled skills to TEST_MIKO_HOME so SkillsPluginResolver can discover them.
// This mirrors what DefaultSkillsDeployer.ensureDeployed() does at runtime.
const __dirname = dirname(fileURLToPath(import.meta.url));
const bundledSkillsPath = join(__dirname, "..", "miko-skills-plugin", "skills");
const deployedPluginPath = join(TEST_MIKO_HOME, "miko-skills-plugin");
const deployedSkillsPath = join(deployedPluginPath, "skills");
const manifestDir = join(deployedPluginPath, ".claude-plugin");

mkdirSync(deployedSkillsPath, { recursive: true });
mkdirSync(manifestDir, { recursive: true });
writeFileSync(
	join(manifestDir, "plugin.json"),
	JSON.stringify(
		{
			name: "miko-skills",
			description: "Default Miko workflow skills for agent sessions",
		},
		null,
		"\t",
	),
);
cpSync(bundledSkillsPath, deployedSkillsPath, {
	recursive: true,
	dereference: true,
});
