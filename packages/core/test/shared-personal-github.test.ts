import { execFile } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ensureGitHubScripts } from "../src/github-scripts.js";
import { GitHubTokenStore } from "../src/github-token-store.js";
import {
	readGitHubCredentialRef,
	resolveLinearUserCredentials,
} from "../src/prompter-credentials.js";
import { buildRunnerEnvironment } from "../src/runner-environment.js";

const exec = promisify(execFile);
const A = "67a670bb-4d83-46ed-b98b-88bb2089d95d";
const B = "917d99c8-c72d-4c22-9167-597f407faae9";
const installation = {
	installationId: "123",
	organization: "same-org",
	accountType: "Organization" as const,
	token: "fixture-installation",
	expiresAt: "2099-01-01T00:00:00Z",
};
let home: string;
let store: GitHubTokenStore;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cyrus-shared-pat-"));
	store = new GitHubTokenStore(home);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));
const disk = () => JSON.parse(readFileSync(store.filePath, "utf8"));

function session(id: string, name: string) {
	const result = resolveLinearUserCredentials(
		id,
		{
			displayName: name,
			github: {
				token: { store: "github-tokens" },
				login: name,
				gitAuthorName: name,
				gitAuthorEmail: `${name}@example.test`,
			},
		},
		{
			cyrusHome: home,
			gitCredentialHelperPath: ensureGitHubScripts(home),
			includeClaude: false,
		},
	);
	if (!result.ok) throw new Error(result.message);
	return buildRunnerEnvironment(
		{
			additionalEnv: result.credentials.env,
			omitEnv: result.credentials.omitEnv,
		},
		{
			PATH: process.env.PATH,
			HOME: home,
			GH_TOKEN: "fixture-host",
			GITHUB_TOKEN: "fixture-host",
			CYRUS_GH_TOKEN: "fixture-installation",
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(home, "empty-config"),
			GIT_TERMINAL_PROMPT: "0",
		},
	);
}

describe("shared installation and personal GitHub store", () => {
	it("reads legacy v1 and preserves both namespaces and future metadata on every writer", () => {
		writeFileSync(
			store.filePath,
			JSON.stringify({
				version: 1,
				updatedAt: "old",
				tokens: [installation],
				futureMetadata: { keep: true },
			}),
			{ mode: 0o644 },
		);
		expect(store.getTokenForOrg("SAME-ORG")).toBe(installation.token);
		store.setPersonalToken(A, { token: "fixture-A" });
		store.save([{ ...installation, token: "fixture-refresh" }]);
		expect(store.getPersonalToken(A)).toBe("fixture-A");
		store.removePersonalToken(A);
		expect(store.getTokenForRepoUrl("git@github.com:same-org/repo.git")).toBe(
			"fixture-refresh",
		);
		expect(disk().personalTokens[A]).toBeNull();
		expect(disk().futureMetadata).toEqual({ keep: true });
		expect(statSync(store.filePath).mode & 0o777).toBe(0o600);
	});

	it("serializes independent CLI-style add/remove and hosted refresh processes without lost updates", async () => {
		store.save([installation]);
		for (let i = 0; i < 4; i++)
			store.setPersonalToken(`remove-${i}`, { token: "fixture-remove" });
		const module = pathToFileURL(
			join(__dirname, "../dist/github-token-store.js"),
		).href;
		await Promise.all(
			Array.from({ length: 9 }, (_, index) =>
				exec(
					process.execPath,
					[
						"--input-type=module",
						"-e",
						`
   import { GitHubTokenStore } from ${JSON.stringify(module)};
   const store = new GitHubTokenStore(process.argv[1]);
   for (let j=0; j<12; j++) {
    ${index === 8 ? `store.save([${JSON.stringify(installation)}]);` : index < 4 ? `store.setPersonalToken("add-${index}", {token:"fixture-${index}"});` : `store.removePersonalToken("remove-${index - 4}");`}
   }
  `,
						home,
					],
					{ timeout: 15000 },
				),
			),
		);
		expect(disk().tokens).toEqual([installation]);
		for (let i = 0; i < 4; i++) {
			expect(store.getPersonalToken(`add-${i}`)).toBe(`fixture-${i}`);
			expect(disk().personalTokens[`remove-${i}`]).toBeNull();
		}
		expect(existsSync(`${store.filePath}.lock`)).toBe(false);
	}, 20000);

	it("times out behind an existing lock without deleting it or changing credentials", () => {
		store.save([installation]);
		const before = readFileSync(store.filePath, "utf8");
		writeFileSync(`${store.filePath}.lock`, "fixture-existing-writer", {
			mode: 0o600,
		});
		expect(() => store.setPersonalToken(A, { token: "fixture-A" })).toThrow(
			/locked/,
		);
		expect(readFileSync(`${store.filePath}.lock`, "utf8")).toBe(
			"fixture-existing-writer",
		);
		expect(readFileSync(store.filePath, "utf8")).toBe(before);
	}, 10000);

	it.each([
		"{broken",
		'{"version":2,"tokens":[]}',
		'{"version":1,"tokens":[],"personalTokens":[]}',
	])("refuses corruption without overwriting it (%s)", (contents) => {
		writeFileSync(store.filePath, contents);
		expect(() => store.save([installation])).toThrow(/invalid/);
		expect(() => store.setPersonalToken(A, { token: "fixture-A" })).toThrow(
			/invalid/,
		);
		expect(() => store.removePersonalToken(A)).toThrow(/invalid/);
		expect(readFileSync(store.filePath, "utf8")).toBe(contents);
		expect(existsSync(`${store.filePath}.lock`)).toBe(false);
	});

	it("imports legacy files once, preserves sources/Claude, retains environment rotation, and never revives revocation", () => {
		const source = join(home, "old-pat");
		writeFileSync(source, "fixture-A\n");
		store.save([installation]);
		expect(readGitHubCredentialRef({ file: source }, A, home)).toMatchObject({
			value: "fixture-A",
		});
		expect(readFileSync(source, "utf8")).toBe("fixture-A\n");
		rmSync(source);
		expect(readGitHubCredentialRef({ file: source }, A, home)).toMatchObject({
			value: "fixture-A",
		});
		expect(
			readGitHubCredentialRef({ env: "B_PAT" }, B, home, {
				B_PAT: "fixture-B",
			}),
		).toMatchObject({ value: "fixture-B", envName: "B_PAT" });
		expect(store.getPersonalToken(B, { B_PAT: "fixture-B-rotated" })).toBe(
			"fixture-B-rotated",
		);
		store.removePersonalToken(A);
		writeFileSync(source, "fixture-stale");
		expect(readGitHubCredentialRef({ file: source }, A, home)).toHaveProperty(
			"error",
		);
		expect(
			readGitHubCredentialRef({ store: "github-tokens" }, "missing", home),
		).toHaveProperty("error");
		expect(store.load()).toEqual([installation]);
	});

	it("uses different A/B credentials concurrently for the SAME org through gh PATH shim and git, with author AND committer", async () => {
		store.save([installation]);
		store.setPersonalToken(A, { token: "fixture-A" });
		store.setPersonalToken(B, { token: "fixture-B" });
		const stub = join(home, "real-gh");
		writeFileSync(
			stub,
			"#!/usr/bin/env node\nprocess.stdout.write(process.env.GH_TOKEN);",
			{ mode: 0o755 },
		);
		await Promise.all(
			[
				[A, "Alice", "fixture-A"],
				[B, "Bob", "fixture-B"],
			].map(async ([id, name, token]) => {
				const env = { ...session(id!, name!), CYRUS_GH_REAL_BIN: stub };
				const repo = join(home, name!);
				mkdirSync(repo);
				await exec("git", ["init", "-q", repo], { env });
				await exec(
					"git",
					["remote", "add", "origin", "https://github.com/same-org/repo.git"],
					{ cwd: repo, env },
				);
				const gh = await exec(
					"gh",
					["pr", "create", "-R", "same-org/repo", "--draft"],
					{ cwd: repo, env },
				);
				expect(gh.stdout).toBe(token);
				const git = await new Promise<string>((resolve, reject) => {
					const child = execFile(
						"git",
						["credential", "fill"],
						{ cwd: repo, env },
						(err, out) => (err ? reject(err) : resolve(out)),
					);
					child.stdin!.end(
						"protocol=https\nhost=github.com\npath=same-org/repo.git\n\n",
					);
				});
				expect(git).toContain(`password=${token}`);
				await exec(
					"git",
					[
						"-c",
						"commit.gpgsign=false",
						"commit",
						"--allow-empty",
						"-qm",
						"identity proof",
					],
					{ cwd: repo, env },
				);
				const commit = await exec(
					"git",
					["log", "-1", "--format=%an <%ae>|%cn <%ce>"],
					{ cwd: repo, env },
				);
				expect(commit.stdout.trim()).toBe(
					`${name} <${name}@example.test>|${name} <${name}@example.test>`,
				);
			}),
		);
	});

	it.each([
		"missing",
		"revoked",
		"corrupt",
		"empty",
	])("refuses %s explicit selections in gh and git despite host and installation credentials", async (kind) => {
		store.save([installation]);
		store.setPersonalToken(A, { token: "fixture-A" });
		const env = session(A, "Alice");
		const marker = join(home, "gh-was-run");
		const stub = join(home, "real-gh");
		writeFileSync(
			stub,
			`#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`,
			{ mode: 0o755 },
		);
		env.CYRUS_GH_REAL_BIN = stub;
		if (kind === "missing") env.CYRUS_GITHUB_USER_ID = "missing";
		if (kind === "empty") env.CYRUS_GITHUB_USER_ID = "";
		if (kind === "revoked") store.removePersonalToken(A);
		if (kind === "corrupt") writeFileSync(store.filePath, "{invalid");
		await expect(exec("gh", ["api", "user"], { env })).rejects.toMatchObject({
			code: 1,
			stderr: expect.stringContaining("shared credentials will not be used"),
		});
		expect(existsSync(marker)).toBe(false);
		await expect(
			new Promise((resolve, reject) => {
				const child = execFile(
					"git",
					["credential", "fill"],
					{ env },
					(err, out) => (err ? reject(err) : resolve(out)),
				);
				child.stdin!.end(
					"protocol=https\nhost=github.com\npath=same-org/repo.git\n\n",
				);
			}),
		).rejects.toMatchObject({ code: 128 });
	});
});
