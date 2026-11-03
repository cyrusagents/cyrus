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

/** Install shared policy before either consumer; retain enrollment on deletion. */
function ensureManagedAuthPolicy(cyrusHome: string): void {
	const scripts = join(cyrusHome, "scripts");
	mkdirSync(scripts, { recursive: true });
	writeFileSync(join(cyrusHome, "github-auth-managed"), "1\n", { mode: 0o600 });
	copyFileSync(
		bundledScriptPath("managed-github-auth.cjs"),
		join(scripts, "managed-github-auth.cjs"),
	);
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
	ensureManagedAuthPolicy(cyrusHome);
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
export function ensureGitHubCredentialHelper(cyrusHome: string): string {
	ensureManagedAuthPolicy(cyrusHome);
	const scriptDir = join(cyrusHome, "scripts");
	const scriptDest = join(scriptDir, "git-credential-cyrus.cjs");

	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(bundledScriptPath("git-credential-cyrus.cjs"), scriptDest);
	chmodSync(scriptDest, 0o755);

	const credentialKey = "credential.https://github.com";
	const git = (args: string[]): void => {
		execFileSync("git", args, { stdio: "ignore" });
	};

	// Pass the repo path to the helper so it can resolve the org.
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

	return scriptDest;
}

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
 * No-op when no wrapper exists (self-host), it already has the managed
 * fence, or it has an unrecognized shape.
 */
export function ensureGhWrapperSupportsCyrusToken(
	homeDir: string = homedir(),
): boolean {
	const wrapperPath = join(homeDir, ".local", "bin", "gh");
	if (!existsSync(wrapperPath)) return false;

	const current = readFileSync(wrapperPath, "utf8");
	// Only rewrite the known droplet wrapper shapes (the original
	// strip-everything wrapper and the interim CYRUS_GH_TOKEN one), and
	// upgrade the first-generation resolver wrapper too.
	if (
		current.includes("Cyrus managed auth v2") ||
		!current.includes("/usr/bin/gh")
	) {
		return false;
	}

	const updated = `#!/usr/bin/env bash
# Cyrus managed auth v2: no cached-auth fallback if the resolver is unavailable.
CYRUS_AUTH_HOME="\${CYRUS_HOME:-$HOME/.cyrus}"
RESOLVER="$CYRUS_AUTH_HOME/scripts/gh-cyrus.cjs"
if [ -f "$RESOLVER" ]; then
  exec node "$RESOLVER" "$@"
fi
if [ -e "$CYRUS_AUTH_HOME/github-tokens.json" ] || [ -e "$CYRUS_AUTH_HOME/github-auth-managed" ]; then
  echo "gh-cyrus: managed credential resolver unavailable" >&2
  exit 1
fi
exec /usr/bin/gh "$@"
`;
	writeFileSync(wrapperPath, updated, { mode: 0o755 });
	return true;
}

/**
 * Handle a GitHub installation tokens push from cyrus-hosted.
 *
 * Persists the per-installation tokens to `<cyrusHome>/github-tokens.json`
 * (atomically, mode 0600), ensures the git credential helper is installed
 * so concurrent git operations against different GitHub orgs each
 * authenticate with the right token. gh uses per-invocation resolution; no
 * installation token is persisted into native gh hosts/keyring storage.
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
		ensureGitHubCredentialHelper(cyrusHome);
	} catch (error) {
		return {
			success: false,
			error: "Failed to configure git credential helper",
			details: error instanceof Error ? error.message : String(error),
		};
	}

	try {
		ensureGhTokenResolver(cyrusHome);
		ensureGhWrapperSupportsCyrusToken(dirname(cyrusHome));
	} catch {
		// Delivery is not complete when the authentication fence cannot be installed.
		return {
			success: false,
			error: "Failed to configure managed gh authentication",
		};
	}

	return {
		success: true,
		message: "GitHub installation tokens updated successfully",
		data: {
			tokensCount: payload.tokens.length,
			ghAuthConfigured: false,
			ghResolverInstalled: true,
		},
	};
}
