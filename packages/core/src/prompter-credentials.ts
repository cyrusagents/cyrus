/**
 * Per-prompter credential resolution (CYPACK-1502).
 *
 * Multi-user self-hosted Cyrus installs map the Linear user who triggers a
 * session to that human's own Claude credential, GitHub token and Git
 * identity. `config.json` only ever holds REFERENCES to those secrets
 * (`{ env: NAME }` or `{ file: PATH }`); this module reads them at session
 * start, builds the per-session environment and decides what to do when a
 * session cannot be pinned to a mapped user.
 *
 * Nothing in this module logs or returns secret values except inside the
 * `env` map that is handed to the agent child process. Every error message
 * and fingerprint is safe to post to Linear.
 */

import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	CredentialRef,
	LinearUserConfig,
	PrompterCredentialPolicy,
} from "./config-schemas.js";
import { resolvePath } from "./config-types.js";

// ============================================================================
// Types
// ============================================================================

/** The human (Linear user) who triggered a session or a follow-up prompt. */
export interface PrompterIdentity {
	linearUserId: string;
	name?: string;
	email?: string;
}

/**
 * Persisted on `CyrusAgentSession.prompter`: who started the session and
 * which mapped user's credentials it is pinned to (they differ when a
 * sub-issue inherits its parent's user).
 */
export interface SessionPrompter extends PrompterIdentity {
	/**
	 * Linear user ID whose credentials the session runs with. Undefined only
	 * when `source` is `"host"` (operator policy explicitly allowed the host
	 * machine's credentials for this session).
	 */
	credentialUserId?: string;
	/** How the credential user was chosen. */
	source: "prompter" | "parent" | "host";
	/** Secret-free reason recorded when `source` is `"host"`. */
	hostReason?: string;
}

export type PrompterCredentialFailureReason =
	| "not-mapped"
	| "missing-claude"
	| "missing-github"
	| "unreadable";

/**
 * Fully resolved per-session credentials for one mapped Linear user.
 * `env` contains the secrets; everything else is safe to log.
 */
export interface ResolvedPrompterCredentials {
	linearUserId: string;
	displayName: string;
	claudeCredentialKind: "oauthToken" | "apiKey";
	github: {
		login?: string;
		gitAuthorName?: string;
		gitAuthorEmail?: string;
	};
	/** Environment variables to overlay on the agent child process. */
	env: Record<string, string>;
	/** Host environment variables that must NOT leak into the child process. */
	omitEnv: string[];
	/** Short, non-reversible fingerprints for evidence/logging. */
	fingerprints: { claude: string; github: string };
}

export type LinearUserCredentialResolution =
	| { ok: true; credentials: ResolvedPrompterCredentials }
	| {
			ok: false;
			reason: PrompterCredentialFailureReason;
			/** Human-readable, secret-free explanation. */
			message: string;
	  };

export type PrompterDecision =
	| { action: "use-user"; linearUserId: string; source: "prompter" | "parent" }
	| { action: "host"; reason: string }
	| {
			action: "reject";
			reason: PrompterCredentialFailureReason | "non-human";
			message: string;
	  };

export type FollowUpDecision =
	| { action: "continue"; note?: string }
	| { action: "reject"; message: string }
	| { action: "pin"; linearUserId: string }
	| { action: "decide-new" };

// ============================================================================
// Constants
// ============================================================================

/** Env var names the child process receives (documented for operators). */
export const PROMPTER_ENV = {
	LINEAR_USER_ID: "CYRUS_PROMPTER_LINEAR_USER_ID",
	NAME: "CYRUS_PROMPTER_NAME",
	GITHUB_TOKEN: "CYRUS_PROMPTER_GITHUB_TOKEN",
	GITHUB_LOGIN: "CYRUS_PROMPTER_GITHUB_LOGIN",
} as const;

const CLAUDE_AUTH_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_AUTH_TOKEN",
] as const;

/** File name of the per-session git credential helper installed under `<cyrusHome>/scripts`. */
export const PROMPTER_GIT_CREDENTIAL_HELPER_FILENAME =
	"git-credential-cyrus-prompter.cjs";

/**
 * Self-contained git credential helper. Installed by
 * {@link ensurePrompterGitCredentialHelper}; wired into git PER SESSION via
 * `GIT_CONFIG_COUNT`/`GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` env vars, so the
 * host's global git config and `gh auth` state are never mutated.
 *
 * For `get` on github.com it answers with the session's prompter token from
 * the environment. Any other host, or a session without a prompter token,
 * prints nothing and exits 0 so git falls through to other helpers.
 */
export const PROMPTER_GIT_CREDENTIAL_HELPER_SOURCE = `#!/usr/bin/env node
/**
 * git-credential-cyrus-prompter — per-session GitHub credentials for Cyrus
 * multi-user installs (CYPACK-1502). Reads the triggering human's token from
 * the session environment (CYRUS_PROMPTER_GITHUB_TOKEN); never touches the
 * host's global git/gh configuration. Managed by Cyrus — do not edit.
 */
"use strict";
const fs = require("node:fs");
function main() {
	if (process.argv[2] !== "get") return;
	const token = process.env.CYRUS_PROMPTER_GITHUB_TOKEN;
	if (!token) return;
	let input = "";
	try { input = fs.readFileSync(0, "utf8"); } catch { return; }
	const attrs = {};
	for (const line of input.split("\\n")) {
		const idx = line.indexOf("=");
		if (idx > 0) attrs[line.slice(0, idx)] = line.slice(idx + 1);
	}
	if ((attrs.host || "").toLowerCase() !== "github.com") return;
	const username = process.env.CYRUS_PROMPTER_GITHUB_LOGIN || "x-access-token";
	process.stdout.write("username=" + username + "\\npassword=" + token + "\\n");
}
main();
`;

// ============================================================================
// Credential references
// ============================================================================

/** Human-readable location of a credential reference (never the value). */
export function describeCredentialRef(ref: CredentialRef): string {
	return "env" in ref ? `env var ${ref.env}` : `file ${ref.file}`;
}

/**
 * Read the secret a reference points at. Returns `{ error }` (secret-free)
 * when the env var is unset/empty or the file is missing/empty/unreadable.
 */
export function readCredentialRef(
	ref: CredentialRef,
	env: NodeJS.ProcessEnv = process.env,
): { value: string } | { error: string } {
	if ("env" in ref) {
		const value = env[ref.env]?.trim();
		if (!value) {
			return { error: `environment variable ${ref.env} is not set` };
		}
		return { value };
	}
	const path = resolvePath(ref.file);
	if (!existsSync(path)) {
		return { error: `credential file ${ref.file} does not exist` };
	}
	try {
		const value = readFileSync(path, "utf-8").trim();
		if (!value) {
			return { error: `credential file ${ref.file} is empty` };
		}
		return { value };
	} catch (error) {
		return {
			error: `credential file ${ref.file} could not be read (${
				error instanceof Error ? error.message : String(error)
			})`,
		};
	}
}

/**
 * Short non-reversible fingerprint of a secret (first 8 hex chars of its
 * SHA-256). Safe for logs, Linear activities and test evidence; lets two
 * sessions be shown to use DIFFERENT credentials without revealing either.
 */
export function credentialFingerprint(secret: string): string {
	return createHash("sha256").update(secret).digest("hex").slice(0, 8);
}

// ============================================================================
// Resolution
// ============================================================================

export interface ResolveLinearUserOptions {
	/** Absolute path of the installed git credential helper script. */
	gitCredentialHelperPath: string;
	/**
	 * Rewrite `git@github.com:` / `ssh://git@github.com/` remotes to HTTPS for
	 * this session so pushes authenticate with the prompter's token instead of
	 * the host's SSH key. Defaults to true.
	 */
	rewriteSshRemotes?: boolean;
	/** Env to read `{ env }` refs from (defaults to `process.env`). */
	env?: NodeJS.ProcessEnv;
	/**
	 * Extra host env var names to strip from the child (typically every env
	 * var referenced by ANY mapped user, see {@link collectEnvRefNames}).
	 */
	additionalOmitEnv?: readonly string[];
}

/**
 * Host env vars that would silently route model or GitHub calls somewhere
 * other than the mapped user's credentials. Always stripped from a
 * prompter-bound session.
 */
export const ALTERNATIVE_AUTH_ENV_KEYS = [
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_MANTLE",
	"CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
	"CLAUDE_CODE_OAUTH_SCOPES",
	"ANTHROPIC_AWS_API_KEY",
	"ANTHROPIC_AWS_BASE_URL",
	"ANTHROPIC_AWS_WORKSPACE_ID",
	"ANTHROPIC_CUSTOM_HEADERS",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"ANTHROPIC_FOUNDRY_API_KEY",
	"ANTHROPIC_FOUNDRY_BASE_URL",
	"ANTHROPIC_FOUNDRY_RESOURCE",
	"CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
	"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
	"GH_HOST",
	"CYRUS_GH_TOKEN",
	"GH_ENTERPRISE_TOKEN",
	"GITHUB_ENTERPRISE_TOKEN",
] as const;

/**
 * Names of every env var referenced by any mapped user's credential refs.
 * Used to keep one user's `{ env }` secret out of another user's session
 * (and out of host-credential sessions) — process.env is otherwise
 * inherited wholesale by the agent child process.
 */
export function collectEnvRefNames(
	linearUsers: Record<string, LinearUserConfig> | undefined,
): string[] {
	const names = new Set<string>();
	for (const user of Object.values(linearUsers ?? {})) {
		for (const ref of [
			user.claude?.oauthToken,
			user.claude?.apiKey,
			user.github?.token,
		]) {
			if (ref && "env" in ref) names.add(ref.env);
		}
	}
	return [...names].sort();
}

/**
 * Resolve a mapped Linear user's config entry into per-session credentials.
 * A user is only "fully mapped" when BOTH a Claude credential and a GitHub
 * token resolve — anything less falls back to the operator's
 * `unmappedPrompter` policy rather than silently mixing host credentials in.
 */
export function resolveLinearUserCredentials(
	linearUserId: string,
	user: LinearUserConfig | undefined,
	options: ResolveLinearUserOptions,
): LinearUserCredentialResolution {
	const displayName = user?.displayName || linearUserId;
	if (!user) {
		return {
			ok: false,
			reason: "not-mapped",
			message: `Linear user ${displayName} has no entry in linearUsers`,
		};
	}

	// --- Claude ---------------------------------------------------------------
	const claudeRef = user.claude?.oauthToken ?? user.claude?.apiKey;
	const claudeKind: ResolvedPrompterCredentials["claudeCredentialKind"] = user
		.claude?.oauthToken
		? "oauthToken"
		: "apiKey";
	if (!claudeRef) {
		return {
			ok: false,
			reason: "missing-claude",
			message: `${displayName} has no Claude credential reference (claude.oauthToken or claude.apiKey)`,
		};
	}
	const claude = readCredentialRef(claudeRef, options.env);
	if ("error" in claude) {
		return {
			ok: false,
			reason: "unreadable",
			message: `${displayName}: Claude credential unreadable — ${claude.error}`,
		};
	}

	// --- GitHub ---------------------------------------------------------------
	if (!user.github?.token) {
		return {
			ok: false,
			reason: "missing-github",
			message: `${displayName} has no GitHub token reference (github.token)`,
		};
	}
	const github = readCredentialRef(user.github.token, options.env);
	if ("error" in github) {
		return {
			ok: false,
			reason: "unreadable",
			message: `${displayName}: GitHub token unreadable — ${github.error}`,
		};
	}

	// --- Environment ----------------------------------------------------------
	const env: Record<string, string> = {
		[PROMPTER_ENV.LINEAR_USER_ID]: linearUserId,
		[PROMPTER_ENV.NAME]: displayName,
	};
	const omitEnv: string[] = [];

	if (claudeKind === "oauthToken") {
		env.CLAUDE_CODE_OAUTH_TOKEN = claude.value;
	} else {
		env.ANTHROPIC_API_KEY = claude.value;
	}
	// Never let a host-level credential of another kind win over the user's.
	for (const key of CLAUDE_AUTH_ENV_KEYS) {
		if (!(key in env)) omitEnv.push(key);
	}

	// gh CLI honours GH_TOKEN over GITHUB_TOKEN and over `gh auth` state, so
	// `gh pr create` opens the PR as this human. GITHUB_TOKEN is overridden
	// too: Octokit, Actions-style scripts and most SDKs read it, and leaving
	// the host's value in place would let those act as the host. A registry
	// login that relied on the host GITHUB_TOKEN must use its own variable.
	env.GH_TOKEN = github.value;
	env.GITHUB_TOKEN = github.value;
	env[PROMPTER_ENV.GITHUB_TOKEN] = github.value;
	if (user.github.login) {
		env[PROMPTER_ENV.GITHUB_LOGIN] = user.github.login;
	}
	// Alternative provider/auth switches that would route the model call or
	// GitHub call away from this user's credentials are stripped as well.
	for (const key of ALTERNATIVE_AUTH_ENV_KEYS) {
		if (!(key in env) && !omitEnv.includes(key)) omitEnv.push(key);
	}
	// Every env var any mapped user references (other users' secrets held in
	// ~/.cyrus/.env) must not be inherited by this session either.
	for (const key of options.additionalOmitEnv ?? []) {
		if (!(key in env) && !omitEnv.includes(key)) omitEnv.push(key);
	}

	// Per-session git config via GIT_CONFIG_* env (git >= 2.31). These entries
	// are parsed last, so the empty value resets whatever helpers the host has
	// configured for github.com and ours becomes the only one — for this
	// process tree only. SSH remotes are rewritten to HTTPS so a push cannot
	// silently authenticate with the host's SSH key instead of the prompter.
	const gitConfig: Array<[string, string]> = [
		["credential.https://github.com.helper", ""],
		[
			"credential.https://github.com.helper",
			`!node "${options.gitCredentialHelperPath}"`,
		],
	];
	if (options.rewriteSshRemotes !== false) {
		gitConfig.push(["url.https://github.com/.insteadOf", "git@github.com:"]);
		gitConfig.push([
			"url.https://github.com/.insteadOf",
			"ssh://git@github.com/",
		]);
	}
	env.GIT_CONFIG_COUNT = String(gitConfig.length);
	gitConfig.forEach(([key, value], i) => {
		env[`GIT_CONFIG_KEY_${i}`] = key;
		env[`GIT_CONFIG_VALUE_${i}`] = value;
	});

	// Commit identity (author + committer) — "welcome but not essential".
	const authorName = user.github.gitAuthorName || user.displayName;
	const authorEmail = user.github.gitAuthorEmail;
	if (authorName) {
		env.GIT_AUTHOR_NAME = authorName;
		env.GIT_COMMITTER_NAME = authorName;
	}
	if (authorEmail) {
		env.GIT_AUTHOR_EMAIL = authorEmail;
		env.GIT_COMMITTER_EMAIL = authorEmail;
	}

	return {
		ok: true,
		credentials: {
			linearUserId,
			displayName,
			claudeCredentialKind: claudeKind,
			github: {
				login: user.github.login,
				gitAuthorName: authorName,
				gitAuthorEmail: authorEmail,
			},
			env,
			omitEnv,
			fingerprints: {
				claude: credentialFingerprint(claude.value),
				github: credentialFingerprint(github.value),
			},
		},
	};
}

// ============================================================================
// Policy
// ============================================================================

export type ResolvedPrompterCredentialPolicy =
	Required<PrompterCredentialPolicy>;

export function resolvePrompterCredentialPolicy(
	policy?: PrompterCredentialPolicy,
): ResolvedPrompterCredentialPolicy {
	return {
		unmappedPrompter: policy?.unmappedPrompter ?? "reject",
		nonHumanTrigger: policy?.nonHumanTrigger ?? "reject",
		externalPlatformSessions: policy?.externalPlatformSessions ?? "shared",
		followUpByOtherUser: policy?.followUpByOtherUser ?? "pin",
	};
}

/** The feature is active only when at least one Linear user is mapped. */
export function isPrompterCredentialsEnabled(
	linearUsers: Record<string, LinearUserConfig> | undefined,
): boolean {
	return !!linearUsers && Object.keys(linearUsers).length > 0;
}

export interface SessionCredentialDecisionInput {
	linearUsers: Record<string, LinearUserConfig>;
	policy?: PrompterCredentialPolicy;
	/** The triggering human, or undefined when the session has no human creator. */
	prompter?: PrompterIdentity;
	/**
	 * True when the "creator" is not a human — e.g. the creator ID equals the
	 * agent's own app user ID (Cyrus delegating a sub-issue to itself).
	 */
	isNonHuman?: boolean;
	/** Mapped user pinned on the parent issue's session, if any (sub-issues). */
	parentCredentialUserId?: string;
}

/**
 * Decide whose credentials a NEW Linear session should run with. Pure — the
 * caller reads secrets afterwards with {@link resolveLinearUserCredentials}.
 *
 * Order for a HUMAN trigger: mapped → use them; unmapped → operator policy
 * (`reject` by default; `shared` is an explicit, visible opt-in — never
 * silent). A parent session's user is never borrowed by a human.
 *
 * A NON-HUMAN trigger inherits the parent session's user only when the
 * creator is explicitly identified as Cyrus and the parent link is known.
 * This is the supported delegation provenance;
 * otherwise `nonHumanTrigger` policy applies.
 */
export function decideSessionCredentialUser(
	input: SessionCredentialDecisionInput,
): PrompterDecision {
	const policy = resolvePrompterCredentialPolicy(input.policy);
	const isMapped = (id: string) => id in input.linearUsers;
	const prompter = input.prompter;
	const human = !!prompter && !input.isNonHuman;

	if (human && isMapped(prompter.linearUserId)) {
		return {
			action: "use-user",
			linearUserId: prompter.linearUserId,
			source: "prompter",
		};
	}

	if (
		prompter &&
		input.isNonHuman === true &&
		input.parentCredentialUserId &&
		isMapped(input.parentCredentialUserId)
	) {
		return {
			action: "use-user",
			linearUserId: input.parentCredentialUserId,
			source: "parent",
		};
	}

	if (human) {
		const who = prompter.name || prompter.email || prompter.linearUserId;
		if (policy.unmappedPrompter === "shared") {
			return {
				action: "host",
				reason: `${who} has no personal credentials configured; the operator allows shared instance credentials`,
			};
		}
		return {
			action: "reject",
			reason: "not-mapped",
			message: `No execution credentials are mapped for ${who} (Linear user ${prompter.linearUserId}). Ask the Cyrus operator to run \`cyrus add-user\` for you, then start a new session.`,
		};
	}

	if (policy.nonHumanTrigger === "shared") {
		return {
			action: "host",
			reason:
				"session has no human creator; the operator allows shared instance credentials",
		};
	}
	return {
		action: "reject",
		reason: "non-human",
		message:
			"This session was not started by a mapped human and has no parent session to inherit credentials from, so Cyrus will not run it with shared instance credentials. Re-trigger it from a mapped Linear user or set prompterCredentialPolicy.nonHumanTrigger.",
	};
}

export interface FollowUpDecisionInput {
	linearUsers: Record<string, LinearUserConfig>;
	policy?: PrompterCredentialPolicy;
	/** Current pin on the session (undefined if none yet). */
	sessionPrompter?: SessionPrompter;
	/** The human sending the follow-up prompt (undefined if unknown). */
	prompter?: PrompterIdentity;
}

/**
 * Decide what to do when an EXISTING session receives a prompt.
 *
 * - Same user as the pin → continue silently.
 * - Different user, policy `pin` (default) → continue on the ORIGINAL
 *   user's credentials with a visible note. Rationale: a running agent
 *   process cannot swap credentials mid-turn, and the person who opened
 *   the session stays accountable for the PR it produces. This is a
 *   PROPOSED default, not an approved product decision — see docs.
 * - Different user, policy `reject` → refuse; the other user starts their
 *   own session.
 * - No pin yet (session predates the mapping) → pin to the prompter if
 *   mapped, else `decide-new` (caller applies `decideSessionCredentialUser`).
 */
export function decideFollowUpPrompt(
	input: FollowUpDecisionInput,
): FollowUpDecision {
	const policy = resolvePrompterCredentialPolicy(input.policy);
	const pinned = input.sessionPrompter?.credentialUserId;
	const prompter = input.prompter;

	// A session the operator's policy explicitly placed on host credentials
	// stays there; switching to a user's credentials mid-session would make
	// attribution depend on who spoke last.
	if (input.sessionPrompter?.source === "host") {
		return {
			action: "continue",
			note: `This session runs with shared instance credentials (${input.sessionPrompter.hostReason ?? "operator policy"}); the prompt was applied without changing that.`,
		};
	}

	if (!pinned) {
		if (prompter && prompter.linearUserId in input.linearUsers) {
			return { action: "pin", linearUserId: prompter.linearUserId };
		}
		return { action: "decide-new" };
	}

	const pinnedName = input.linearUsers[pinned]?.displayName || pinned;

	// Unknown sender (payload carried no activity user and no comment author):
	// never assume it was the pinned user. Fail closed under `reject`; under
	// `pin` continue on the pinned credentials and say the sender is unknown.
	if (!prompter) {
		if (policy.followUpByOtherUser === "reject") {
			return {
				action: "reject",
				message: `Cyrus could not determine who sent this prompt (the Linear payload carried no author) and prompterCredentialPolicy.followUpByOtherUser is \`reject\`, so it was not applied to the session pinned to ${pinnedName}'s credentials. Re-send the prompt from your own Linear account or start a new session.`,
			};
		}
		return {
			action: "continue",
			note: `Prompt applied to a session pinned to ${pinnedName}'s credentials; the sender's Linear identity could not be determined from the payload (prompterCredentialPolicy.followUpByOtherUser=pin). Commits, pushes and PRs continue to be attributed to ${pinnedName}.`,
		};
	}

	if (prompter.linearUserId === pinned) {
		return { action: "continue" };
	}

	const who = prompter.name || prompter.email || prompter.linearUserId;
	if (policy.followUpByOtherUser === "reject") {
		return {
			action: "reject",
			message: `This session runs with ${pinnedName}'s credentials and prompterCredentialPolicy.followUpByOtherUser is \`reject\`, so a prompt from ${who} cannot be applied here. Start a new session (@mention Cyrus or delegate the issue) to work under your own credentials.`,
		};
	}
	return {
		action: "continue",
		note: `Prompt from ${who} applied to a session pinned to ${pinnedName}'s credentials (prompterCredentialPolicy.followUpByOtherUser=pin). Commits, pushes and PRs from this session continue to be attributed to ${pinnedName}.`,
	};
}

// ============================================================================
// Helper installation
// ============================================================================

/**
 * Install (or refresh) the per-session git credential helper at
 * `<cyrusHome>/scripts/git-credential-cyrus-prompter.cjs`. Idempotent.
 * Returns the absolute path.
 */
export function ensurePrompterGitCredentialHelper(cyrusHome: string): string {
	const dir = join(cyrusHome, "scripts");
	const target = join(dir, PROMPTER_GIT_CREDENTIAL_HELPER_FILENAME);
	mkdirSync(dir, { recursive: true });
	let current: string | null = null;
	try {
		current = readFileSync(target, "utf-8");
	} catch {
		current = null;
	}
	if (current !== PROMPTER_GIT_CREDENTIAL_HELPER_SOURCE) {
		writeFileSync(target, PROMPTER_GIT_CREDENTIAL_HELPER_SOURCE, {
			mode: 0o755,
		});
	}
	chmodSync(target, 0o755);
	return target;
}

/** Default location of the helper without installing it. */
export function getPrompterGitCredentialHelperPath(cyrusHome: string): string {
	return join(cyrusHome, "scripts", PROMPTER_GIT_CREDENTIAL_HELPER_FILENAME);
}
