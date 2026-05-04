import { execSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { inspectGitGuardrail } from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function git(cwd: string, args: string): void {
	execSync(`git ${args}`, {
		cwd,
		stdio: ["ignore", "ignore", "ignore"],
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
}

describe("inspectGitGuardrail", () => {
	let workdir: string;

	beforeEach(() => {
		workdir = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-"));
	});

	afterEach(() => {
		rmSync(workdir, { recursive: true, force: true });
	});

	it("returns null when cwd is not a git repository", () => {
		expect(inspectGitGuardrail(workdir, silentLogger)).toBeNull();
	});

	it("returns null on a clean repo with no commits ahead of upstream", () => {
		// Create a bare "remote" and a clone, so we have an upstream and a clean tree.
		const remote = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-remote-"));
		try {
			execSync(`git init --bare`, { cwd: remote, stdio: "ignore" });
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "hello\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "init"');
			git(workdir, "push -u origin main");

			expect(inspectGitGuardrail(workdir, silentLogger)).toBeNull();
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});

	it("returns a guardrail message when there are uncommitted changes", () => {
		git(workdir, "init -b main");
		writeFileSync(join(workdir, "a.txt"), "stuff\n");

		const message = inspectGitGuardrail(workdir, silentLogger);
		expect(message).toContain("1 uncommitted file change");
		expect(message).toContain("Create or update a pull request");
	});

	it("counts commits ahead of upstream as unshipped work", () => {
		const remote = mkdtempSync(join(tmpdir(), "cyrus-stop-hook-remote-"));
		try {
			execSync(`git init --bare`, { cwd: remote, stdio: "ignore" });
			git(workdir, "init -b main");
			git(workdir, `remote add origin ${remote}`);
			writeFileSync(join(workdir, "README.md"), "hello\n");
			git(workdir, "add README.md");
			git(workdir, 'commit -m "init"');
			git(workdir, "push -u origin main");

			writeFileSync(join(workdir, "feature.txt"), "feature\n");
			git(workdir, "add feature.txt");
			git(workdir, 'commit -m "feature"');

			const message = inspectGitGuardrail(workdir, silentLogger);
			expect(message).toContain("1 commit");
			expect(message).toContain("not yet on the remote");
		} finally {
			rmSync(remote, { recursive: true, force: true });
		}
	});
});
