#!/usr/bin/env node
/**
 * git-credential-cyrus — git credential helper for multi-org GitHub access.
 *
 * Self-contained Node script (no dependencies). Installed by Cyrus at
 * `<cyrusHome>/scripts/git-credential-cyrus.cjs` and wired into git via:
 *
 *   git config --global credential."https://github.com".useHttpPath true
 *   git config --global --replace-all credential."https://github.com".helper ""
 *   git config --global --add credential."https://github.com".helper "!node <this file>"
 *
 * For `get` operations it first checks `<cyrusHome>/git-provider-tokens.json`
 * for provider-neutral GitHub/GitLab credentials. If that file is absent, it
 * falls back to the CYHOST-913 `<cyrusHome>/github-tokens.json` format.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

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

	const host = (attrs.host || "").toLowerCase();
	if (!host) return;

	// With credential.useHttpPath=true git sends e.g. path=owner/repo.git
	const pathParts = (attrs.path || "").replace(/\.git$/i, "").split("/");
	const repoNamespace = pathParts.slice(0, -1).join("/").toLowerCase();
	const org = pathParts[0] || "";

	const cyrusHome = process.env.CYRUS_HOME || path.join(os.homedir(), ".cyrus");
	const providerTokensFile = path.join(cyrusHome, "git-provider-tokens.json");

	let tokens = [];
	try {
		const parsed = JSON.parse(fs.readFileSync(providerTokensFile, "utf8"));
		if (Array.isArray(parsed.tokens)) {
			tokens = parsed.tokens
				.filter((t) => t && typeof t.token === "string")
				.map((t) => ({
					provider: t.provider,
					host: String(t.host || "").toLowerCase(),
					namespace:
						typeof t.namespace === "string"
							? t.namespace.replace(/^\/+|\/+$/g, "").toLowerCase()
							: null,
					token: t.token,
					expiresAt: t.expiresAt ?? null,
					username:
						typeof t.username === "string" && t.username.length > 0
							? t.username
							: t.provider === "gitlab"
								? "oauth2"
								: "x-access-token",
				}));
		}
	} catch {
		// Fall back to the older GitHub-only store below.
	}

	if (tokens.length === 0 && host === "github.com") {
		try {
			const parsed = JSON.parse(
				fs.readFileSync(path.join(cyrusHome, "github-tokens.json"), "utf8"),
			);
			if (Array.isArray(parsed.tokens)) {
				tokens = parsed.tokens
					.filter((t) => t && typeof t.token === "string")
					.map((t) => ({
						provider: "github",
						host: "github.com",
						namespace:
							typeof t.organization === "string"
								? t.organization.toLowerCase()
								: null,
						token: t.token,
						expiresAt: t.expiresAt,
						username: "x-access-token",
					}));
			}
		} catch {
			return;
		}
	}

	const now = Date.now();
	const valid = tokens.filter((t) => {
		if (t.host !== host) return false;
		if (!t || typeof t.token !== "string" || t.token.length === 0) return false;
		if (!t.expiresAt) return true;
		const expiresAt = Date.parse(t.expiresAt);
		return !Number.isNaN(expiresAt) && expiresAt > now;
	});

	let match;
	if (repoNamespace) {
		match = valid.find(
			(t) =>
				typeof t.namespace === "string" &&
				(repoNamespace === t.namespace ||
					repoNamespace.startsWith(`${t.namespace}/`)),
		);
	}
	if (!match && org) {
		const lowered = org.toLowerCase();
		match = valid.find(
			(t) => typeof t.namespace === "string" && t.namespace === lowered,
		);
	}
	if (!match && valid.length === 1) {
		match = valid[0];
	}
	if (!match) return;

	process.stdout.write(`username=${match.username}\npassword=${match.token}\n`);
}

main();
