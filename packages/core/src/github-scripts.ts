import { randomUUID } from "node:crypto";
import {
	chmodSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Install the SAME helpers for local provisioning and hosted refresh. No global auth writes. */
export function ensureGitHubScripts(cyrusHome: string): string {
	const dest = join(cyrusHome, "scripts");
	mkdirSync(join(dest, "bin"), { recursive: true });
	const source = join(
		dirname(fileURLToPath(import.meta.url)),
		"..",
		"github-scripts",
	);
	for (const name of [
		"personal-token.cjs",
		"git-credential-cyrus.cjs",
		"gh-cyrus.cjs",
		"gh",
	]) {
		const target = join(dest, name === "gh" ? "bin/gh" : name);
		const temp = `${target}.${randomUUID()}.tmp`;
		try {
			writeFileSync(temp, readFileSync(join(source, name)), {
				flag: "wx",
				mode: 0o755,
			});
			chmodSync(temp, 0o755);
			renameSync(temp, target);
		} finally {
			try {
				unlinkSync(temp);
			} catch {
				/* already renamed */
			}
		}
	}
	return join(dest, "git-credential-cyrus.cjs");
}
