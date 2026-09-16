import { execFile } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// Exercise the built CLI, as installed by users. Run pnpm build before this suite
// (the repository CI already builds all packages before running tests).
const execFileAsync = promisify(execFile);

it.each([
	false,
	true,
])("credential commands complete with GitHub-only=%s", async (githubOnly) => {
	const home = mkdtempSync(join(tmpdir(), "cyrus-user-cli-"));
	try {
		writeFileSync(join(home, ".env"), "CYRUS_SENTRY_DISABLED=true\n");
		writeFileSync(join(home, "config.json"), '{"repositories":[]}');
		const installation = {
			installationId: "1",
			organization: "same-org",
			accountType: "Organization",
			token: "fixture-installation",
			expiresAt: "2099-01-01T00:00:00Z",
		};
		const storeFile = join(home, "github-tokens.json");
		writeFileSync(
			storeFile,
			JSON.stringify({ version: 1, updatedAt: "old", tokens: [installation] }),
		);
		const tokenFile = join(home, "fixture-token");
		writeFileSync(tokenFile, "invalid-lifecycle-fixture", { mode: 0o600 });
		const run = (args: string[]) =>
			execFileAsync(
				process.execPath,
				[
					fileURLToPath(new URL("../../dist/src/app.js", import.meta.url)),
					"--cyrus-home",
					home,
					...args,
				],
				{
					timeout: 10000,
					env: {
						PATH: process.env.PATH,
						HOME: home,
						CYRUS_SENTRY_DISABLED: "true",
					},
				},
			);
		await run([
			"add-user",
			"--linear-user-id",
			"lifecycle-user",
			"--name",
			"Lifecycle Test",
			...(githubOnly
				? ["--github-only"]
				: ["--claude-kind", "oauth", "--claude-token-file", tokenFile]),
			"--github-token-file",
			tokenFile,
			"--skip-claude-check",
			"--skip-github-check",
		]);
		const stored = JSON.parse(readFileSync(storeFile, "utf8"));
		expect(stored.tokens).toEqual([installation]);
		expect(stored.personalTokens["lifecycle-user"]).toEqual({
			token: "invalid-lifecycle-fixture",
		});
		expect(statSync(storeFile).mode & 0o777).toBe(0o600);
		expect(
			existsSync(
				join(home, "user-credentials", "lifecycle-user", "github-token"),
			),
		).toBe(false);
		expect(
			JSON.parse(readFileSync(join(home, "config.json"), "utf8")).linearUsers[
				"lifecycle-user"
			].github.token,
		).toEqual({ store: "github-tokens" });
		expect((await run(["list-users"])).stdout).toContain("Lifecycle Test");
		expect((await run(["check-users"])).stdout).toContain("resolves");
		if (githubOnly) {
			expect((await run(["list-users"])).stdout).toContain(
				"existing model authentication",
			);
			expect(
				JSON.parse(readFileSync(join(home, "config.json"), "utf8")).linearUsers[
					"lifecycle-user"
				].claude,
			).toBeUndefined();
		}
		await run(["remove-user", "lifecycle-user"]);
		const removed = JSON.parse(readFileSync(storeFile, "utf8"));
		expect(removed.personalTokens["lifecycle-user"]).toBeNull();
		expect(removed.tokens).toEqual([installation]);
		expect(
			JSON.parse(readFileSync(join(home, "config.json"), "utf8")).linearUsers ??
				{},
		).toEqual({});
	} finally {
		rmSync(home, { recursive: true, force: true });
	}
}, 45000);
