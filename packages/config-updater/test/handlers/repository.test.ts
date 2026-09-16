import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubTokenStore } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { handleRepository } from "../../src/handlers/repository.js";

// Mock child_process.exec; the promisified wrapper invokes it as
// exec(cmd, callback). Each call records the command and fakes a successful
// clone by creating <repoPath>/.git (repoPath is the second quoted arg).
const executedCommands: string[] = [];
vi.mock("node:child_process", () => ({
	exec: vi.fn(
		(
			cmd: string,
			callback: (
				err: Error | null,
				result: { stdout: string; stderr: string },
			) => void,
		) => {
			executedCommands.push(cmd);
			const quoted = [...cmd.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
			const repoPath = quoted[1];
			if (repoPath) {
				mkdirSync(join(repoPath, ".git"), { recursive: true });
			}
			callback(null, { stdout: "", stderr: "" });
		},
	),
}));

describe("handleRepository clone auth selection (CYHOST-913)", () => {
	let cyrusHome: string;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-repo-handler-"));
		executedCommands.length = 0;
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("uses plain git clone when pushed tokens cover the repo's org", async () => {
		new GitHubTokenStore(cyrusHome).save([
			{
				installationId: "111",
				organization: "OrgOne",
				accountType: "Organization",
				token: "ghs_org_one",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			},
		]);

		const response = await handleRepository(
			{
				repository_url: "https://github.com/OrgOne/repo-a.git",
				repository_name: "repo-a",
			},
			cyrusHome,
		);

		expect(response.success).toBe(true);
		expect(executedCommands).toHaveLength(1);
		expect(executedCommands[0]).toMatch(/^git clone /);
	});

	it("uses git clone via single-token fallback for an unmatched org", async () => {
		new GitHubTokenStore(cyrusHome).save([
			{
				installationId: "111",
				organization: "OrgOne",
				accountType: "Organization",
				token: "ghs_org_one",
				expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
			},
		]);

		const response = await handleRepository(
			{ repository_url: "https://github.com/SomeoneElse/repo-b.git" },
			cyrusHome,
		);

		expect(response.success).toBe(true);
		expect(executedCommands[0]).toMatch(/^git clone /);
	});

	it("falls back to gh repo clone when no pushed tokens exist (self-host)", async () => {
		const response = await handleRepository(
			{
				repository_url: "https://github.com/OrgOne/repo-a.git",
				repository_name: "repo-a",
			},
			cyrusHome,
		);

		expect(response.success).toBe(true);
		expect(executedCommands).toHaveLength(1);
		expect(executedCommands[0]).toMatch(/^gh repo clone /);
	});

	it("treats expired pushed tokens as absent and uses gh repo clone", async () => {
		new GitHubTokenStore(cyrusHome).save([
			{
				installationId: "111",
				organization: "OrgOne",
				accountType: "Organization",
				token: "ghs_expired",
				expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
			},
		]);

		const response = await handleRepository(
			{ repository_url: "https://github.com/OrgOne/repo-a.git" },
			cyrusHome,
		);

		expect(response.success).toBe(true);
		expect(executedCommands[0]).toMatch(/^gh repo clone /);
	});

	it("verifies an existing repository without cloning", async () => {
		const reposDir = join(cyrusHome, "repos");
		mkdirSync(join(reposDir, "repo-a", ".git"), { recursive: true });

		const response = await handleRepository(
			{
				repository_url: "https://github.com/OrgOne/repo-a.git",
				repository_name: "repo-a",
			},
			cyrusHome,
		);

		expect(response.success).toBe(true);
		if (response.success) {
			expect(response.data?.action).toBe("verified");
		}
		expect(executedCommands).toHaveLength(0);
	});
});
