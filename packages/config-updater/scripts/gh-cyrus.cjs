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
 *   2. A positional repository for `repo view`, `clone`, or `fork`.
 *   3. GH_REPO, then the cwd's `remote.origin.url` (how gh infers "the current
 *      repository").
 * A managed store is authoritative. Explicit owners require an org match;
 * repo-less commands may use a still-current session hint or a single token.
 * Missing/expired/removed credentials refuse before native gh can consult
 * hosts.yml or a keyring. With no store/enrollment, unmanaged auth is untouched.
 */
"use strict";

const { spawnSync } = require("node:child_process");
const {
	loadManagedAuth,
	resolveManagedToken,
} = require("./managed-github-auth.cjs");

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
		if (arg.startsWith("-R") && arg.length > 2) {
			return ownerFromRepoRef(arg.slice(2));
		}
	}
	return ownerFromPositionalRepo(args);
}

/** Parse only commands whose first positional argument is a repository.
 * Do not scan arbitrary argument text: branch names, titles, and clone
 * destinations can all look like OWNER/REPO without selecting a repository.
 */
function ownerFromPositionalRepo(args) {
	if (args[0] !== "repo") return "";
	const valueFlags = {
		view: new Set([
			"--branch",
			"-b",
			"--json",
			"--jq",
			"-q",
			"--template",
			"-t",
		]),
		clone: new Set(["--upstream-remote-name", "-u"]),
		fork: new Set(["--fork-name", "--org", "--remote-name"]),
	}[args[1]];
	if (!valueFlags) return "";
	for (let i = 2; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--") {
			// clone/fork forward everything after -- as git flags.
			return args[1] === "view" ? ownerFromRepoRef(args[i + 1]) : "";
		}
		if (valueFlags.has(arg)) {
			i++;
			continue;
		}
		if (arg.startsWith("-")) continue;
		return ownerFromRepoRef(arg);
	}
	return "";
}

/** Owner of the cwd's origin remote, or "" when not in a GitHub repo. */
function ownerFromCwd() {
	const result = spawnSync("git", ["config", "--get", "remote.origin.url"], {
		encoding: "utf8",
	});
	if (result.status !== 0) return "";
	return ownerFromRepoRef((result.stdout || "").trim());
}

/** Explicit REST repo/org targets override cwd and session hints. */
function ownerFromApi(args, repositoryOwner) {
	if (args[0] !== "api") return "";
	const valueFlags = new Set([
		"--method",
		"-X",
		"--header",
		"-H",
		"--field",
		"-F",
		"--raw-field",
		"-f",
		"--hostname",
		"--input",
		"--jq",
		"-q",
		"--template",
		"-t",
		"--cache",
	]);
	for (let i = 1; i < args.length; i++) {
		if (valueFlags.has(args[i])) {
			i++;
			continue;
		}
		if (args[i].startsWith("-")) continue;
		const match = args[i].match(
			/^(?:https:\/\/api\.github\.com)?\/?(?:repos|orgs)\/([^/?#]+)/i,
		);
		if (!match) return "";
		// gh expands {owner} using its repository context. Keep an unresolved
		// placeholder explicit so it cannot fall back to the single/session token.
		return repositoryOwner
			? match[1].replaceAll("{owner}", repositoryOwner)
			: match[1];
	}
	return "";
}

function main() {
	const args = process.argv.slice(2);

	const env = { ...process.env };
	const auth = loadManagedAuth();
	if (auth.managed && args.length === 1 && args[0] === "--version") {
		// The health handler probes installation separately from authentication.
		// Native gh --version does not contact GitHub or inspect stored auth.
		delete env.GITHUB_TOKEN;
		delete env.GH_TOKEN;
		delete env.CYRUS_GH_TOKEN;
	} else if (auth.managed) {
		const repositoryOwner =
			ownerFromArgs(args) || ownerFromRepoRef(env.GH_REPO) || ownerFromCwd();
		const owner = ownerFromApi(args, repositoryOwner) || repositoryOwner;
		const token = resolveManagedToken(auth.tokens, owner, env.CYRUS_GH_TOKEN);
		if (!token) {
			console.error(
				"gh-cyrus: no current managed GitHub credential for this command",
			);
			process.exit(1);
		}
		delete env.GITHUB_TOKEN;
		delete env.CYRUS_GH_TOKEN;
		env.GH_TOKEN = token;
	}

	const ghBin = process.env.CYRUS_GH_REAL_BIN || "/usr/bin/gh";
	const result = spawnSync(ghBin, args, { stdio: "inherit", env });
	if (result.error) {
		console.error(`gh-cyrus: failed to run ${ghBin}: ${result.error.message}`);
		process.exit(127);
	}
	process.exit(result.status ?? 1);
}

main();
