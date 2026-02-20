import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CursorRunner } from "../src/CursorRunner.js";

const tempDirs: string[] = [];

function createTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-runner-perms-"));
	tempDirs.push(dir);
	return dir;
}

describe("CursorRunner permissions mapping", () => {
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) {
			rmSync(dir, { recursive: true, force: true });
		}
		delete process.env.CYRUS_CURSOR_MOCK;
	});

	it("maps Claude-style tool permissions to Cursor CLI permissions", () => {
		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: "/tmp/repo",
			allowedTools: [
				"Read(src/**)",
				"Edit(src/**)",
				"Bash(git:*)",
				"Bash",
				"mcp__trigger__search_docs",
				"mcp__linear",
			],
			disallowedTools: ["Read(.env*)", "Bash(rm:*)", "mcp__trigger__delete"],
		});

		const config = (runner as any).buildCursorPermissionsConfig();

		expect(config).toEqual({
			permissions: {
				allow: [
					"Read(src/**)",
					"Write(src/**)",
					"Shell(git)",
					"Shell(*)",
					"Mcp(trigger:search_docs)",
					"Mcp(linear:*)",
				],
				deny: ["Read(.env*)", "Shell(rm)", "Mcp(trigger:delete)"],
			},
		});
	});

	it("scopes wildcard read/write permissions to workspace paths", () => {
		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory: "/tmp/repo",
			allowedTools: ["Read", "Edit", "Write", "TodoWrite"],
		});

		const config = (runner as any).buildCursorPermissionsConfig();

		expect(config.permissions.allow).toEqual(["Read(./**)", "Write(./**)"]);
		expect(config.permissions.deny.length).toBeGreaterThan(0);
		expect(config.permissions.deny).toContain("Read(/etc/**)");
		expect(config.permissions.deny).toContain("Write(/etc/**)");
	});

	it("temporarily writes mapped permissions and restores existing .cursor/cli.json", () => {
		const workingDirectory = createTempDir();
		const cursorDir = join(workingDirectory, ".cursor");
		mkdirSync(cursorDir, { recursive: true });
		const configPath = join(cursorDir, "cli.json");
		const originalConfig = {
			permissions: {
				allow: ["Read(custom/**)"],
				deny: ["Shell(rm)"],
			},
			custom: true,
		};
		writeFileSync(
			configPath,
			`${JSON.stringify(originalConfig, null, "\t")}\n`,
		);

		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory,
			allowedTools: [
				"Read(src/**)",
				"Edit(src/**)",
				"Bash(git:*)",
				"mcp__trigger__search_docs",
			],
			disallowedTools: ["Bash(rm:*)", "mcp__trigger__delete"],
		});

		(runner as any).syncProjectPermissionsConfig();

		const syncedConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(syncedConfig.permissions.allow).toEqual([
			"Read(src/**)",
			"Write(src/**)",
			"Shell(git)",
			"Mcp(trigger:search_docs)",
		]);
		expect(syncedConfig.permissions.deny).toEqual([
			"Shell(rm)",
			"Mcp(trigger:delete)",
		]);

		(runner as any).restoreProjectPermissionsConfig();

		const restoredConfig = JSON.parse(readFileSync(configPath, "utf8"));
		expect(restoredConfig).toEqual(originalConfig);
	});

	it("only mutates project .cursor/cli.json and leaves non-project configs unchanged", () => {
		const workingDirectory = createTempDir();
		const homeDirectory = createTempDir();
		const projectCursorDir = join(workingDirectory, ".cursor");
		const homeCursorDir = join(homeDirectory, ".cursor");
		mkdirSync(projectCursorDir, { recursive: true });
		mkdirSync(homeCursorDir, { recursive: true });

		const projectConfigPath = join(projectCursorDir, "cli.json");
		const homeConfigPath = join(homeCursorDir, "cli.json");
		const originalProjectConfig = {
			permissions: { allow: ["Read(project/**)"], deny: ["Shell(rm)"] },
		};
		const originalHomeConfig = {
			permissions: { allow: ["Read(home/**)"], deny: ["Shell(*)"] },
		};
		writeFileSync(
			projectConfigPath,
			`${JSON.stringify(originalProjectConfig, null, "\t")}\n`,
		);
		writeFileSync(
			homeConfigPath,
			`${JSON.stringify(originalHomeConfig, null, "\t")}\n`,
		);

		const runner = new CursorRunner({
			cyrusHome: homeDirectory,
			workingDirectory,
			allowedTools: ["Read(src/**)", "Bash(git:*)"],
			disallowedTools: ["Bash(rm:*)"],
		});

		(runner as any).syncProjectPermissionsConfig();

		const syncedProjectConfig = JSON.parse(
			readFileSync(projectConfigPath, "utf8"),
		);
		expect(syncedProjectConfig.permissions.allow).toEqual([
			"Read(src/**)",
			"Shell(git)",
		]);
		expect(syncedProjectConfig.permissions.deny).toEqual(["Shell(rm)"]);

		const unchangedHomeConfig = JSON.parse(
			readFileSync(homeConfigPath, "utf8"),
		);
		expect(unchangedHomeConfig).toEqual(originalHomeConfig);

		(runner as any).restoreProjectPermissionsConfig();

		const restoredProjectConfig = JSON.parse(
			readFileSync(projectConfigPath, "utf8"),
		);
		expect(restoredProjectConfig).toEqual(originalProjectConfig);
		const stillUnchangedHomeConfig = JSON.parse(
			readFileSync(homeConfigPath, "utf8"),
		);
		expect(stillUnchangedHomeConfig).toEqual(originalHomeConfig);
	});

	it("removes temporary .cursor/cli.json after run when no original file exists", async () => {
		const workingDirectory = createTempDir();
		process.env.CYRUS_CURSOR_MOCK = "1";
		const runner = new CursorRunner({
			cyrusHome: "/tmp/cyrus",
			workingDirectory,
			allowedTools: ["Read(src/**)", "Bash(git:*)"],
			disallowedTools: ["Bash(rm:*)"],
		});
		await runner.start("run with temporary permissions file");

		const configPath = join(workingDirectory, ".cursor", "cli.json");
		expect(existsSync(configPath)).toBe(false);
	});
});
