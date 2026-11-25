import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { readUserPluginSkills } from "../src/user-plugin-skills.js";

let temp: string | undefined;

afterEach(async () => {
	if (temp) await rm(temp, { recursive: true, force: true });
});

it("only admits qualified skills from enabled user installations", async () => {
	temp = await mkdtemp(join(tmpdir(), "cyrus-plugin-skills-"));
	const skills = join(temp, "skills");
	await mkdir(join(skills, "check"), { recursive: true });
	await writeFile(join(skills, "check", "SKILL.md"), "# Check");
	await mkdir(join(skills, "not-a-skill"));
	await symlink(join(skills, "check"), join(skills, "linked"), "dir");

	const plugin = { enabled: true, scope: "user", installPath: temp };
	expect(
		await readUserPluginSkills([
			{ ...plugin, id: "example@market" },
			{ ...plugin, id: "example@market" },
			{ ...plugin, id: "off@market", enabled: false },
			{ ...plugin, id: "project@market", scope: "project" },
			{ ...plugin, id: "user-skills@market" },
			{ ...plugin, id: "cyrus-skills@market" },
			{ ...plugin, id: "removed@market", installPath: join(temp, "missing") },
			{ ...plugin, id: "relative@market", installPath: "." },
			null,
		]),
	).toEqual(["example:check", "example:linked"]);
});
