#!/usr/bin/env node
/**
 * git-credential-cyrus — git credential helper for multi-org GitHub access.
 *
 * Node script using the bundled managed-github-auth.cjs policy. Installed at
 * `<cyrusHome>/scripts/git-credential-cyrus.cjs` and wired into git via:
 *
 *   git config --global credential."https://github.com".useHttpPath true
 *   git config --global --replace-all credential."https://github.com".helper ""
 *   git config --global --add credential."https://github.com".helper "!node <this file>"
 *
 * For `get` operations against github.com it looks up the org (first path
 * segment) in `<cyrusHome>/github-tokens.json` — the per-installation
 * GitHub App tokens pushed by cyrus-hosted — and prints credentials for a
 * case-insensitive org match. Managed misses return quit=true to stop later
 * helpers/keyrings/prompts. Only an absent, never-enrolled store permits
 * unmanaged credential fallback.
 */
"use strict";

const fs = require("node:fs");

function main() {
	// Only the `get` operation produces credentials; `store`/`erase` are no-ops.
	if (process.argv[2] !== "get") return;

	let input = "";
	try {
		input = fs.readFileSync(0, "utf8");
	} catch {
		return;
	}

	const attrs = {};
	for (const line of input.split("\n")) {
		const idx = line.indexOf("=");
		if (idx > 0) {
			attrs[line.slice(0, idx)] = line.slice(idx + 1);
		}
	}

	if ((attrs.host || "").toLowerCase() !== "github.com") return;

	// With credential.useHttpPath=true git sends e.g. path=owner/repo.git
	const org = (attrs.path || "").split("/")[0] || "";

	let auth;
	let resolveManagedToken;
	try {
		const policy = require("./managed-github-auth.cjs");
		auth = policy.loadManagedAuth();
		resolveManagedToken = policy.resolveManagedToken;
	} catch {
		process.stdout.write("quit=true\n");
		return;
	}
	if (!auth.managed) return;
	const token = resolveManagedToken(auth.tokens, org);
	if (!token) {
		// An empty response would permit later keyring helpers and askpass prompts.
		process.stdout.write("quit=true\n");
		return;
	}

	process.stdout.write(`username=x-access-token\npassword=${token}\n`);
}

main();
