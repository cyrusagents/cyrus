import { access, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	handleDeleteSkill,
	handleUpdateSkill,
} from "../../src/handlers/skills.js";

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

describe("handleUpdateSkill — scope persistence", () => {
	let home: string;

	beforeEach(async () => {
		home = join(
			tmpdir(),
			`cyrus-skill-${Date.now()}-${Math.random().toString(36).slice(2)}`,
		);
		await mkdir(home, { recursive: true });
	});

	afterEach(async () => {
		await rm(home, { recursive: true, force: true });
	});

	it("does not write scope.json when no scope dimensions are provided", async () => {
		const res = await handleUpdateSkill(
			{ name: "global-skill", description: "desc", content: "body" },
			home,
		);
		expect(res.success).toBe(true);

		const scopePath = join(
			home,
			"user-skills-plugin/skills/global-skill/scope.json",
		);
		expect(await fileExists(scopePath)).toBe(false);
	});

	it("writes scope.json with populated dimensions only", async () => {
		const res = await handleUpdateSkill(
			{
				name: "scoped",
				description: "desc",
				content: "body",
				repositoryIds: ["repo-a", "repo-b"],
				linearTeamIds: [],
				linearLabelIds: ["label-1"],
			},
			home,
		);
		expect(res.success).toBe(true);

		const scopePath = join(home, "user-skills-plugin/skills/scoped/scope.json");
		const parsed = JSON.parse(await readFile(scopePath, "utf-8"));
		expect(parsed).toEqual({
			repositoryIds: ["repo-a", "repo-b"],
			linearLabelIds: ["label-1"],
		});
	});

	it("removes a stale scope.json when an update drops all scope dimensions", async () => {
		await handleUpdateSkill(
			{
				name: "togglable",
				description: "desc",
				content: "body",
				repositoryIds: ["repo-a"],
			},
			home,
		);
		const scopePath = join(
			home,
			"user-skills-plugin/skills/togglable/scope.json",
		);
		expect(await fileExists(scopePath)).toBe(true);

		// Second update without any scope fields → sidecar should be removed
		const res = await handleUpdateSkill(
			{ name: "togglable", description: "desc", content: "body" },
			home,
		);
		expect(res.success).toBe(true);
		expect(await fileExists(scopePath)).toBe(false);
	});

	it("treats arrays containing only empty strings as no scope", async () => {
		const res = await handleUpdateSkill(
			{
				name: "blanky",
				description: "desc",
				content: "body",
				repositoryIds: ["", ""],
			},
			home,
		);
		expect(res.success).toBe(true);

		const scopePath = join(home, "user-skills-plugin/skills/blanky/scope.json");
		expect(await fileExists(scopePath)).toBe(false);
	});

	it("deletes the entire skill directory (including scope.json) when handleDeleteSkill runs", async () => {
		await handleUpdateSkill(
			{
				name: "doomed",
				description: "desc",
				content: "body",
				linearTeamIds: ["team-x"],
			},
			home,
		);
		const skillDir = join(home, "user-skills-plugin/skills/doomed");
		expect(await fileExists(join(skillDir, "scope.json"))).toBe(true);

		const res = await handleDeleteSkill({ name: "doomed" }, home);
		expect(res.success).toBe(true);
		expect(await fileExists(skillDir)).toBe(false);
	});
});
