import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * Behavioral tests for scripts/gh-miko.cjs — the per-invocation gh token
 * resolver. The real script is spawned with MIKO_GH_REAL_BIN pointing at a
 * stub that prints the GH_TOKEN / GITHUB_TOKEN it received, so assertions
 * observe exactly what env the real gh would see.
 */
const SCRIPT = join(__dirname, "..", "scripts", "gh-miko.cjs");

describe("gh-miko per-invocation token resolution", () => {
	let dir: string;
	let mikoHome: string;
	let stubGh: string;

	function saveTokens(
		tokens: Array<{ organization: string | null; token: string }>,
	): void {
		writeFileSync(
			join(mikoHome, "github-tokens.json"),
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

	function runGhMiko(
		args: string[],
		opts: { cwd?: string; env?: Record<string, string | undefined> } = {},
	): { stdout: string; status: number | null } {
		const result = spawnSync("node", [SCRIPT, ...args], {
			cwd: opts.cwd ?? dir,
			encoding: "utf8",
			env: {
				...process.env,
				MIKO_HOME: mikoHome,
				MIKO_GH_REAL_BIN: stubGh,
				GITHUB_TOKEN: "customer_github_token",
				GH_TOKEN: "customer_gh_token",
				MIKO_GH_TOKEN: undefined,
				...opts.env,
			} as NodeJS.ProcessEnv,
		});
		return { stdout: result.stdout, status: result.status };
	}

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "gh-miko-test-"));
		mikoHome = join(dir, ".miko");
		mkdirSync(mikoHome, { recursive: true });
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

		const { stdout } = runGhMiko(["pr", "create"], { cwd: repo });

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
			const { stdout } = runGhMiko(args, { cwd: repo });
			expect(stdout, args.join(" ")).toContain("GH_TOKEN=ghs_org_a");
		}
	});

	it("resolves scp-style remotes (git@github.com:Org/repo.git)", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const repo = makeRepo("repo-a", "git@github.com:OrgA/repo-a.git");

		const { stdout } = runGhMiko(["issue", "list"], { cwd: repo });

		expect(stdout).toContain("GH_TOKEN=ghs_org_a");
	});

	it("uses a repo view positional target instead of cwd or the session token", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const cwd = makeRepo("repo-a", "https://github.com/OrgA/repo-a.git");
		for (const args of [
			["repo", "view", "OrgB/repo-b"],
			["repo", "view", "https://github.com/OrgB/repo-b"],
			["repo", "view", "--branch", "OrgA/feature", "OrgB/repo-b"],
			["repo", "view", "-bOrgA/feature", "OrgB/repo-b"],
			["repo", "view", "--json", "nameWithOwner", "--", "OrgB/repo-b"],
		]) {
			const result = runGhMiko(args, {
				cwd,
				env: { MIKO_GH_TOKEN: "ghs_org_a" },
			});
			expect(result.stdout, args.join(" ")).toContain("GH_TOKEN=ghs_org_b");
			expect(result.stdout).toContain(`ARGS=${args.join(" ")}`);
		}
	});

	it("does not treat option values or unrelated command text as repository targets", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const cwd = makeRepo("repo-a", "https://github.com/OrgA/repo-a.git");
		for (const args of [
			["repo", "view", "--branch", "OrgB/feature"],
			["repo", "view", "--branch=OrgB/feature"],
			["pr", "create", "--title", "OrgB/repo-b"],
		]) {
			expect(runGhMiko(args, { cwd }).stdout, args.join(" ")).toContain(
				"GH_TOKEN=ghs_org_a",
			);
		}
	});

	it("resolves clone and fork sources without reading their option values or git arguments as targets", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const cwd = makeRepo("repo-a", "https://github.com/OrgA/repo-a.git");
		for (const args of [
			["repo", "clone", "OrgB/repo-b", "OrgA/destination"],
			["repo", "clone", "--upstream-remote-name", "OrgA/remote", "OrgB/repo-b"],
			["repo", "fork", "--org", "OrgA", "OrgB/repo-b"],
		]) {
			expect(runGhMiko(args, { cwd }).stdout, args.join(" ")).toContain(
				"GH_TOKEN=ghs_org_b",
			);
		}
		expect(
			runGhMiko(["repo", "fork", "--", "--reference", "OrgB/local"], { cwd })
				.stdout,
		).toContain("GH_TOKEN=ghs_org_a");
	});

	it("honors GH_REPO before cwd but after an explicit repository", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);
		const cwd = makeRepo("repo-a", "https://github.com/OrgA/repo-a.git");
		const opts = { cwd, env: { GH_REPO: "OrgB/repo-b" } };
		expect(runGhMiko(["pr", "list"], opts).stdout).toContain(
			"GH_TOKEN=ghs_org_b",
		);
		expect(runGhMiko(["repo", "view", "OrgA/repo-a"], opts).stdout).toContain(
			"GH_TOKEN=ghs_org_a",
		);
		expect(runGhMiko(["pr", "list", "-ROrgA/repo-a"], opts).stdout).toContain(
			"GH_TOKEN=ghs_org_a",
		);
	});

	it("falls back to MIKO_GH_TOKEN outside a repo", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);

		const { stdout } = runGhMiko(["api", "/user"], {
			env: { MIKO_GH_TOKEN: "ghs_session_token" },
		});

		expect(stdout).toContain("GH_TOKEN=ghs_session_token");
	});

	it("falls back to the single valid token when nothing else matches", () => {
		saveTokens([{ organization: "OnlyOrg", token: "ghs_only" }]);

		const { stdout } = runGhMiko(["api", "/user"]);

		expect(stdout).toContain("GH_TOKEN=ghs_only");
	});

	it("strips customer tokens and sets nothing when unresolvable", () => {
		saveTokens([
			{ organization: "OrgA", token: "ghs_org_a" },
			{ organization: "OrgB", token: "ghs_org_b" },
		]);

		// Two tokens, no repo context, no MIKO_GH_TOKEN → no resolution;
		// gh would use its own stored auth (hosts.yml).
		const { stdout } = runGhMiko(["api", "/user"]);

		expect(stdout).toContain("GH_TOKEN=<unset>");
		expect(stdout).toContain("GITHUB_TOKEN=<unset>");
	});

	it("always strips GITHUB_TOKEN even when a token resolves", () => {
		saveTokens([{ organization: "OrgA", token: "ghs_org_a" }]);
		const repo = makeRepo("repo-a", "https://github.com/OrgA/repo-a.git");

		const { stdout } = runGhMiko(["pr", "create"], { cwd: repo });

		expect(stdout).toContain("GH_TOKEN=ghs_org_a");
		expect(stdout).toContain("GITHUB_TOKEN=<unset>");
	});

	it("passes all arguments through and propagates the exit code", () => {
		const failingStub = join(dir, "stub-fail.sh");
		writeFileSync(failingStub, "#!/usr/bin/env bash\nexit 42\n", {
			mode: 0o755,
		});

		const passthrough = runGhMiko(["pr", "create", "--title", "x"]);
		expect(passthrough.stdout).toContain("ARGS=pr create --title x");
		expect(passthrough.status).toBe(0);

		const failing = runGhMiko(["pr", "view"], {
			env: { MIKO_GH_REAL_BIN: failingStub },
		});
		expect(failing.status).toBe(42);
	});

	it("works without a token file at all (pure passthrough)", () => {
		const { stdout, status } = runGhMiko(["auth", "status"]);

		expect(status).toBe(0);
		expect(stdout).toContain("GH_TOKEN=<unset>");
	});
});
