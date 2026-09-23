"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
// undefined = no personal selection. Explicit empty/missing/revoked selection throws.
exports.personalToken = () => {
	if (!Object.hasOwn(process.env, "CYRUS_GITHUB_USER_ID")) return undefined;
	try {
		const id = process.env.CYRUS_GITHUB_USER_ID;
		if (!id) throw new Error();
		const home = process.env.CYRUS_HOME || path.join(os.homedir(), ".cyrus");
		const file = JSON.parse(
			fs.readFileSync(path.join(home, "github-tokens.json"), "utf8"),
		);
		if (
			file.version !== 1 ||
			!Array.isArray(file.tokens) ||
			!file.personalTokens ||
			!Object.hasOwn(file.personalTokens, id)
		)
			throw new Error();
		const entry = file.personalTokens[id];
		if (!entry) throw new Error();
		const token =
			typeof entry.token === "string" && entry.env === undefined
				? entry.token
				: typeof entry.env === "string" && entry.token === undefined
					? process.env[entry.env]
					: undefined;
		if (!token?.trim() || /[\r\n]/.test(token.trim())) throw new Error();
		return token.trim();
	} catch {
		throw new Error(
			"Personal GitHub credentials are missing, revoked or unreadable. Run cyrus check-users; shared credentials will not be used.",
		);
	}
};
