import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const _base = mkdtempSync(join(tmpdir(), "cyrus-edge-worker-"));

/**
 * Unique per-run temp paths for tests. Uses mkdtempSync so simultaneous
 * test runs from different worktrees or processes use separate directories.
 * Also avoids EACCES on shared /tmp across multiple user accounts.
 */
export const TEST_CYRUS_HOME = join(_base, "cyrus-home");
export const TEST_CYRUS_CHAT = join(_base, "chat");
export const TEST_WORKING_DIR = join(_base, "workspace");

// Deploy bundled skills to TEST_CYRUS_HOME so SkillsPluginResolver can discover them.
// This mirrors what DefaultSkillsDeployer.ensureDeployed() does at runtime.
const __dirname = dirname(fileURLToPath(import.meta.url));
const bundledSkillsPath = join(
	__dirname,
	"..",
	"cyrus-skills-plugin",
	"skills",
);
const deployedPluginPath = join(TEST_CYRUS_HOME, "cyrus-skills-plugin");
const deployedSkillsPath = join(deployedPluginPath, "skills");
const manifestDir = join(deployedPluginPath, ".claude-plugin");

mkdirSync(deployedSkillsPath, { recursive: true });
mkdirSync(manifestDir, { recursive: true });
writeFileSync(
	join(manifestDir, "plugin.json"),
	JSON.stringify(
		{
			name: "cyrus-skills",
			description: "Default Cyrus workflow skills for agent sessions",
		},
		null,
		"\t",
	),
);
cpSync(bundledSkillsPath, deployedSkillsPath, {
	recursive: true,
	dereference: true,
});
