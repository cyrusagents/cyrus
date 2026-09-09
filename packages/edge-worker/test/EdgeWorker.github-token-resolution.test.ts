import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RepositoryConfig } from "cyrus-core";
import { GitHubTokenStore } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * Tests for CYHOST-913: multi-org GitHub App installation token support.
 *
 * `resolveGitHubToken` must prefer an org-matched token from the local
 * token store (pushed by cyrus-hosted) over the forwarded installation
 * token, the self-minted App token, and the GITHUB_TOKEN PAT.
 *
 * The private method is exercised directly against a minimal `this` shape
 * (token store + logger + optional App token provider) to avoid the heavy
 * EdgeWorker constructor.
 */
describe("EdgeWorker.resolveGitHubToken precedence (CYHOST-913)", () => {
	let cyrusHome: string;
	let store: GitHubTokenStore;
	let savedGitHubTokenEnv: string | undefined;

	const repository = {
		id: "repo-1",
		name: "Repo One",
		repositoryPath: "/tmp/repo-one",
		workspaceBaseDir: "/tmp/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "ws-1",
		isActive: true,
		githubUrl: "https://github.com/myorg/repo-one",
	} as RepositoryConfig;

	function resolve(
		event: { installationToken?: string },
		repo?: RepositoryConfig,
		appTokenProvider?: { getToken: () => Promise<string> },
	): Promise<string | undefined> {
		const fakeThis = {
			githubTokenStore: store,
			gitHubAppTokenProvider: appTokenProvider ?? null,
			logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
		};
		return (
			EdgeWorker.prototype as unknown as {
				resolveGitHubToken: (
					event: unknown,
					repository?: RepositoryConfig,
				) => Promise<string | undefined>;
			}
		).resolveGitHubToken.call(fakeThis, event, repo);
	}

	beforeEach(() => {
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-token-resolution-"));
		store = new GitHubTokenStore(cyrusHome);
		savedGitHubTokenEnv = process.env.GITHUB_TOKEN;
		delete process.env.GITHUB_TOKEN;
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
		if (savedGitHubTokenEnv === undefined) {
			delete process.env.GITHUB_TOKEN;
		} else {
			process.env.GITHUB_TOKEN = savedGitHubTokenEnv;
		}
	});

	it("prefers an org-matched store token over the forwarded installation token", async () => {
		store.save([
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_from_store",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);
		process.env.GITHUB_TOKEN = "ghp_pat";

		const token = await resolve(
			{ installationToken: "ghs_forwarded" },
			repository,
		);
		expect(token).toBe("ghs_from_store");
	});

	it("prefers an org-matched store token over the GITHUB_TOKEN env var", async () => {
		store.save([
			{
				installationId: "1",
				organization: "myorg",
				accountType: "Organization",
				token: "ghs_from_store",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);
		process.env.GITHUB_TOKEN = "ghp_pat";

		const token = await resolve({}, repository);
		expect(token).toBe("ghs_from_store");
	});

	it("falls back to the forwarded installation token when no store entry matches", async () => {
		store.save([
			{
				installationId: "1",
				organization: "unrelated-org",
				accountType: "Organization",
				token: "ghs_unrelated",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
			{
				installationId: "2",
				organization: "another-org",
				accountType: "Organization",
				token: "ghs_another",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);

		const token = await resolve(
			{ installationToken: "ghs_forwarded" },
			repository,
		);
		expect(token).toBe("ghs_forwarded");
	});

	it("falls back to GITHUB_TOKEN when the store has no match and no token was forwarded", async () => {
		process.env.GITHUB_TOKEN = "ghp_pat";

		const token = await resolve({}, repository);
		expect(token).toBe("ghp_pat");
	});

	it("ignores expired store tokens", async () => {
		store.save([
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_expired",
				expiresAt: new Date(Date.now() - 3600_000).toISOString(),
			},
		]);

		const token = await resolve(
			{ installationToken: "ghs_forwarded" },
			repository,
		);
		expect(token).toBe("ghs_forwarded");
	});

	it("skips the store tier when no repository is provided", async () => {
		store.save([
			{
				installationId: "1",
				organization: "MyOrg",
				accountType: "Organization",
				token: "ghs_from_store",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);

		const token = await resolve({ installationToken: "ghs_forwarded" });
		expect(token).toBe("ghs_forwarded");
	});

	it("uses the self-minted App token before GITHUB_TOKEN when no store entry matches", async () => {
		process.env.GITHUB_TOKEN = "ghp_pat";
		const provider = { getToken: vi.fn().mockResolvedValue("ghs_minted") };

		const token = await resolve({}, repository, provider);
		expect(token).toBe("ghs_minted");
		expect(provider.getToken).toHaveBeenCalled();
	});
});
