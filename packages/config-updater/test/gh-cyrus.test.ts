import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Behavioral tests for scripts/gh-cyrus.cjs — the per-invocation gh token
 * resolver. The real script is spawned with CYRUS_GH_REAL_BIN pointing at a
 * stub that prints the GH_TOKEN / GITHUB_TOKEN it received, so assertions
 * observe exactly what env the real gh would see.
 */
const SCRIPT = join(__dirname, "..", "scripts", "gh-cyrus.cjs");

describe("gh-cyrus per-invocation token resolution", () => {
	let dir: string;
	let cyrusHome: string;
	let stubGh: string;

	function saveTokens(
		tokens: Array<{ organization: string | null; token: string }>,
	): void {
		writeFileSync(
			join(cyrusHome, "github-tokens.json"),
			JSON.stringify({
				version: 1,
				updatedAt: new Date().toISOString(),
				tokens: tokens.map((t, i) => ({
					installationId: String(100 + i),
					organization: t.organization,
					accountType: "Organization",
					token: t.token,
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
				})),
			}),
		);
	}

	/** Create a git repo whose origin remote points at the given URL. */
	function makeRepo(name: string, remoteUrl: string): string {
		const repoPath = join(dir, name);
		mkdirSync(repoPath, { recursive: true });
		execFileSync("git", ["init", "-q"], { cwd: repoPath });
		execFileSync("git", ["remote", "add", "origin", remoteUrl], {
			cwd: repoPath,
		});
		return repoPath;
	}

	function runGhCyrus(
		args: string[],
		opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
	): { stdout: string; status: number | null } {
		const result = spawnSync("node", [SCRIPT, ...args], {
			cwd: opts.cwd ?? dir,
			encoding: "utf8",
			env: {
				...process.env,
				CYRUS_HOME: cyrusHome,
				CYRUS_GH_REAL_BIN: stubGh,
				GITHUB_TOKEN: "customer_github_token",
				GH_TOKEN: "customer_gh_token",
				CYRUS_GH_TOKEN: undefined,
				...opts.env,
			} as NodeJS.ProcessEnv,
		});
		return { stdout: result.stdout, status: result.status };
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gh-cyrus-test-"));
		cyrusHome = join(dir, ".cyrus");
		mkdirSync(cyrusHome, { recursive: true });
		stubGh = join(dir, "stub-gh.sh");
		writeFileSync(
			stubGh,
			`#!/usr/bin/env bash
echo "GH_TOKEN=\${GH_TOKEN:-<unset>}"
echo "GITHUB_TOKEN=\${GITHUB_TOKEN:-<unset>}"
echo "ARGS=$*"
exit 0
`,
			{ mode: 0o755 },
		);
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves the token from the cwd's origin remote org", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const repo = makeRepo("repo-b", "https://github.com/OrgB/repo-b.git");

		const { stdout } = runGhCyrus(["pr", "create"], { cwd: repo });

		expect(stdout).toContain("GH_TOKEN=ghs_org_b");
	});

	it("prefers an explicit --repo argument over the cwd remote", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		// cwd remote says OrgB, but the command explicitly targets OrgA.
		const repo = makeRepo("repo-b", "https://github.com/OrgB/repo-b.git");

		const flagForms = [
			["pr", "view", "--repo", "OrgA/some-repo"],
			["pr", "view", "--repo=OrgA/some-repo"],
			["pr", "view", "-R", "OrgA/some-repo"],
			["pr", "view", "--repo", "https://github.com/OrgA/some-repo"],
			["pr", "view", "--repo", "github.com/OrgA/some-repo"],
		];
		for (const args of flagForms) {
			const { stdout } = runGhCyrus(args, { cwd: repo });
			expect(stdout, args.join(" ")).toContain("GH_TOKEN=ghs_org_a");
		}
	});

	it("resolves scp-style remotes (git@github.com:Org/repo.git)", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const repo = makeRepo("repo-a", "git@github.com:OrgA/repo-a.git");

		const { stdout } = runGhCyrus(["issue", "list"], { cwd: repo });

		expect(stdout).toContain("GH_TOKEN=ghs_org_a");
	});

	it("falls back to CYRUS_GH_TOKEN outside a repo", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);

		const { stdout } = runGhCyrus(["api", "/user"], {
			env: { CYRUS_GH_TOKEN: "ghs_session_token" },
		});

		expect(stdout).toContain("GH_TOKEN=ghs_session_token");
	});

	it("falls back to the single valid token when nothing else matches", () => {
		saveTokens([{ organization: "OnlyOrg", token: "ghs_only" }]);

		const { stdout } = runGhCyrus(["api", "/user"]);

		expect(stdout).toContain("GH_TOKEN=ghs_only");
	});

	it("strips customer tokens and sets nothing when unresolvable", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);

		// Two tokens, no repo context, no CYRUS_GH_TOKEN → no resolution;
		// gh would use its own stored auth (hosts.yml).
		const { stdout } = runGhCyrus(["api", "/user"]);

		expect(stdout).toContain("GH_TOKEN=<unset>");
		expect(stdout).toContain("GITHUB_TOKEN=<unset>");
	});

	it("always strips GITHUB_TOKEN even when a token resolves", () => {
		saveTokens([{ organization: "OrgA", token: "ghs_org_a" }]);
		const repo = makeRepo("repo-a", "https://github.com/OrgA/repo-a.git");

		const { stdout } = runGhCyrus(["pr", "create"], { cwd: repo });

		expect(stdout).toContain("GH_TOKEN=ghs_org_a");
		expect(stdout).toContain("GITHUB_TOKEN=<unset>");
	});

	it("passes all arguments through and propagates the exit code", () => {
		const failingStub = join(dir, "stub-fail.sh");
		writeFileSync(failingStub, "#!/usr/bin/env bash\nexit 42\n", {
			mode: 0o755,
		});

		const passthrough = runGhCyrus(["pr", "create", "--title", "x"]);
		expect(passthrough.stdout).toContain("ARGS=pr create --title x");
		expect(passthrough.status).toBe(0);

		const failing = runGhCyrus(["pr", "view"], {
			env: { CYRUS_GH_REAL_BIN: failingStub },
		});
		expect(failing.status).toBe(42);
	});

	it("works without a token file at all (pure passthrough)", () => {
		const { stdout, status } = runGhCyrus(["auth", "status"]);

		expect(status).toBe(0);
		expect(stdout).toContain("GH_TOKEN=<unset>");
	});
});
