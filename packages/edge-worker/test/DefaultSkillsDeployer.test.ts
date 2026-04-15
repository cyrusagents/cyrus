import { access, mkdir, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DefaultSkillsDeployer } from "../src/DefaultSkillsDeployer.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUNDLED_SKILLS_DIR = join(
	__dirname,
	"..",
	"cyrus-skills-plugin",
	"skills",
);

function createTestLogger(): ILogger {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		withContext: () => createTestLogger(),
	} as unknown as ILogger;
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("DefaultSkillsDeployer", () => {
	let testHome: string;
	let deployer: DefaultSkillsDeployer;

	beforeEach(async () => {
		testHome = join(
			tmpdir(),
			`cyrus-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(testHome, { recursive: true });
		deployer = new DefaultSkillsDeployer(
			testHome,
			createTestLogger(),
			BUNDLED_SKILLS_DIR,
		);
	});

	afterEach(async () => {
		await rm(testHome, { recursive: true, force: true });
	});

	it("should deploy default skills when plugin directory does not exist", async () => {
		await deployer.ensureDeployed();

		const pluginPath = join(testHome, "cyrus-skills-plugin");
		expect(await exists(pluginPath)).toBe(true);

		// Plugin manifest should exist
		const manifestPath = join(pluginPath, ".claude-plugin", "plugin.json");
		expect(await exists(manifestPath)).toBe(true);

		const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
		expect(manifest.name).toBe("cyrus-skills");

		// Skills directory should exist with skills copied
		const skillsPath = join(pluginPath, "skills");
		expect(await exists(skillsPath)).toBe(true);

		const skillDirs = await readdir(skillsPath, { withFileTypes: true });
		const skillNames = skillDirs
			.filter((e) => e.isDirectory())
			.map((e) => e.name);
		expect(skillNames.length).toBeGreaterThan(0);
		expect(skillNames).toContain("implementation");
		expect(skillNames).toContain("debug");
		expect(skillNames).toContain("verify-and-ship");
	});

	it("should not overwrite existing plugin directory", async () => {
		// Deploy once
		await deployer.ensureDeployed();

		const pluginPath = join(testHome, "cyrus-skills-plugin");
		const skillsPath = join(pluginPath, "skills");

		// Remove a skill to simulate user customization
		const implPath = join(skillsPath, "implementation");
		await rm(implPath, { recursive: true, force: true });

		// Deploy again — should NOT recreate the removed skill
		await deployer.ensureDeployed();

		expect(await exists(implPath)).toBe(false);
	});

	it("should create SKILL.md files in each deployed skill directory", async () => {
		await deployer.ensureDeployed();

		const skillsPath = join(testHome, "cyrus-skills-plugin", "skills");
		const skillDirs = await readdir(skillsPath, { withFileTypes: true });

		for (const entry of skillDirs) {
			if (entry.isDirectory()) {
				const skillMd = join(skillsPath, entry.name, "SKILL.md");
				expect(await exists(skillMd)).toBe(true);
			}
		}
	});
});
