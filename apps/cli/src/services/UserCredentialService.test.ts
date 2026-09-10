import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EdgeConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	detectClaudeCredentialKind,
	UserCredentialService,
} from "./UserCredentialService.js";

// Placeholder values shaped like real tokens; not real credentials.
const OAUTH = "sk-ant-oat01-placeholder-not-real";
const API_KEY = "sk-ant-api03-placeholder-not-real";
const PAT = "github_pat_placeholder_not_real";

let home: string;
beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "cyrus-user-cred-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
	vi.restoreAllMocks();
});

describe("detectClaudeCredentialKind", () => {
	it("classifies OAuth tokens and API keys by prefix", () => {
		expect(detectClaudeCredentialKind(OAUTH)).toBe("oauthToken");
		expect(detectClaudeCredentialKind(API_KEY)).toBe("apiKey");
		expect(detectClaudeCredentialKind("something-else")).toBeUndefined();
	});
});

describe("UserCredentialService storage", () => {
	it("stores secrets in owner-only files and returns file references", () => {
		const svc = new UserCredentialService(home);
		const ref = svc.storeSecretFile("user-1", "github-token", `${PAT}\n`);
		expect("file" in ref).toBe(true);
		if (!("file" in ref)) return;
		expect(ref.file).toBe(
			join(home, "user-credentials", "user-1", "github-token"),
		);
		expect(readFileSync(ref.file, "utf-8")).toBe(`${PAT}\n`);
		expect(statSync(ref.file).mode & 0o777).toBe(0o600);
		expect(
			statSync(join(home, "user-credentials", "user-1")).mode & 0o777,
		).toBe(0o700);
		expect(svc.isManagedFile(ref)).toBe(true);
		expect(svc.isManagedFile({ file: "/etc/passwd" })).toBe(false);
		expect(svc.removeStoredSecrets("user-1")).toBe(true);
		expect(svc.removeStoredSecrets("user-1")).toBe(false);
	});

	it("sanitizes user IDs used as directory names", () => {
		const svc = new UserCredentialService(home);
		expect(svc.userDir("../evil")).toBe(
			join(home, "user-credentials", ".._evil"),
		);
	});

	it("upserts and removes users in config without touching other keys", () => {
		const config: EdgeConfig = { repositories: [], strictMcpConfig: false };
		const withUser = UserCredentialService.upsertUser(config, "u1", {
			displayName: "Ada",
			claude: { oauthToken: { env: "A" } },
			github: { token: { env: "B" } },
		});
		expect(withUser.strictMcpConfig).toBe(false);
		expect(Object.keys(withUser.linearUsers ?? {})).toEqual(["u1"]);
		const { config: without, removed } = UserCredentialService.removeUser(
			withUser,
			"u1",
		);
		expect(removed).toBe(true);
		expect(without.linearUsers).toBeUndefined();
		// config.json never contains the secret itself
		expect(JSON.stringify(withUser)).not.toContain(OAUTH);
	});
});

describe("UserCredentialService verification", () => {
	it("verifies a GitHub token and derives the noreply address", async () => {
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit) => {
				const auth = (init?.headers as Record<string, string>).Authorization;
				expect(auth).toBe(`Bearer ${PAT}`);
				return new Response(
					JSON.stringify({ login: "ada", id: 42, name: "Ada L", email: null }),
					{ status: 200, headers: { "x-oauth-scopes": "repo" } },
				);
			},
		) as unknown as typeof fetch;
		const actor = await UserCredentialService.verifyGitHubToken(PAT, fetchImpl);
		expect(actor).toEqual({
			login: "ada",
			id: 42,
			name: "Ada L",
			email: null,
			noreplyEmail: "42+ada@users.noreply.github.com",
			tokenScopes: "repo",
		});
	});

	it("reports an invalid GitHub token without echoing it", async () => {
		const fetchImpl = (async () =>
			new Response("", { status: 401 })) as unknown as typeof fetch;
		await expect(
			UserCredentialService.verifyGitHubToken(PAT, fetchImpl),
		).rejects.toThrow(/401 Unauthorized/);
		try {
			await UserCredentialService.verifyGitHubToken(PAT, fetchImpl);
		} catch (error) {
			expect((error as Error).message).not.toContain(PAT);
		}
	});

	it("resolves a Linear user by email and rejects ambiguous matches", async () => {
		const one = (async () =>
			new Response(
				JSON.stringify({
					data: {
						users: {
							nodes: [
								{
									id: "lin-1",
									name: "Ada",
									displayName: "ada",
									email: "ada@x.io",
									active: true,
								},
							],
						},
					},
				}),
			)) as unknown as typeof fetch;
		await expect(
			UserCredentialService.lookupLinearUser(
				"lin_token",
				{ email: "ada@x.io" },
				one,
			),
		).resolves.toMatchObject({ id: "lin-1" });

		const two = (async () =>
			new Response(
				JSON.stringify({
					data: { users: { nodes: [{ id: "a" }, { id: "b" }] } },
				}),
			)) as unknown as typeof fetch;
		await expect(
			UserCredentialService.lookupLinearUser(
				"lin_token",
				{ email: "x@x.io" },
				two,
			),
		).rejects.toThrow(/2 users/);
	});

	it("inspects a user entry with secret-free fingerprints", () => {
		const svc = new UserCredentialService(home);
		const claudeRef = svc.storeSecretFile("u1", "claude-oauth-token", OAUTH);
		const info = UserCredentialService.inspectUser("u1", {
			displayName: "Ada",
			claude: { oauthToken: claudeRef },
			github: { token: { env: "NOT_SET_ANYWHERE_XYZ" }, login: "ada" },
		});
		expect(info.claude.ok).toBe(true);
		if (info.claude.ok) {
			expect(info.claude.fingerprint).toHaveLength(8);
			expect(OAUTH).not.toContain(info.claude.fingerprint);
		}
		expect(info.github.ok).toBe(false);
		if (!info.github.ok) {
			expect(info.github.error).toContain("NOT_SET_ANYWHERE_XYZ");
		}
	});
});
