import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubTokenStore } from "miko-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildAuthenticatedGitHubCloneUrl,
	createSelfHostedGitHubAppTokenProvider,
	ensureSelfHostedGitHubAuth,
	resolveGitHubTokenForRepoUrl,
} from "../src/selfHostedGitHubAuth.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

describe("createSelfHostedGitHubAppTokenProvider", () => {
	let mikoHome: string;

	beforeEach(() => {
		mikoHome = mkdtempSync(join(tmpdir(), "miko-self-gh-"));
	});

	afterEach(() => {
		rmSync(mikoHome, { recursive: true, force: true });
	});

	it("returns null when App credentials are missing (fallback path)", () => {
		expect(createSelfHostedGitHubAppTokenProvider(mikoHome, {})).toBeNull();
	});

	it("creates a provider when GITHUB_APP_ID and pem exist", () => {
		writeFileSync(join(mikoHome, "github-app.pem"), pem);
		const provider = createSelfHostedGitHubAppTokenProvider(mikoHome, {
			GITHUB_APP_ID: "123",
			GITHUB_APP_INSTALLATION_ID: "999",
		});
		expect(provider).not.toBeNull();
		expect(provider?.appId).toBe("123");
	});
});

describe("ensureSelfHostedGitHubAuth", () => {
	let mikoHome: string;
	beforeEach(() => {
		mikoHome = mkdtempSync(join(tmpdir(), "miko-self-gh-auth-"));
		vi.clearAllMocks();
	});

	afterEach(() => {
		rmSync(mikoHome, { recursive: true, force: true });
		vi.restoreAllMocks();
	});

	it("no-ops without App credentials (local fallback)", async () => {
		const result = await ensureSelfHostedGitHubAuth(mikoHome, { env: {} });
		expect(result.attempted).toBe(false);
		expect(result.tokensCount).toBe(0);
		expect(result.provider).toBeNull();
	});

	it("mints installation tokens into the store when App credentials exist", async () => {
		writeFileSync(join(mikoHome, "github-app.pem"), pem);
		const expiresAt = new Date(Date.now() + 3600_000).toISOString();

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (
					url.includes("/app/installations?") ||
					url.endsWith("/app/installations")
				) {
					return new Response(
						JSON.stringify([
							{
								id: 42,
								account: { login: "AcmeOrg", type: "Organization" },
							},
						]),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				if (url.includes("/access_tokens")) {
					return new Response(
						JSON.stringify({ token: "ghs_minted_acme", expires_at: expiresAt }),
						{ status: 200, headers: { "Content-Type": "application/json" } },
					);
				}
				return new Response("not found", { status: 404 });
			});

		const result = await ensureSelfHostedGitHubAuth(mikoHome, {
			env: { GITHUB_APP_ID: "123" },
		});

		expect(result.attempted).toBe(true);
		expect(result.tokensCount).toBe(1);
		expect(result.provider).not.toBeNull();

		const store = new GitHubTokenStore(mikoHome);
		expect(store.getTokenForOrg("AcmeOrg")).toBe("ghs_minted_acme");
		expect(
			resolveGitHubTokenForRepoUrl(
				mikoHome,
				"https://github.com/AcmeOrg/private-repo",
			),
		).toBe("ghs_minted_acme");

		fetchSpy.mockRestore();
	});

	it("prefers App store token over falling back when resolving a repo URL", async () => {
		const store = new GitHubTokenStore(mikoHome);
		store.save([
			{
				installationId: "1",
				organization: "myorg",
				accountType: "Organization",
				token: "ghs_preferred",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		]);
		expect(
			resolveGitHubTokenForRepoUrl(
				mikoHome,
				"https://github.com/myorg/repo.git",
			),
		).toBe("ghs_preferred");
	});
});

describe("buildAuthenticatedGitHubCloneUrl", () => {
	it("embeds the token for https github URLs", () => {
		expect(
			buildAuthenticatedGitHubCloneUrl(
				"https://github.com/acme/repo.git",
				"ghs_x",
			),
		).toBe("https://x-access-token:ghs_x@github.com/acme/repo.git");
	});

	it("rewrites scp ssh URLs", () => {
		expect(
			buildAuthenticatedGitHubCloneUrl("git@github.com:acme/repo.git", "ghs_x"),
		).toBe("https://x-access-token:ghs_x@github.com/acme/repo.git");
	});

	it("returns null for non-GitHub hosts", () => {
		expect(
			buildAuthenticatedGitHubCloneUrl(
				"https://gitlab.com/acme/repo.git",
				"ghs_x",
			),
		).toBeNull();
	});
});
