import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillsPluginResolver } from "../src/SkillsPluginResolver.js";

async function pathExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function createTestLogger(): ILogger {
	return {
		info: () => {},
		warn: () => {},
		error: () => {},
		debug: () => {},
		withContext: () => createTestLogger(),
	} as unknown as ILogger;
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

async function writeManifest(cyrusHome: string): Promise<void> {
	const manifestDir = join(cyrusHome, "user-skills-plugin", ".claude-plugin");
	await mkdir(manifestDir, { recursive: true });
	await writeFile(
		join(manifestDir, "plugin.json"),
		JSON.stringify({ name: "user-skills", description: "" }),
		"utf-8",
	);
}

describe("SkillsPluginResolver scope filtering", () => {
	let home: string;
	let resolver: SkillsPluginResolver;

	beforeEach(async () => {
		home = join(
			tmpdir(),
			`cyrus-scope-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(home, { recursive: true });
		await writeManifest(home);
		resolver = new SkillsPluginResolver(home, createTestLogger());
	});

	afterEach(async () => {
		await (await import("node:fs/promises")).rm(home, {
			recursive: true,
			force: true,
		});
	});

	it("includes global (no scope) skills for every context", async () => {
		await writeUserSkill(home, "global-skill");
		const plugins = await resolver.resolve();

		const namesA = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
		});
		const namesB = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-b",
			linearTeamId: "team-x",
		});

		expect(namesA).toContain("global-skill");
		expect(namesB).toContain("global-skill");
	});

	it("includes repo-scoped skills only when repository matches", async () => {
		await writeUserSkill(home, "repo-only", { repositoryIds: ["repo-a"] });
		const plugins = await resolver.resolve();

		const match = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
		});
		const miss = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-b",
		});

		expect(match).toContain("repo-only");
		expect(miss).not.toContain("repo-only");
	});

	it("includes team-scoped skills only when team matches", async () => {
		await writeUserSkill(home, "team-only", { linearTeamIds: ["team-x"] });
		const plugins = await resolver.resolve();

		const match = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			linearTeamId: "team-x",
		});
		const missTeam = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			linearTeamId: "team-y",
		});
		const missNoTeam = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
		});

		expect(match).toContain("team-only");
		expect(missTeam).not.toContain("team-only");
		expect(missNoTeam).not.toContain("team-only");
	});

	it("includes label-scoped skills only when issue has a matching label", async () => {
		await writeUserSkill(home, "label-only", {
			linearLabelIds: ["label-1", "label-2"],
		});
		const plugins = await resolver.resolve();

		const match = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			linearLabelIds: ["label-2", "label-other"],
		});
		const miss = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			linearLabelIds: ["label-other"],
		});
		const missNoLabels = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
		});

		expect(match).toContain("label-only");
		expect(miss).not.toContain("label-only");
		expect(missNoLabels).not.toContain("label-only");
	});

	it("requires every populated dimension to match (AND across dimensions)", async () => {
		await writeUserSkill(home, "multi", {
			repositoryIds: ["repo-a"],
			linearTeamIds: ["team-x"],
			linearLabelIds: ["label-1"],
		});
		const plugins = await resolver.resolve();

		const allMatch = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			linearTeamId: "team-x",
			linearLabelIds: ["label-1"],
		});
		const oneOff = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
			linearTeamId: "team-x",
			linearLabelIds: ["label-2"],
		});
		const repoOff = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-b",
			linearTeamId: "team-x",
			linearLabelIds: ["label-1"],
		});

		expect(allMatch).toContain("multi");
		expect(oneOff).not.toContain("multi");
		expect(repoOff).not.toContain("multi");
	});

	it("treats malformed or empty scope.json as global", async () => {
		await writeUserSkill(home, "empty-scope", {});
		// Also write a malformed sidecar to verify graceful fallback
		const badDir = join(home, "user-skills-plugin", "skills", "bad-scope");
		await mkdir(badDir, { recursive: true });
		await writeFile(
			join(badDir, "SKILL.md"),
			"---\nname: bad-scope\ndescription: x\n---\n\nbody\n",
			"utf-8",
		);
		await writeFile(join(badDir, "scope.json"), "{not json", "utf-8");

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins, {
			repositoryId: "repo-a",
		});

		expect(names).toContain("empty-scope");
		expect(names).toContain("bad-scope");
	});

	it("returns every skill (no filtering) when context is omitted", async () => {
		await writeUserSkill(home, "scoped", { repositoryIds: ["repo-a"] });
		await writeUserSkill(home, "unscoped");

		const plugins = await resolver.resolve();
		const names = await resolver.discoverSkillNames(plugins);

		expect(names).toEqual(expect.arrayContaining(["scoped", "unscoped"]));
	});
});

describe("SkillsPluginResolver.ensureUserPluginScaffolded", () => {
	let home: string;

	beforeEach(async () => {
		home = join(
			tmpdir(),
			`cyrus-scaffold-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(home, { recursive: true });
	});

	afterEach(async () => {
		await (await import("node:fs/promises")).rm(home, {
			recursive: true,
			force: true,
		});
	});

	it("creates the plugin layout on a clean home (no user-skills dir yet)", async () => {
		const resolver = new SkillsPluginResolver(home, createTestLogger());
		await resolver.ensureUserPluginScaffolded();

		expect(await pathExists(join(home, "user-skills-plugin/skills"))).toBe(
			true,
		);
		const manifestPath = join(
			home,
			"user-skills-plugin/.claude-plugin/plugin.json",
		);
		expect(await pathExists(manifestPath)).toBe(true);

		const parsed = JSON.parse(await readFile(manifestPath, "utf-8"));
		expect(parsed.name).toBe("user-skills");
	});

	it("is idempotent across repeated startups", async () => {
		const resolver = new SkillsPluginResolver(home, createTestLogger());
		await resolver.ensureUserPluginScaffolded();

		const manifestPath = join(
			home,
			"user-skills-plugin/.claude-plugin/plugin.json",
		);
		const first = await readFile(manifestPath, "utf-8");

		await resolver.ensureUserPluginScaffolded();
		await resolver.ensureUserPluginScaffolded();

		expect(await readFile(manifestPath, "utf-8")).toBe(first);
	});

	it("does not overwrite an existing manifest", async () => {
		const manifestDir = join(home, "user-skills-plugin/.claude-plugin");
		await mkdir(manifestDir, { recursive: true });
		const manifestPath = join(manifestDir, "plugin.json");
		const customManifest = JSON.stringify({
			name: "user-skills",
			description: "custom",
			version: "9.9.9",
		});
		await writeFile(manifestPath, customManifest, "utf-8");

		const resolver = new SkillsPluginResolver(home, createTestLogger());
		await resolver.ensureUserPluginScaffolded();

		expect(await readFile(manifestPath, "utf-8")).toBe(customManifest);
	});

	it("creates the skills directory even when only the manifest pre-exists", async () => {
		const manifestDir = join(home, "user-skills-plugin/.claude-plugin");
		await mkdir(manifestDir, { recursive: true });
		await writeFile(
			join(manifestDir, "plugin.json"),
			JSON.stringify({ name: "user-skills" }),
			"utf-8",
		);

		const resolver = new SkillsPluginResolver(home, createTestLogger());
		await resolver.ensureUserPluginScaffolded();

		expect(await pathExists(join(home, "user-skills-plugin/skills"))).toBe(
			true,
		);
	});
});
