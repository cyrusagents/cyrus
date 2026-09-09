#!/usr/bin/env node
/**
 * gh-cyrus — per-invocation GitHub token resolution for the `gh` CLI.
 *
 * Installed by Cyrus at `<cyrusHome>/scripts/gh-cyrus.cjs`; the droplet's
 * `~/.local/bin/gh` wrapper execs into it. Multi-repo agent sessions can
 * span repositories from DIFFERENT GitHub orgs, so a session-wide token is
 * not enough — each gh invocation must authenticate with the installation
 * token for the org it actually targets, mirroring how the Cyrus git
 * credential helper resolves tokens per git invocation.
 *
 * Resolution order for the target org:
 *   1. An explicit `-R` / `--repo` argument (strongest signal).
 *   2. The cwd's `remote.origin.url` (how gh itself infers "the current
 *      repository").
 * Then the token, from `<cyrusHome>/github-tokens.json` (pushed by
 * cyrus-hosted):
 *   3. The org-matched token.
 *   4. `CYRUS_GH_TOKEN` from the session env (set to the session's primary
 *      repository's org token — covers repo-less commands like `gh api`).
 *   5. The single valid token, when exactly one exists.
 *   6. No token: fall through to gh's own stored auth (hosts.yml).
 *
 * In every case the customer-controlled GITHUB_TOKEN / GH_TOKEN env vars
 * are removed from gh's environment (the wrapper's historical contract);
 * they remain untouched for every other tool in the session.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** Extract the owner/org from common GitHub repo references. */
function ownerFromRepoRef(ref) {
	if (!ref || typeof ref !== "string") return "";
	let rest = ref.trim();
	// Full URLs: https://github.com/owner/repo(.git), ssh://git@github.com/...
	const urlMatch = rest.match(/^[a-z+]+:\/\/[^/]*github\.com\/(.+)$/i);
	if (urlMatch) rest = urlMatch[1];
	// scp-style: git@github.com:owner/repo.git
	const scpMatch = rest.match(/^git@github\.com:(.+)$/i);
	if (scpMatch) rest = scpMatch[1];
	// HOST/OWNER/REPO form accepted by --repo
	const hostMatch = rest.match(/^github\.com\/(.+)$/i);
	if (hostMatch) rest = hostMatch[1];
	const segments = rest.split("/").filter(Boolean);
	// OWNER/REPO (or deeper); a bare OWNER is not a repo reference.
	if (segments.length >= 2) return segments[0];
	return "";
}

/** Find an explicit -R/--repo argument in the gh arg list. */
function ownerFromArgs(args) {
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") break;
		if (arg === "-R" || arg === "--repo") {
			return ownerFromRepoRef(args[i + 1]);
		}
		if (arg.startsWith("--repo=")) {
			return ownerFromRepoRef(arg.slice("--repo=".length));
		}
		if (arg.startsWith("-R=")) {
			return ownerFromRepoRef(arg.slice("-R=".length));
		}
	}
	return "";
}

/** Owner of the cwd's origin remote, or "" when not in a GitHub repo. */
function ownerFromCwd() {
	const result = spawnSync(
		"git",
		["config", "--get", "remote.origin.url"],
		{ encoding: "utf8" },
	);
	if (result.status !== 0) return "";
	return ownerFromRepoRef((result.stdout || "").trim());
}

/** Non-expired tokens from the Cyrus token store file. */
function loadValidTokens() {
	const cyrusHome =
		process.env.CYRUS_HOME || path.join(os.homedir(), ".cyrus");
	const tokensFile = path.join(cyrusHome, "github-tokens.json");
	let tokens = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
		if (Array.isArray(parsed.tokens)) tokens = parsed.tokens;
	} catch {
		return [];
	}
	const now = Date.now();
	return tokens.filter((t) => {
		if (!t || typeof t.token !== "string" || t.token.length === 0)
			return false;
		const expiresAt = Date.parse(t.expiresAt);
		return !Number.isNaN(expiresAt) && expiresAt > now;
	});
}

function resolveToken(args) {
	const owner = ownerFromArgs(args) || ownerFromCwd();
	const valid = loadValidTokens();

	if (owner) {
		const lowered = owner.toLowerCase();
		const match = valid.find(
			(t) =>
				typeof t.organization === "string" &&
				t.organization.toLowerCase() === lowered,
		);
		if (match) return match.token;
	}
	if (process.env.CYRUS_GH_TOKEN) return process.env.CYRUS_GH_TOKEN;
	if (valid.length === 1) return valid[0].token;
	return undefined;
}

function main() {
	const args = process.argv.slice(2);

	// Strip the customer-controlled token vars from gh's env (historical
	// wrapper contract); set GH_TOKEN only when Cyrus resolved a token.
	const env = { ...process.env };
	delete env.GITHUB_TOKEN;
	delete env.GH_TOKEN;
	const token = resolveToken(args);
	if (token) env.GH_TOKEN = token;

	const ghBin = process.env.CYRUS_GH_REAL_BIN || "/usr/bin/gh";
	const result = spawnSync(ghBin, args, { stdio: "inherit", env });
	if (result.error) {
		console.error(`gh-cyrus: failed to run ${ghBin}: ${result.error.message}`);
		process.exit(127);
	}
	process.exit(result.status ?? 1);
}

main();
