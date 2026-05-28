import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsPluginResolver } from "../src/SkillsPluginResolver.js";

function createTestLogger(): ILogger {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		withContext: () => createTestLogger(),
	} as unknown as ILogger;
}

async function writeManifest(cyrusHome: string): Promise<void> {
	const manifestDir = join(cyrusHome, "user-skills-plugin", ".claude-plugin");
	await mkdir(manifestDir, { recursive: true });
	await writeFile(
		join(manifestDir, "plugin.json"),
		JSON.stringify({ name: "user-skills", description: "" }),
		"utf-8",
	);
}

async function writeUserSkill(
	cyrusHome: string,
	name: string,
	scope?: Record<string, string[]>,
): Promise<void> {
	const skillDir = join(cyrusHome, "user-skills-plugin", "skills", name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: test ${name}\n---\n\nbody\n`,
		"utf-8",
	);
	if (scope) {
		await writeFile(
			join(skillDir, "scope.json"),
			JSON.stringify(scope),
			"utf-8",
		);
	}
}

/**
 * Create a repo-local skill at `<repoPath>/.claude/skills/<name>`. Optionally
 * also write a `scope.json` to prove it is ignored for repo-local skills.
 */
async function writeRepoSkill(
	repoPath: string,
	name: string,
	scope?: Record<string, string[]>,
): Promise<void> {
	const skillDir = join(repoPath, ".claude", "skills", name);
	await mkdir(skillDir, { recursive: true });
	await writeFile(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: repo skill ${name}\n---\n\nbody\n`,
		"utf-8",
	);
	if (scope) {
		await writeFile(
			join(skillDir, "scope.json"),
			JSON.stringify(scope),
			"utf-8",
		);
	}
}

describe("SkillsPluginResolver repo-local skill discovery", () => {
	let home: string;
	let repoA: string;
	let repoB: string;
	let resolver: SkillsPluginResolver;

	beforeEach(async () => {
		const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
		home = join(tmpdir(), `cyrus-repolocal-home-${stamp}`);
		repoA = join(tmpdir(), `cyrus-repolocal-repoA-${stamp}`);
		repoB = join(tmpdir(), `cyrus-repolocal-repoB-${stamp}`);
		await mkdir(home, { recursive: true });
		await mkdir(repoA, { recursive: true });
		await mkdir(repoB, { recursive: true });
		await writeManifest(home);
		resolver = new SkillsPluginResolver(home, createTestLogger());
	});

	afterEach(async () => {
		for (const dir of [home, repoA, repoB]) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("unions repo-local skill directory names into the whitelist", async () => {
		await writeUserSkill(home, "plugin-skill");
		await writeRepoSkill(repoA, "repo-skill");

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			repoPaths: [repoA],
		});

		expect(names).toContain("plugin-skill");
		expect(names).toContain("repo-skill");
	});

	it("unions skills from every repo in a multi-repo session", async () => {
		await writeRepoSkill(repoA, "skill-a");
		await writeRepoSkill(repoB, "skill-b");

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			repoPaths: [repoA, repoB],
		});

		expect(names).toContain("skill-a");
		expect(names).toContain("skill-b");
	});

	it("is a no-op when a repo has no .claude/skills directory", async () => {
		await writeUserSkill(home, "plugin-skill");
		// repoA has no .claude/skills directory at all

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			repoPaths: [repoA],
		});

		expect(names).toEqual(["plugin-skill"]);
	});

	it("does not apply scope.json filtering to repo-local skills", async () => {
		// A scope that would NOT match the session context — must be ignored
		// for repo-local skills (presence in the repo is the scope).
		await writeRepoSkill(repoA, "repo-skill", {
			repositoryIds: ["some-other-repo"],
		});

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			repoPaths: [repoA],
		});

		expect(names).toContain("repo-skill");
	});

	it("deduplicates names when a repo-local skill collides with a plugin skill", async () => {
		await writeUserSkill(home, "shared");
		await writeRepoSkill(repoA, "shared");

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			repoPaths: [repoA],
		});

		expect(names.filter((n) => n === "shared")).toHaveLength(1);
	});

	it("ignores files (only directories/symlinks count as skills)", async () => {
		const skillsDir = join(repoA, ".claude", "skills");
		await mkdir(skillsDir, { recursive: true });
		await writeFile(join(skillsDir, "README.md"), "not a skill", "utf-8");
		await writeRepoSkill(repoA, "real-skill");

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			repoPaths: [repoA],
		});

		expect(names).toContain("real-skill");
		expect(names).not.toContain("README.md");
	});
});
