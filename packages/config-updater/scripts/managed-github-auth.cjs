"use strict";
// Shared by the installed gh resolver and Git credential helper. A present
// store is authoritative, even when empty/broken. The enrollment marker keeps
// accidental deletion from silently restoring cached authentication.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function present(file) {
	try {
		fs.lstatSync(file);
		return true;
	} catch (error) {
		return error.code !== "ENOENT";
	}
}

function loadManagedAuth() {
	const home = process.env.CYRUS_HOME || path.join(os.homedir(), ".cyrus");
	const file = path.join(home, "github-tokens.json");
	const managed =
		present(file) || present(path.join(home, "github-auth-managed"));
	if (!managed) return { managed: false, tokens: [] };
	try {
		const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
		if (parsed.version !== 1 || !Array.isArray(parsed.tokens))
			throw new Error();
		// Refuse the entire malformed snapshot; never reinterpret it as unmanaged.
		if (
			!parsed.tokens.every(
				(t) =>
					t &&
					typeof t.token === "string" &&
					t.token.length > 0 &&
					!/[\s\0]/.test(t.token) &&
					(t.organization === null ||
						(typeof t.organization === "string" &&
							/^[a-z0-9-]+$/i.test(t.organization))) &&
					typeof t.expiresAt === "string" &&
					Number.isFinite(Date.parse(t.expiresAt)),
			)
		)
			throw new Error();
		return {
			managed: true,
			tokens: parsed.tokens.filter((t) => Date.parse(t.expiresAt) > Date.now()),
		};
	} catch {
		return { managed: true, tokens: [] };
	}
}

function resolveManagedToken(tokens, owner, sessionToken) {
	// An explicit owner must never borrow a different installation's credential.
	if (owner)
		return tokens.find(
			(t) => t.organization?.toLowerCase() === owner.toLowerCase(),
		)?.token;
	// Session snapshots are only hints, not an independent source of authority.
	if (sessionToken) return tokens.find((t) => t.token === sessionToken)?.token;
	return tokens.length === 1 ? tokens[0].token : undefined;
}
module.exports = { loadManagedAuth, resolveManagedToken };
