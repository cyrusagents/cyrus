import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function evidencePath(version) {
	return `docs/release-verification/v${version}.json`;
}

// Bind the assessment to the entire committed payload, excluding only itself.
// Classification is a reviewed behavioral judgment, never a path allowlist.
export function releasePayload(version, repositoryRoot) {
	const git = (...args) =>
		execFileSync("git", args, {
			cwd: repositoryRoot,
			stdio: ["ignore", "pipe", "pipe"],
			maxBuffer: 64 * 1024 * 1024,
		});
	const previousRelease = git(
		"describe",
		"--tags",
		"--first-parent",
		"--match",
		"v[0-9]*",
		"--exclude",
		`v${version}`,
		"--abbrev=0",
		"HEAD",
	)
		.toString()
		.trim();
	const previousReleaseCommit = git("rev-parse", `${previousRelease}^{commit}`)
		.toString()
		.trim();
	const payload = git(
		"diff",
		"--no-ext-diff",
		"--no-textconv",
		"--raw",
		"--no-abbrev",
		"--no-renames",
		"--no-color",
		"--ignore-submodules=none",
		"-z",
		"-O/dev/null",
		previousReleaseCommit,
		"HEAD",
		"--",
		".",
		`:(exclude)${evidencePath(version)}`,
	);
	return {
		previousRelease,
		previousReleaseCommit,
		payloadSha256: createHash("sha256").update(payload).digest("hex"),
	};
}

export function validateReleaseEvidence(version, repositoryRoot) {
	const driveDirectory = join(repositoryRoot, "apps/f1/test-drives");
	if (
		existsSync(driveDirectory) &&
		readdirSync(driveDirectory, { withFileTypes: true }).some(
			(entry) =>
				entry.isFile() && entry.name.endsWith(`-release-v${version}.md`),
		)
	)
		return;

	const path = evidencePath(version);
	if (!existsSync(join(repositoryRoot, path))) {
		throw new Error(
			`Missing release verification: provide relevant F1 evidence ending in -release-v${version}.md or a reviewed non-F1 payload assessment at ${path}.`,
		);
	}
	const evidence = JSON.parse(readFileSync(join(repositoryRoot, path), "utf8"));
	const nonempty = (value) =>
		typeof value === "string" && value.trim().length > 0;
	if (
		evidence?.version !== version ||
		evidence.f1Applicability !== "not-applicable" ||
		!nonempty(evidence.rationale) ||
		!Array.isArray(evidence.checks) ||
		evidence.checks.length === 0 ||
		!evidence.checks.every(
			(check) =>
				check &&
				nonempty(check.command) &&
				check.status === "passed" &&
				nonempty(check.result),
		)
	) {
		throw new Error(
			`${path} requires the exact version, f1Applicability=not-applicable, a behavioral rationale, and passed checks with commands and results. F1-covered changes require an F1 report.`,
		);
	}
	const payload = releasePayload(version, repositoryRoot);
	for (const key of Object.keys(payload)) {
		if (evidence[key] !== payload[key]) {
			throw new Error(
				`${path}: ${key} does not match the full released payload. Reassess changes since ${payload.previousRelease} and rerun relevant checks.`,
			);
		}
	}
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const version = process.argv[2];
	if (!version || !/^[0-9A-Za-z.+-]+$/.test(version)) {
		throw new Error("Usage: node scripts/release-evidence.mjs <version>");
	}
	console.log(JSON.stringify(releasePayload(version, process.cwd()), null, 2));
}
