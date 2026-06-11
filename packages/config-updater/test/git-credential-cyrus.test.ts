import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT_PATH = join(
	dirname(fileURLToPath(import.meta.url)),
	"..",
	"scripts",
	"git-credential-cyrus.cjs",
);

interface HelperResult {
	stdout: string;
	stderr: string;
	status: number | null;
}

function runHelper(op: string, stdin: string, cyrusHome: string): HelperResult {
	const result = spawnSync(process.execPath, [SCRIPT_PATH, op], {
		input: stdin,
		encoding: "utf-8",
		env: { ...process.env, CYRUS_HOME: cyrusHome },
	});
	return {
		stdout: result.stdout ?? "",
		stderr: result.stderr ?? "",
		status: result.status,
	};
}

function writeTokensFile(
	cyrusHome: string,
	tokens: Array<Record<string, unknown>>,
): void {
	writeFileSync(
		join(cyrusHome, "github-tokens.json"),
		JSON.stringify({
			version: 1,
			updatedAt: new Date().toISOString(),
			tokens,
		}),
	);
}

function writeProviderTokensFile(
	cyrusHome: string,
	tokens: Array<Record<string, unknown>>,
): void {
	writeFileSync(
		join(cyrusHome, "git-provider-tokens.json"),
		JSON.stringify({
			version: 1,
			updatedAt: new Date().toISOString(),
			tokens,
		}),
	);
}

const future = () => new Date(Date.now() + 3600_000).toISOString();
const past = () => new Date(Date.now() - 3600_000).toISOString();

describe("git-credential-cyrus helper script", () => {
	let cyrusHome: string;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-cred-script-"));
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("prints credentials for a case-insensitive org match", () => {
		writeTokensFile(cyrusHome, [
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_match",
				expiresAt: future(),
			},
			{
				installationId: "2",
				organization: "Other",
				accountType: "Organization",
				token: "ghs_other",
				expiresAt: future(),
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=github.com\npath=myorg/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("username=x-access-token\npassword=ghs_match\n");
	});

	it("falls back to the single valid token when the org does not match", () => {
		writeTokensFile(cyrusHome, [
			{
				installationId: "1",
				organization: "SomeUser",
				accountType: "User",
				token: "ghs_solo",
				expiresAt: future(),
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=github.com\npath=unrelated/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("username=x-access-token\npassword=ghs_solo\n");
	});

	it("exits silently when multiple tokens exist and none match", () => {
		writeTokensFile(cyrusHome, [
			{
				installationId: "1",
				organization: "OrgA",
				token: "ghs_a",
				expiresAt: future(),
			},
			{
				installationId: "2",
				organization: "OrgB",
				token: "ghs_b",
				expiresAt: future(),
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=github.com\npath=unrelated/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it("ignores expired tokens", () => {
		writeTokensFile(cyrusHome, [
			{
				installationId: "1",
				organization: "MyOrg",
				token: "ghs_stale",
				expiresAt: past(),
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=github.com\npath=myorg/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("exits silently for non-github.com hosts", () => {
		writeTokensFile(cyrusHome, [
			{
				installationId: "1",
				organization: "MyOrg",
				token: "ghs_match",
				expiresAt: future(),
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=gitlab.com\npath=myorg/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});

	it("prints GitLab credentials from the provider-neutral token file", () => {
		writeProviderTokensFile(cyrusHome, [
			{
				provider: "gitlab",
				host: "gitlab.com",
				namespace: "group/subgroup",
				token: "glpat_match",
				expiresAt: null,
				username: "oauth2",
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=gitlab.com\npath=group/subgroup/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stderr).toBe("");
		expect(result.stdout).toBe("username=oauth2\npassword=glpat_match\n");
	});

	it("matches self-managed GitLab hosts from the provider-neutral token file", () => {
		writeProviderTokensFile(cyrusHome, [
			{
				provider: "gitlab",
				host: "gitlab.example.com",
				namespace: "platform",
				token: "glpat_self_managed",
				expiresAt: future(),
			},
		]);

		const result = runHelper(
			"get",
			"protocol=https\nhost=gitlab.example.com\npath=platform/service.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe(
			"username=oauth2\npassword=glpat_self_managed\n",
		);
	});

	it("does nothing for non-get operations", () => {
		writeTokensFile(cyrusHome, [
			{
				installationId: "1",
				organization: "MyOrg",
				token: "ghs_match",
				expiresAt: future(),
			},
		]);

		const result = runHelper(
			"store",
			"protocol=https\nhost=github.com\npath=myorg/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
	});

	it("exits silently when the tokens file is missing", () => {
		const result = runHelper(
			"get",
			"protocol=https\nhost=github.com\npath=myorg/repo.git\n",
			cyrusHome,
		);

		expect(result.status).toBe(0);
		expect(result.stdout).toBe("");
		expect(result.stderr).toBe("");
	});
});
