#!/usr/bin/env node
/**
 * git-credential-cyrus — git credential helper for multi-org GitHub access.
 *
 * An explicit CYRUS_GITHUB_USER_ID selects only that personal entry from
 * the shared store, failing closed on missing/revoked credentials. Otherwise
 * installation-token selection below is unchanged.
 *
 * Self-contained Node script (no dependencies). Installed by Cyrus at
 * `<cyrusHome>/scripts/git-credential-cyrus.cjs` and wired into git via:
 *
 *   git config --global credential."https://github.com".useHttpPath true
 *   git config --global --replace-all credential."https://github.com".helper ""
 *   git config --global --add credential."https://github.com".helper "!node <this file>"
 *
 * For `get` operations against github.com it looks up the org (first path
 * segment) in `<cyrusHome>/github-tokens.json` — the per-installation
 * GitHub App tokens pushed by cyrus-hosted — and prints credentials for a
 * case-insensitive org match. If no org matches but exactly one non-expired
 * token exists, that token is used. Otherwise it prints nothing and exits 0
 * so git falls through to other helpers / prompts.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { personalToken } = require("./personal-token.cjs");

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

	try {
		const token = personalToken();
		if (token !== undefined) {
			process.stdout.write(`username=x-access-token\npassword=${token}\n`);
			return;
		}
	} catch (error) {
		console.error(error.message);
		// Git's quit flag prevents any later helper or interactive fallback.
		process.stdout.write("quit=true\n");
		process.exitCode = 1;
		return;
	}

	// With credential.useHttpPath=true git sends e.g. path=owner/repo.git
	const org = (attrs.path || "").split("/")[0] || "";

	const cyrusHome = process.env.CYRUS_HOME || path.join(os.homedir(), ".cyrus");
	const tokensFile = path.join(cyrusHome, "github-tokens.json");

	let tokens = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(tokensFile, "utf8"));
		if (Array.isArray(parsed.tokens)) tokens = parsed.tokens;
	} catch {
		return;
	}

	const now = Date.now();
	const valid = tokens.filter((t) => {
		if (!t || typeof t.token !== "string" || t.token.length === 0) return false;
		const expiresAt = Date.parse(t.expiresAt);
		return !Number.isNaN(expiresAt) && expiresAt > now;
	});

	let match;
	if (org) {
		const lowered = org.toLowerCase();
		match = valid.find(
			(t) =>
				typeof t.organization === "string" &&
				t.organization.toLowerCase() === lowered,
		);
	}
	if (!match && valid.length === 1) {
		match = valid[0];
	}
	if (!match) return;

	process.stdout.write(`username=x-access-token\npassword=${match.token}\n`);
}

main();
