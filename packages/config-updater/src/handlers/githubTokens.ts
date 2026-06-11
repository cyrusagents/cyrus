import { execFileSync } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubTokenStore } from "cyrus-core";
import {
	type ApiResponse,
	type GitHubTokensPayload,
	GitHubTokensPayloadSchema,
} from "../types.js";

/** Path of a bundled script within this package's scripts/ directory */
function bundledScriptPath(scriptName: string): string {
	// Resolves from both src/handlers (tests) and dist/handlers (published)
	// to <package root>/scripts/<scriptName>.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "scripts", scriptName);
}

/**
 * Install the per-invocation gh token resolver to
 * `<cyrusHome>/scripts/gh-cyrus.cjs`. The droplet's `~/.local/bin/gh`
 * wrapper execs into it so each gh command authenticates with the
 * installation token for the org it targets (explicit -R/--repo arg, else
 * the cwd's origin remote) — required for multi-repo sessions that span
 * GitHub orgs. Idempotent.
 */
export function ensureGhTokenResolver(cyrusHome: string): string {
	const scriptDir = join(cyrusHome, "scripts");
	const scriptDest = join(scriptDir, "gh-cyrus.cjs");
	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(bundledScriptPath("gh-cyrus.cjs"), scriptDest);
	chmodSync(scriptDest, 0o755);
	return scriptDest;
}

/**
 * Install the Cyrus git credential helper and wire it into the global git
 * config for github.com. Idempotent — safe to run on every token push and
 * on EdgeWorker startup.
 *
 * - Copies the self-contained helper script to
 *   `<cyrusHome>/scripts/git-credential-cyrus.cjs` (executable).
 * - Enables `credential."https://github.com".useHttpPath` so git passes the
 *   repo path (and thus the org) to the helper.
 * - Replaces any inherited helpers for github.com (e.g. gh's keyring helper)
 *   with an empty entry followed by the Cyrus helper. Helper values must be
 *   prefixed with `!` to invoke an arbitrary command — without it git would
 *   look for a `git credential-<name>` binary.
 *
 * Returns the absolute path of the installed helper script.
 */
export function ensureGitCredentialHelper(cyrusHome: string): string {
	const scriptDir = join(cyrusHome, "scripts");
	const scriptDest = join(scriptDir, "git-credential-cyrus.cjs");

	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(bundledScriptPath("git-credential-cyrus.cjs"), scriptDest);
	chmodSync(scriptDest, 0o755);

	const git = (args: string[]): void => {
		execFileSync("git", args, { stdio: "ignore" });
	};

	for (const host of ["github.com", "gitlab.com"]) {
		const credentialKey = `credential.https://${host}`;
		// Pass the repo path to the helper so it can resolve org/group namespaces.
		git(["config", "--global", `${credentialKey}.useHttpPath`, "true"]);
		// Clear inherited helpers (an empty value resets git's helper list for
		// this key). --replace-all also makes repeated runs idempotent: every
		// call ends with exactly ["", "!node <script>"].
		git(["config", "--global", "--replace-all", `${credentialKey}.helper`, ""]);
		// Quote the script path — helper commands are run through the shell.
		git([
			"config",
			"--global",
			"--add",
			`${credentialKey}.helper`,
			`!node "${scriptDest}"`,
		]);
	}

	return scriptDest;
}

export const ensureGitHubCredentialHelper = ensureGitCredentialHelper;

/**
 * Self-heal the droplet's `~/.local/bin/gh` wrapper to exec the Cyrus gh
 * token resolver.
 *
 * Droplet images bake a gh wrapper that strips injected GH_TOKEN /
 * GITHUB_TOKEN env vars. The current design routes gh through
 * `<cyrusHome>/scripts/gh-cyrus.cjs`, which resolves the installation
 * token PER INVOCATION for the org the command targets (multi-repo
 * sessions span orgs, so a session-wide token is not enough). Droplets
 * provisioned from older images keep their baked wrapper until rebuilt;
 * since the wrapper lives in the cyrus user's home, rewrite it here on
 * token pushes — making per-org gh independent of the image rollout.
 * No-op when no wrapper exists (self-host), it already execs the
 * resolver, or it has an unrecognized shape.
 */
export function ensureGhWrapperSupportsCyrusToken(
	homeDir: string = homedir(),
): boolean {
	const wrapperPath = join(homeDir, ".local", "bin", "gh");
	if (!existsSync(wrapperPath)) return false;

	const current = readFileSync(wrapperPath, "utf8");
	// Only rewrite the known droplet wrapper shapes (the original
	// strip-everything wrapper and the interim CYRUS_GH_TOKEN one), and
	// only when they predate the resolver.
	if (current.includes("gh-cyrus.cjs") || !current.includes("/usr/bin/gh")) {
		return false;
	}

	const updated = `#!/usr/bin/env bash
# Cyrus-managed gh wrapper. The resolver picks the GitHub App installation
# token for the org each command targets (multi-org support); without it,
# strip injected tokens so gh falls back to its own stored auth.
RESOLVER="$HOME/.cyrus/scripts/gh-cyrus.cjs"
if [ -f "$RESOLVER" ]; then
  exec node "$RESOLVER" "$@"
fi
if [ -n "\${CYRUS_GH_TOKEN:-}" ]; then
  exec env -u GITHUB_TOKEN GH_TOKEN="$CYRUS_GH_TOKEN" /usr/bin/gh "$@"
fi
exec env -u GITHUB_TOKEN -u GH_TOKEN /usr/bin/gh "$@"
`;
	writeFileSync(wrapperPath, updated, { mode: 0o755 });
	return true;
}

export function ensureGlabWrapperSupportsCyrusToken(
	homeDir: string = homedir(),
): boolean {
	if (!existsSync("/usr/bin/glab")) return false;

	const binDir = join(homeDir, ".local", "bin");
	const wrapperPath = join(binDir, "glab");
	const desired = `#!/usr/bin/env bash
if [ -n "\${CYRUS_GITLAB_TOKEN:-}" ]; then
  exec env GITLAB_TOKEN="$CYRUS_GITLAB_TOKEN" /usr/bin/glab "$@"
fi
exec env -u GITLAB_TOKEN /usr/bin/glab "$@"
`;

	if (existsSync(wrapperPath)) {
		const current = readFileSync(wrapperPath, "utf8");
		if (current === desired) return false;
	}

	mkdirSync(binDir, { recursive: true });
	writeFileSync(wrapperPath, desired, { mode: 0o755 });
	return true;
}

/**
 * Authenticate the `gh` CLI with a pushed installation token.
 *
 * The droplet-local token refresh service used to run `gh auth login` every
 * 20 minutes; with refresh moved to cyrus-hosted, this keeps bare `gh`
 * usage (outside sessions, and sessions on droplet images whose gh wrapper
 * strips GH_TOKEN) authenticated. Multi-org correctness comes from the
 * per-session GH_TOKEN env var; this default uses the first token, which is
 * exact for single-installation teams. Refreshed on every token push.
 *
 * Non-fatal by design — self-host machines may not have `gh` installed.
 */
export function configureGhCliAuth(token: string): void {
	execFileSync("gh", ["auth", "login", "--with-token"], {
		input: token,
		stdio: ["pipe", "ignore", "ignore"],
	});
}

/**
 * Handle a GitHub installation tokens push from cyrus-hosted.
 *
 * Persists the per-installation tokens to `<cyrusHome>/github-tokens.json`
 * (atomically, mode 0600), ensures the git credential helper is installed
 * so concurrent git operations against different GitHub orgs each
 * authenticate with the right token, and refreshes the `gh` CLI's stored
 * auth with the first pushed token.
 *
 * @param rawPayload - Unvalidated payload from the request
 * @param cyrusHome - Path to the Cyrus home directory
 */
export async function handleGitHubTokens(
	rawPayload: unknown,
	cyrusHome: string,
): Promise<ApiResponse> {
	const parseResult = GitHubTokensPayloadSchema.safeParse(rawPayload);
	if (!parseResult.success) {
		const firstIssue = parseResult.error.issues[0];
		const path = firstIssue?.path.join(".") || "unknown";
		const message = firstIssue?.message || "Invalid payload";
		return {
			success: false,
			error: "GitHub tokens payload validation failed",
			details: `${path}: ${message}`,
		};
	}

	const payload: GitHubTokensPayload = parseResult.data;

	// Persist the tokens first — even if git configuration fails below, the
	// EdgeWorker can still resolve tokens from the store for API calls.
	try {
		new GitHubTokenStore(cyrusHome).save(payload.tokens);
	} catch (error) {
		return {
			success: false,
			error: "Failed to save GitHub tokens",
			details: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		ensureGitCredentialHelper(cyrusHome);
	} catch (error) {
		return {
			success: false,
			error: "Failed to configure git credential helper",
			details: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		ensureGhTokenResolver(cyrusHome);
	} catch (error) {
		// Non-fatal: gh falls back to CYRUS_GH_TOKEN / hosts.yml auth.
		console.warn(
			"[githubTokens] gh token resolver install failed:",
			error instanceof Error ? error.message : String(error),
		);
	}

	try {
		// cyrusHome is <home>/.cyrus on droplets, so the wrapper lives at
		// <parent of cyrusHome>/.local/bin/gh. Using the parent (rather than
		// os.homedir()) keeps this no-op for custom cyrus-home layouts and
		// hermetic in tests.
		ensureGhWrapperSupportsCyrusToken(dirname(cyrusHome));
	} catch (error) {
		// Non-fatal: the wrapper rewrite is a droplet-only nicety.
		console.warn(
			"[githubTokens] gh wrapper self-heal failed:",
			error instanceof Error ? error.message : String(error),
		);
	}

	let ghAuthConfigured = false;
	const firstToken = payload.tokens[0]?.token;
	if (firstToken) {
		try {
			configureGhCliAuth(firstToken);
			ghAuthConfigured = true;
		} catch (error) {
			// Non-fatal: gh may not be installed (self-host), and git auth via
			// the credential helper is unaffected.
			console.warn(
				"[githubTokens] gh CLI auth refresh failed:",
				error instanceof Error ? error.message : String(error),
			);
		}
	}

	return {
		success: true,
		message: "GitHub installation tokens updated successfully",
		data: {
			tokensCount: payload.tokens.length,
			ghAuthConfigured,
		},
	};
}
