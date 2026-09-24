import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "miko-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DefaultSkillsDeployer } from "../src/DefaultSkillsDeployer.js";

const logger = {
	info: vi.fn(),
	warn: vi.fn(),
	debug: vi.fn(),
} as unknown as ILogger;
const exists = (path: string) =>
	access(path).then(
		() => true,
		() => false,
	);

describe("default skill upgrades", () => {
	let home: string;
	let bundled: string;
	let deployed: string;
	beforeEach(async () => {
		home = await mkdtemp(join(tmpdir(), "miko-skills-update-"));
		bundled = join(home, "bundled");
		deployed = join(home, "miko-skills-plugin", "skills");
	});
	afterEach(() => rm(home, { recursive: true, force: true }));
	async function skill(root: string, name: string, content: string) {
		await mkdir(join(root, name), { recursive: true });
		await writeFile(join(root, name, "SKILL.md"), content);
	}
	const content = (path: string, name: string) =>
		readFile(join(path, name, "SKILL.md"), "utf8");

	it("updates unchanged skills and adds defaults while retaining edits and deletions", async () => {
		for (const name of ["unchanged", "edited", "removed", "retired"])
			await skill(bundled, name, "version 1");
		const managed = new DefaultSkillsDeployer(home, logger, bundled);
		await managed.ensureDeployed();
		await skill(deployed, "edited", "my custom instructions");
		await rm(join(deployed, "removed"), { recursive: true });
		await rm(join(bundled, "retired"), { recursive: true });
		for (const name of ["unchanged", "edited", "removed", "new-skill"])
			await skill(bundled, name, "version 2");
		await managed.ensureDeployed();
		expect(await content(deployed, "unchanged")).toBe("version 2");
		expect(await content(deployed, "edited")).toBe("my custom instructions");
		expect(await exists(join(deployed, "removed"))).toBe(false);
		expect(await exists(join(deployed, "retired"))).toBe(false);
		expect(await content(deployed, "new-skill")).toBe("version 2");
	});

	it("migrates legacy copies against the previous release and supports rollback", async () => {
		const previous = join(home, "previous");
		for (const root of [previous, bundled, deployed])
			for (const name of ["unchanged", "customized"])
				await skill(root, name, root === bundled ? "version 2" : "version 1");
		await skill(deployed, "customized", "custom");
		await new DefaultSkillsDeployer(
			home,
			logger,
			bundled,
			previous,
		).ensureDeployed();
		expect(await content(deployed, "unchanged")).toBe("version 2");
		expect(await content(deployed, "customized")).toBe("custom");
		await new DefaultSkillsDeployer(home, logger, previous).ensureDeployed();
		expect(await content(deployed, "unchanged")).toBe("version 1");
	});

	it("preserves custom files and dangling symlinks", async () => {
		for (const name of ["custom-files", "custom-link"])
			await skill(bundled, name, "version 1");
		const managed = new DefaultSkillsDeployer(home, logger, bundled);
		await managed.ensureDeployed();
		await writeFile(join(deployed, "custom-files", "instructions.txt"), "mine");
		await rm(join(deployed, "custom-link"), { recursive: true });
		await symlink(join(home, "missing"), join(deployed, "custom-link"));
		await skill(bundled, "custom-files", "version 2");
		await managed.ensureDeployed();
		expect(await content(deployed, "custom-files")).toBe("version 1");
		expect(
			await readFile(
				join(deployed, "custom-files", "instructions.txt"),
				"utf8",
			),
		).toBe("mine");
		expect(await exists(join(home, "missing"))).toBe(false);
	});

	it("preserves unmatched legacy content when no baseline is available", async () => {
		await skill(bundled, "shipping", "version 2");
		await skill(deployed, "shipping", "unknown local version");
		await new DefaultSkillsDeployer(home, logger, bundled).ensureDeployed();
		expect(await content(deployed, "shipping")).toBe("unknown local version");
	});
});
