import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	extractGitProviderRepoParts,
	type GitProviderToken,
	GitProviderTokenStore,
} from "../src/git-provider-token-store.js";

function token(overrides: Partial<GitProviderToken> = {}): GitProviderToken {
	return {
		provider: "gitlab",
		host: "gitlab.com",
		namespace: "group/subgroup",
		token: "glpat_token",
		expiresAt: null,
		username: "oauth2",
		...overrides,
	};
}

describe("extractGitProviderRepoParts", () => {
	it("extracts host and namespace from nested https URLs", () => {
		expect(
			extractGitProviderRepoParts(
				"https://gitlab.com/group/subgroup/project.git",
			),
		).toEqual({ host: "gitlab.com", namespace: "group/subgroup" });
	});

	it("extracts host and namespace from scp-style SSH URLs", () => {
		expect(
			extractGitProviderRepoParts("git@gitlab.example.com:platform/app.git"),
		).toEqual({ host: "gitlab.example.com", namespace: "platform" });
	});
});

describe("GitProviderTokenStore", () => {
	let cyrusHome: string;
	let store: GitProviderTokenStore;

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-provider-store-"));
		store = new GitProviderTokenStore(cyrusHome);
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("round-trips tokens through a 0600 provider token file", () => {
		store.save([token()]);
		const filePath = join(cyrusHome, "git-provider-tokens.json");
		expect(existsSync(filePath)).toBe(true);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		const parsed = JSON.parse(readFileSync(filePath, "utf8"));
		expect(parsed.version).toBe(1);
		expect(store.load()).toEqual([token()]);
	});

	it("matches a GitLab token by host and nested namespace", () => {
		store.save([
			token({ namespace: "group", token: "glpat_group" }),
			token({ namespace: "other", token: "glpat_other" }),
		]);

		expect(
			store.getTokenForRepoUrl(
				"https://gitlab.com/group/subgroup/repo",
				"gitlab",
			)?.token,
		).toBe("glpat_group");
	});

	it("returns the single host token as a fallback", () => {
		store.save([token({ namespace: null, token: "glpat_single" })]);
		expect(
			store.getTokenForRepoUrl("https://gitlab.com/any/group/repo", "gitlab")
				?.token,
		).toBe("glpat_single");
	});

	it("ignores expired tokens", () => {
		store.save([
			token({
				token: "glpat_stale",
				expiresAt: new Date(Date.now() - 1000).toISOString(),
			}),
		]);
		expect(
			store.getTokenForRepoUrl(
				"https://gitlab.com/group/subgroup/repo",
				"gitlab",
			),
		).toBeUndefined();
	});
});
