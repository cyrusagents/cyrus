import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitHubTokenStore } from "cyrus-core";
import {
	type ApiResponse,
	type GitHubTokensPayload,
	GitHubTokensPayloadSchema,
} from "../types.js";

/** Path of the bundled credential helper script within this package */
function bundledHelperPath(): string {
	// Resolves from both src/handlers (tests) and dist/handlers (published)
	// to <package root>/scripts/git-credential-cyrus.cjs.
	const here = dirname(fileURLToPath(import.meta.url));
	return join(here, "..", "..", "scripts", "git-credential-cyrus.cjs");
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
	const scriptDir = join(cyrusHome, "scripts");
	const scriptDest = join(scriptDir, "git-credential-cyrus.cjs");

	mkdirSync(scriptDir, { recursive: true });
	copyFileSync(bundledHelperPath(), scriptDest);
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
 * Handle a GitHub installation tokens push from cyrus-hosted.
 *
 * Persists the per-installation tokens to `<cyrusHome>/github-tokens.json`
 * (atomically, mode 0600) and ensures the git credential helper is
 * installed so concurrent git operations against different GitHub orgs
 * each authenticate with the right token.
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

	return {
		success: true,
		message: "GitHub installation tokens updated successfully",
		data: {
			tokensCount: payload.tokens.length,
		},
	};
}
