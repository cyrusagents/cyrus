import { execFileSync } from "node:child_process";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexRunner } from "../src/CodexRunner.js";

function writeSkill(root: string, name: string): string {
	const skillDir = join(root, name);
	mkdirSync(skillDir, { recursive: true });
	writeFileSync(
		join(skillDir, "SKILL.md"),
		`---\nname: ${name}\ndescription: ${name} description\n---\n\nbody\n`,
	);
	return skillDir;
}

describe("CodexRunner managed skills", () => {
	let tempDirs: string[] = [];

	afterEach(() => {
		vi.restoreAllMocks();
		for (const dir of tempDirs) {
			rmSync(dir, { recursive: true, force: true });
		}
		tempDirs = [];
	});

	function makeTempDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "codex-skills-test-"));
		tempDirs.push(dir);
		return dir;
	}

	it("stages allowed managed and repo-local skills as Codex repo skill symlinks", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		const internalPlugin = join(root, "internal-plugin");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(userPlugin, "skills"), "custom-user");
		writeSkill(join(internalPlugin, "skills"), "implementation");
		writeSkill(join(worktree, ".claude", "skills"), "repo-local");

		const runner = new CodexRunner({
			workingDirectory: worktree,
			cyrusHome: root,
			plugins: [
				{ type: "local", path: userPlugin },
				{ type: "local", path: internalPlugin },
			],
			skills: ["custom-user", "repo-local"],
		});

		(
			runner as unknown as { prepareManagedSkillsForCodex: () => void }
		).prepareManagedSkillsForCodex();

		const stagedUserSkill = join(worktree, ".agents", "skills", "custom-user");
		const stagedRepoSkill = join(worktree, ".agents", "skills", "repo-local");
		expect(lstatSync(stagedUserSkill).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(stagedUserSkill, "SKILL.md"), "utf-8")).toContain(
			"name: custom-user",
		);
		expect(lstatSync(stagedRepoSkill).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(stagedRepoSkill, "SKILL.md"), "utf-8")).toContain(
			"name: repo-local",
		);
		expect(
			existsSync(join(worktree, ".agents", "skills", "implementation")),
		).toBe(false);

		(
			runner as unknown as { cleanupRuntimeState: () => void }
		).cleanupRuntimeState();
		expect(existsSync(stagedUserSkill)).toBe(false);
		expect(existsSync(stagedRepoSkill)).toBe(false);
	});

	it("does not overwrite an existing Codex skill with the same name", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(join(worktree, ".agents", "skills", "custom-user"), {
			recursive: true,
		});
		writeSkill(join(userPlugin, "skills"), "custom-user");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const runner = new CodexRunner({
			workingDirectory: worktree,
			cyrusHome: root,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		});

		(
			runner as unknown as { prepareManagedSkillsForCodex: () => void }
		).prepareManagedSkillsForCodex();

		const existingSkill = join(worktree, ".agents", "skills", "custom-user");
		expect(lstatSync(existingSkill).isDirectory()).toBe(true);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("Skipping managed skill 'custom-user'"),
		);
	});

	it("removes staged skill symlinks when the runner is stopped", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(worktree, { recursive: true });
		writeSkill(join(userPlugin, "skills"), "custom-user");

		const runner = new CodexRunner({
			workingDirectory: worktree,
			cyrusHome: root,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		});

		(
			runner as unknown as { prepareManagedSkillsForCodex: () => void }
		).prepareManagedSkillsForCodex();
		(
			runner as unknown as {
				sessionInfo: { sessionId: string; startedAt: Date; isRunning: boolean };
			}
		).sessionInfo = {
			sessionId: "session-1",
			startedAt: new Date(),
			isRunning: true,
		};

		const stagedUserSkill = join(worktree, ".agents", "skills", "custom-user");
		expect(lstatSync(stagedUserSkill).isSymbolicLink()).toBe(true);

		runner.stop();

		expect(existsSync(stagedUserSkill)).toBe(false);
	});

	it("adds the staged .agents directory to local git exclude", () => {
		const root = makeTempDir();
		const worktree = join(root, "worktree");
		const userPlugin = join(root, "user-plugin");
		mkdirSync(worktree, { recursive: true });
		execFileSync("git", ["init"], { cwd: worktree, stdio: "ignore" });
		writeSkill(join(userPlugin, "skills"), "custom-user");

		const runner = new CodexRunner({
			workingDirectory: worktree,
			cyrusHome: root,
			plugins: [{ type: "local", path: userPlugin }],
			skills: ["custom-user"],
		});

		(
			runner as unknown as { prepareManagedSkillsForCodex: () => void }
		).prepareManagedSkillsForCodex();

		const exclude = readFileSync(join(worktree, ".git", "info", "exclude"), {
			encoding: "utf-8",
		});
		expect(exclude.split(/\r?\n/)).toContain(".agents/");

		const status = execFileSync("git", ["status", "--short"], {
			cwd: worktree,
			encoding: "utf-8",
		});
		expect(status).not.toContain(".agents");
	});
});
