import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EdgeConfigSchema } from "../src/config-schemas.js";
import {
	collectEnvRefNames,
	credentialFingerprint,
	decideFollowUpPrompt,
	decideSessionCredentialUser,
	ensurePrompterGitCredentialHelper,
	isPrompterCredentialsEnabled,
	PROMPTER_ENV,
	readCredentialRef,
	resolveLinearUserCredentials,
	resolvePrompterCredentialPolicy,
} from "../src/prompter-credentials.js";

const ADA = "linear-user-ada";
const BOB = "linear-user-bob";

// Placeholder values shaped like real tokens, but not real.
const ADA_CLAUDE = "sk-ant-oat01-ada-placeholder-not-a-real-token";
const ADA_GITHUB = "github_pat_ada_placeholder_not_a_real_token";
const BOB_CLAUDE = "sk-ant-oat01-bob-placeholder-not-a-real-token";
const BOB_GITHUB = "github_pat_bob_placeholder_not_a_real_token";

let tmp: string;

beforeEach(() => {
	tmp = mkdtempSync(join(tmpdir(), "cyrus-prompter-creds-"));
});

afterEach(() => {
	rmSync(tmp, { recursive: true, force: true });
});

function writeSecret(name: string, value: string): string {
	const path = join(tmp, name);
	writeFileSync(path, `${value}\n`, { mode: 0o600 });
	return path;
}

describe("EdgeConfigSchema linearUsers", () => {
	it("accepts env and file credential references and rejects inline secrets", () => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [],
			linearUsers: {
				[ADA]: {
					displayName: "Ada",
					claude: { oauthToken: { env: "ADA_CLAUDE_TOKEN" } },
					github: {
						token: { file: "~/.cyrus/user-credentials/ada/github-token" },
						login: "ada",
						gitAuthorEmail: "ada@example.com",
					},
				},
			},
			prompterCredentialPolicy: { followUpByOtherUser: "reject" },
		});
		expect(parsed.linearUsers?.[ADA]?.github?.login).toBe("ada");

		// A literal token where a reference belongs is a schema error.
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [],
				linearUsers: {
					[ADA]: { github: { token: "github_pat_literal" } },
				},
			}),
		).toThrow();
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [],
				linearUsers: {
					[ADA]: { github: { token: { env: "X", file: "y" } } },
				},
			}),
		).toThrow();
	});

	it("is inactive without mapped users", () => {
		expect(isPrompterCredentialsEnabled(undefined)).toBe(false);
		expect(isPrompterCredentialsEnabled({})).toBe(false);
		expect(isPrompterCredentialsEnabled({ [ADA]: {} })).toBe(true);
	});
});

describe("readCredentialRef", () => {
	it("reads env refs and never echoes the value in errors", () => {
		expect(
			readCredentialRef({ env: "X_TOKEN" }, { X_TOKEN: " abc \n" }),
		).toEqual({ value: "abc" });
		const missing = readCredentialRef({ env: "X_TOKEN" }, {});
		expect(missing).toEqual({
			error: "environment variable X_TOKEN is not set",
		});
	});

	it("reads and trims file refs; missing/empty files are secret-free errors", () => {
		const path = writeSecret("tok", ADA_GITHUB);
		expect(readCredentialRef({ file: path })).toEqual({ value: ADA_GITHUB });
		const empty = writeSecret("empty", "   ");
		expect(readCredentialRef({ file: empty })).toEqual({
			error: `credential file ${empty} is empty`,
		});
		expect(readCredentialRef({ file: join(tmp, "nope") })).toEqual({
			error: `credential file ${join(tmp, "nope")} does not exist`,
		});
	});
});

describe("resolveLinearUserCredentials", () => {
	const helper = "/opt/cyrus/scripts/git-credential-cyrus-prompter.cjs";

	it("builds an isolated env for a fully mapped user (OAuth token)", () => {
		const claudeFile = writeSecret("ada-claude", ADA_CLAUDE);
		const result = resolveLinearUserCredentials(
			ADA,
			{
				displayName: "Ada Lovelace",
				claude: { oauthToken: { file: claudeFile } },
				github: {
					token: { env: "ADA_GH" },
					login: "ada",
					gitAuthorEmail: "ada@example.com",
				},
			},
			{ gitCredentialHelperPath: helper, env: { ADA_GH: ADA_GITHUB } },
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const { env, omitEnv, fingerprints, claudeCredentialKind } =
			result.credentials;
		expect(claudeCredentialKind).toBe("oauthToken");
		expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe(ADA_CLAUDE);
		expect(env.ANTHROPIC_API_KEY).toBeUndefined();
		// Host Claude credentials of another kind AND alternative provider /
		// enterprise-auth switches are stripped; no duplicates.
		expect(omitEnv.slice(0, 2)).toEqual([
			"ANTHROPIC_API_KEY",
			"ANTHROPIC_AUTH_TOKEN",
		]);
		expect(omitEnv).toEqual(
			expect.arrayContaining([
				"CLAUDE_CODE_USE_BEDROCK",
				"CLAUDE_CODE_USE_VERTEX",
				"GH_ENTERPRISE_TOKEN",
				"GITHUB_ENTERPRISE_TOKEN",
			]),
		);
		expect(new Set(omitEnv).size).toBe(omitEnv.length);
		expect(omitEnv).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");
		expect(env.GH_TOKEN).toBe(ADA_GITHUB);
		// GITHUB_TOKEN is overridden too, so Octokit/scripts act as the user,
		// never as the host.
		expect(env.GITHUB_TOKEN).toBe(ADA_GITHUB);
		expect(env[PROMPTER_ENV.GITHUB_TOKEN]).toBe(ADA_GITHUB);
		expect(env[PROMPTER_ENV.GITHUB_LOGIN]).toBe("ada");
		expect(env[PROMPTER_ENV.LINEAR_USER_ID]).toBe(ADA);
		expect(env.GIT_AUTHOR_NAME).toBe("Ada Lovelace");
		expect(env.GIT_COMMITTER_NAME).toBe("Ada Lovelace");
		expect(env.GIT_AUTHOR_EMAIL).toBe("ada@example.com");
		expect(env.GIT_COMMITTER_EMAIL).toBe("ada@example.com");
		// Per-session git config: reset github.com helpers, install ours,
		// and rewrite SSH remotes to HTTPS so the PAT is always the actor.
		expect(env.GIT_CONFIG_COUNT).toBe("4");
		expect(env.GIT_CONFIG_KEY_0).toBe("credential.https://github.com.helper");
		expect(env.GIT_CONFIG_VALUE_0).toBe("");
		expect(env.GIT_CONFIG_VALUE_1).toBe(`!node "${helper}"`);
		expect(env.GIT_CONFIG_KEY_2).toBe("url.https://github.com/.insteadOf");
		expect(env.GIT_CONFIG_VALUE_2).toBe("git@github.com:");
		expect(env.GIT_CONFIG_VALUE_3).toBe("ssh://git@github.com/");
		// Fingerprints are stable, short and not the secret.
		expect(fingerprints.claude).toBe(credentialFingerprint(ADA_CLAUDE));
		expect(fingerprints.claude).toHaveLength(8);
		expect(ADA_CLAUDE.includes(fingerprints.claude)).toBe(false);
	});

	it("uses ANTHROPIC_API_KEY and omits the OAuth token for API-key users", () => {
		const result = resolveLinearUserCredentials(
			BOB,
			{
				claude: { apiKey: { env: "BOB_KEY" } },
				github: { token: { env: "BOB_GH" } },
			},
			{
				gitCredentialHelperPath: helper,
				rewriteSshRemotes: false,
				env: { BOB_KEY: BOB_CLAUDE, BOB_GH: BOB_GITHUB },
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.credentials.claudeCredentialKind).toBe("apiKey");
		expect(result.credentials.env.ANTHROPIC_API_KEY).toBe(BOB_CLAUDE);
		expect(result.credentials.omitEnv.slice(0, 2)).toEqual([
			"CLAUDE_CODE_OAUTH_TOKEN",
			"ANTHROPIC_AUTH_TOKEN",
		]);
		expect(result.credentials.omitEnv).not.toContain("ANTHROPIC_API_KEY");
		expect(result.credentials.env.GIT_CONFIG_COUNT).toBe("2");
		expect(result.credentials.env.GIT_AUTHOR_NAME).toBeUndefined();
	});

	it("strips other users' env-referenced secrets and never a var it sets itself", () => {
		const users = {
			[ADA]: {
				claude: { oauthToken: { env: "ADA_CLAUDE_TOKEN" } },
				github: { token: { env: "ADA_GH_TOKEN" } },
			},
			[BOB]: {
				claude: { apiKey: { file: "/secrets/bob-claude" } },
				github: { token: { env: "BOB_GH_TOKEN" } },
			},
		};
		expect(collectEnvRefNames(users)).toEqual([
			"ADA_CLAUDE_TOKEN",
			"ADA_GH_TOKEN",
			"BOB_GH_TOKEN",
		]);
		expect(collectEnvRefNames(undefined)).toEqual([]);
		const result = resolveLinearUserCredentials(ADA, users[ADA], {
			gitCredentialHelperPath: helper,
			env: { ADA_CLAUDE_TOKEN: ADA_CLAUDE, ADA_GH_TOKEN: ADA_GITHUB },
			additionalOmitEnv: collectEnvRefNames(users),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Bob's variable is stripped from Ada's session; Ada's own ref names
		// are stripped as well (the canonical vars carry her values).
		expect(result.credentials.omitEnv).toEqual(
			expect.arrayContaining(["BOB_GH_TOKEN", "ADA_CLAUDE_TOKEN"]),
		);
		expect(result.credentials.env.CLAUDE_CODE_OAUTH_TOKEN).toBe(ADA_CLAUDE);
		expect(new Set(result.credentials.omitEnv).size).toBe(
			result.credentials.omitEnv.length,
		);
	});

	it("two users resolve to different, non-overlapping credentials", () => {
		const a = resolveLinearUserCredentials(
			ADA,
			{
				claude: { oauthToken: { env: "A_C" } },
				github: { token: { env: "A_G" } },
			},
			{
				gitCredentialHelperPath: helper,
				env: { A_C: ADA_CLAUDE, A_G: ADA_GITHUB },
			},
		);
		const b = resolveLinearUserCredentials(
			BOB,
			{
				claude: { oauthToken: { env: "B_C" } },
				github: { token: { env: "B_G" } },
			},
			{
				gitCredentialHelperPath: helper,
				env: { B_C: BOB_CLAUDE, B_G: BOB_GITHUB },
			},
		);
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.credentials.env.CLAUDE_CODE_OAUTH_TOKEN).not.toBe(
			b.credentials.env.CLAUDE_CODE_OAUTH_TOKEN,
		);
		expect(a.credentials.env.GH_TOKEN).not.toBe(b.credentials.env.GH_TOKEN);
		expect(a.credentials.fingerprints).not.toEqual(b.credentials.fingerprints);
	});

	it("reports incomplete or unreadable mappings without leaking secrets", () => {
		expect(
			resolveLinearUserCredentials(ADA, undefined, {
				gitCredentialHelperPath: helper,
			}),
		).toMatchObject({ ok: false, reason: "not-mapped" });
		expect(
			resolveLinearUserCredentials(
				ADA,
				{ github: { token: { env: "G" } } },
				{ gitCredentialHelperPath: helper, env: { G: ADA_GITHUB } },
			),
		).toMatchObject({ ok: false, reason: "missing-claude" });
		expect(
			resolveLinearUserCredentials(
				ADA,
				{ claude: { oauthToken: { env: "C" } } },
				{ gitCredentialHelperPath: helper, env: { C: ADA_CLAUDE } },
			),
		).toMatchObject({ ok: false, reason: "missing-github" });
		const unreadable = resolveLinearUserCredentials(
			ADA,
			{
				displayName: "Ada",
				claude: { oauthToken: { env: "C" } },
				github: { token: { file: join(tmp, "missing") } },
			},
			{ gitCredentialHelperPath: helper, env: { C: ADA_CLAUDE } },
		);
		expect(unreadable).toMatchObject({ ok: false, reason: "unreadable" });
		if (unreadable.ok) return;
		expect(unreadable.message).toContain("Ada");
		expect(unreadable.message).not.toContain(ADA_CLAUDE);
	});
});

describe("decideSessionCredentialUser", () => {
	const linearUsers = { [ADA]: { displayName: "Ada" } };

	it("uses the mapped prompter", () => {
		expect(
			decideSessionCredentialUser({
				linearUsers,
				prompter: { linearUserId: ADA },
			}),
		).toEqual({ action: "use-user", linearUserId: ADA, source: "prompter" });
	});

	it("rejects an unmapped human by default and never falls back silently", () => {
		const d = decideSessionCredentialUser({
			linearUsers,
			prompter: { linearUserId: BOB, name: "Bob" },
		});
		expect(d.action).toBe("reject");
		if (d.action !== "reject") return;
		expect(d.reason).toBe("not-mapped");
		expect(d.message).toContain("Bob");
		expect(d.message).toContain("cyrus add-user");
	});

	it("only uses host credentials when the operator opted in explicitly", () => {
		const d = decideSessionCredentialUser({
			linearUsers,
			policy: { unmappedPrompter: "host" },
			prompter: { linearUserId: BOB, name: "Bob" },
		});
		expect(d.action).toBe("host");
	});

	it("only NON-HUMAN sub-issue triggers inherit the parent session's mapped user", () => {
		expect(
			decideSessionCredentialUser({
				linearUsers,
				prompter: { linearUserId: "cyrus-app-user" },
				isNonHuman: true,
				parentCredentialUserId: ADA,
			}),
		).toEqual({ action: "use-user", linearUserId: ADA, source: "parent" });
		expect(
			decideSessionCredentialUser({
				linearUsers,
				prompter: undefined,
				isNonHuman: true,
				parentCredentialUserId: ADA,
			}),
		).toMatchObject({ action: "reject", reason: "non-human" });
		// An UNMAPPED HUMAN triggering a child of a mapped user's issue must not
		// borrow the parent's credentials — unmappedPrompter policy applies.
		expect(
			decideSessionCredentialUser({
				linearUsers,
				prompter: { linearUserId: BOB, name: "Bob" },
				parentCredentialUserId: ADA,
			}),
		).toMatchObject({ action: "reject", reason: "not-mapped" });
		expect(
			decideSessionCredentialUser({
				linearUsers,
				policy: { unmappedPrompter: "host" },
				prompter: { linearUserId: BOB, name: "Bob" },
				parentCredentialUserId: ADA,
			}),
		).toMatchObject({ action: "host" });
	});

	it("rejects non-human triggers without a parent mapping by default", () => {
		const d = decideSessionCredentialUser({ linearUsers, prompter: undefined });
		expect(d).toMatchObject({ action: "reject", reason: "non-human" });
		expect(
			decideSessionCredentialUser({
				linearUsers,
				policy: { nonHumanTrigger: "host" },
			}).action,
		).toBe("host");
	});
});

describe("decideFollowUpPrompt", () => {
	const linearUsers = {
		[ADA]: { displayName: "Ada" },
		[BOB]: { displayName: "Bob" },
	};
	const pinnedToAda = {
		linearUserId: ADA,
		credentialUserId: ADA,
		source: "prompter" as const,
	};

	it("continues silently for the pinned user", () => {
		expect(
			decideFollowUpPrompt({
				linearUsers,
				sessionPrompter: pinnedToAda,
				prompter: { linearUserId: ADA },
			}),
		).toEqual({ action: "continue" });
	});

	it("pins by default with a visible note when another user follows up", () => {
		const d = decideFollowUpPrompt({
			linearUsers,
			sessionPrompter: pinnedToAda,
			prompter: { linearUserId: BOB, name: "Bob" },
		});
		expect(d.action).toBe("continue");
		if (d.action !== "continue") return;
		expect(d.note).toContain("Bob");
		expect(d.note).toContain("Ada");
	});

	it("refuses the follow-up when the policy is reject", () => {
		const d = decideFollowUpPrompt({
			linearUsers,
			policy: { followUpByOtherUser: "reject" },
			sessionPrompter: pinnedToAda,
			prompter: { linearUserId: BOB, name: "Bob" },
		});
		expect(d).toMatchObject({ action: "reject" });
	});

	it("never assumes an unknown sender is the pinned user", () => {
		// No activity user and no comment author in the payload.
		const rejected = decideFollowUpPrompt({
			linearUsers,
			policy: { followUpByOtherUser: "reject" },
			sessionPrompter: pinnedToAda,
			prompter: undefined,
		});
		expect(rejected.action).toBe("reject");
		if (rejected.action !== "reject") return;
		expect(rejected.message).toContain("could not determine who sent");

		const pinned = decideFollowUpPrompt({
			linearUsers,
			sessionPrompter: pinnedToAda,
			prompter: undefined,
		});
		expect(pinned.action).toBe("continue");
		if (pinned.action !== "continue") return;
		expect(pinned.note).toContain("could not be determined");
		expect(pinned.note).toContain("Ada");
	});

	it("pins an unpinned session to a mapped prompter, else defers to new-session policy", () => {
		expect(
			decideFollowUpPrompt({ linearUsers, prompter: { linearUserId: BOB } }),
		).toEqual({ action: "pin", linearUserId: BOB });
		expect(
			decideFollowUpPrompt({ linearUsers, prompter: { linearUserId: "x" } }),
		).toEqual({ action: "decide-new" });
	});

	it("resolves policy defaults", () => {
		expect(resolvePrompterCredentialPolicy()).toEqual({
			unmappedPrompter: "reject",
			nonHumanTrigger: "reject",
			externalPlatformSessions: "host",
			followUpByOtherUser: "pin",
		});
	});
});

describe("git credential helper", () => {
	it("installs an executable helper that answers github.com with the session token", () => {
		const path = ensurePrompterGitCredentialHelper(tmp);
		expect(statSync(path).mode & 0o111).not.toBe(0);
		// Idempotent
		expect(ensurePrompterGitCredentialHelper(tmp)).toBe(path);
		expect(readFileSync(path, "utf-8")).toContain(
			"CYRUS_PROMPTER_GITHUB_TOKEN",
		);

		const run = (env: Record<string, string>, input: string) =>
			execFileSync("node", [path, "get"], {
				input,
				env: { ...env, PATH: process.env.PATH ?? "" },
				encoding: "utf-8",
			});

		expect(
			run(
				{
					CYRUS_PROMPTER_GITHUB_TOKEN: ADA_GITHUB,
					CYRUS_PROMPTER_GITHUB_LOGIN: "ada",
				},
				"protocol=https\nhost=github.com\npath=acme/widgets.git\n",
			),
		).toBe(`username=ada\npassword=${ADA_GITHUB}\n`);
		// Other hosts and sessions without a token fall through silently.
		expect(
			run(
				{ CYRUS_PROMPTER_GITHUB_TOKEN: ADA_GITHUB },
				"protocol=https\nhost=gitlab.com\n",
			),
		).toBe("");
		expect(run({}, "protocol=https\nhost=github.com\n")).toBe("");
	});

	it("git honours the per-session env: identity and credential helper, no global config touched", () => {
		const helper = ensurePrompterGitCredentialHelper(tmp);
		const result = resolveLinearUserCredentials(
			ADA,
			{
				displayName: "Ada Lovelace",
				claude: { oauthToken: { env: "C" } },
				github: {
					token: { env: "G" },
					login: "ada",
					gitAuthorEmail: "ada@example.com",
				},
			},
			{
				gitCredentialHelperPath: helper,
				env: { C: ADA_CLAUDE, G: ADA_GITHUB },
			},
		);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const env = {
			...process.env,
			...result.credentials.env,
			HOME: tmp, // isolate from the real ~/.gitconfig
			GIT_CONFIG_GLOBAL: join(tmp, "gitconfig-empty"),
			GIT_CONFIG_NOSYSTEM: "1",
		};
		writeFileSync(join(tmp, "gitconfig-empty"), "");

		const ident = execFileSync("git", ["var", "GIT_AUTHOR_IDENT"], {
			env,
			encoding: "utf-8",
		});
		expect(ident.startsWith("Ada Lovelace <ada@example.com>")).toBe(true);

		const filled = execFileSync("git", ["credential", "fill"], {
			env,
			input: "protocol=https\nhost=github.com\npath=acme/widgets.git\n\n",
			encoding: "utf-8",
		});
		expect(filled).toContain("username=ada");
		expect(filled).toContain(`password=${ADA_GITHUB}`);

		const rewritten = execFileSync(
			"git",
			["config", "--get-all", "url.https://github.com/.insteadOf"],
			{ env, encoding: "utf-8" },
		);
		expect(rewritten.trim().split("\n")).toEqual([
			"git@github.com:",
			"ssh://git@github.com/",
		]);

		// The "global" config we pointed git at is still empty: nothing was mutated.
		expect(readFileSync(join(tmp, "gitconfig-empty"), "utf-8")).toBe("");
	});
});
