import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	releasePayload,
	validateReleaseEvidence,
} from "../../scripts/release-evidence.mjs";

const directories: string[] = [];
const version = "1.1.0";
const evidenceFile = `docs/release-verification/v${version}.json`;
afterEach(() => {
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

function fixture() {
	const root = mkdtempSync(join(tmpdir(), "cyrus-release-evidence-"));
	directories.push(root);
	const git = (...args: string[]) =>
		execFileSync("git", args, {
			cwd: root,
			encoding: "utf8",
			env: {
				...process.env,
				GIT_CONFIG_NOSYSTEM: "1",
				GIT_CONFIG_GLOBAL: "/dev/null",
			},
		});
	const write = (path: string, content: string) => {
		mkdirSync(join(root, path, ".."), { recursive: true });
		writeFileSync(join(root, path), content);
	};
	const commit = () => {
		git("add", ".");
		git(
			"-c",
			"user.name=Release Test",
			"-c",
			"user.email=release@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-qm",
			"fixture",
		);
	};
	git("init", "-q");
	write("README.md", "Previous release\n");
	write("runtime.js", "export const behavior = 1;\n");
	commit();
	git("tag", "v1.0.0");
	write("README.md", "Documentation correction\n");
	commit();
	const evidence = () => ({
		version,
		...releasePayload(version, root),
		f1Applicability: "not-applicable",
		rationale:
			"Only documentation wording changed since v1.0.0; installed workflow behavior is unchanged.",
		checks: [
			{
				command: "documentation review",
				status: "passed",
				result: "All changed instructions and links verified.",
			},
		],
	});
	const save = (value: unknown) => write(evidenceFile, JSON.stringify(value));
	return { root, git, write, commit, evidence, save };
}

describe("release evidence applicability gate", () => {
	it("requires evidence rather than silently exempting a docs-only payload", () => {
		const f = fixture();
		expect(() => validateReleaseEvidence(version, f.root)).toThrow(
			"Missing release verification",
		);
	});

	it("accepts relevant historical F1 evidence without demanding non-F1 metadata", () => {
		const f = fixture();
		f.write(
			`apps/f1/test-drives/2026-09-24-release-v${version}.md`,
			"# Session routing validation\n",
		);
		expect(() => validateReleaseEvidence(version, f.root)).not.toThrow();
	});

	it("does not accept a directory or another version's report as F1 evidence", () => {
		const f = fixture();
		f.write(
			"apps/f1/test-drives/2026-09-24-release-v1.0.0.md",
			"# Old release\n",
		);
		mkdirSync(join(f.root, `apps/f1/test-drives/fake-release-v${version}.md`));
		expect(() => validateReleaseEvidence(version, f.root)).toThrow(
			"Missing release verification",
		);
	});

	it("accepts reviewed non-F1 evidence across its own commit and the new release tag", () => {
		const f = fixture();
		f.save(f.evidence());
		f.commit();
		f.git("tag", `v${version}`);
		expect(() => validateReleaseEvidence(version, f.root)).not.toThrow();
	});

	it.each([
		{ version: "1.2.0" },
		{ f1Applicability: "required" },
		{ rationale: " " },
		{ checks: [] },
		{ checks: [{ command: "test", status: "failed", result: "failed" }] },
		{ checks: [{ command: "test", status: "passed", result: "" }] },
		{ checks: [{ command: "", status: "passed", result: "ok" }] },
	])("rejects incomplete or inapplicable attestations: %j", (override) => {
		const f = fixture();
		f.save({ ...f.evidence(), ...override });
		expect(() => validateReleaseEvidence(version, f.root)).toThrow(
			"F1-covered changes require an F1 report",
		);
	});

	it.each([
		"previousRelease",
		"previousReleaseCommit",
		"payloadSha256",
	])("rejects an incorrect %s", (key) => {
		const f = fixture();
		f.save({ ...f.evidence(), [key]: "incorrect" });
		expect(() => validateReleaseEvidence(version, f.root)).toThrow(
			`${key} does not match`,
		);
	});

	it.each([
		"README.md",
		"runtime.js",
		"package.json",
		"instructions.md",
	])("invalidates evidence when any assessed payload changes: %s", (path) => {
		const f = fixture();
		f.save(f.evidence());
		f.commit();
		f.write(path, "Changed after assessment\n");
		f.commit();
		expect(() => validateReleaseEvidence(version, f.root)).toThrow(
			"payloadSha256 does not match",
		);
	});

	it("includes runtime changes merged before a version-only release PR in the assessed payload", () => {
		const f = fixture();
		const before = f.evidence();
		f.write("runtime.js", "export const behavior = 2;\n");
		f.commit();
		f.write("package.json", JSON.stringify({ version }));
		f.commit();
		const payload = releasePayload(version, f.root);
		expect(payload.previousRelease).toBe("v1.0.0");
		expect(payload.payloadSha256).not.toBe(before.payloadSha256);
		f.save({ ...before, f1Applicability: "required" });
		expect(() => validateReleaseEvidence(version, f.root)).toThrow(
			"F1-covered changes require an F1 report",
		);
	});

	it("uses stable blob and mode evidence regardless of diff presentation config", () => {
		const f = fixture();
		f.write("other.md", "Another documentation change\n");
		f.commit();
		const before = releasePayload(version, f.root);
		f.git("config", "diff.noprefix", "true");
		f.git("config", "diff.algorithm", "histogram");
		f.git("config", "color.ui", "always");
		f.git("config", "core.abbrev", "5");
		f.git("config", "diff.renames", "copies");
		f.write(".git/diff-order", "other.md\nREADME.md\n");
		f.git("config", "diff.orderFile", ".git/diff-order");
		expect(releasePayload(version, f.root)).toEqual(before);
	});

	it("fails closed without previous release history", () => {
		const f = fixture();
		f.save(f.evidence());
		f.git("tag", "-d", "v1.0.0");
		expect(() => validateReleaseEvidence(version, f.root)).toThrow();
	});

	it("wires non-F1 evidence into the complete release validator", () => {
		const f = fixture();
		const source = resolve(import.meta.dirname, "../..");
		cpSync(join(source, "scripts"), join(f.root, "scripts"), {
			recursive: true,
		});
		const packages = execFileSync(
			process.execPath,
			["scripts/release-packages.mjs", "list"],
			{ cwd: f.root, encoding: "utf8" },
		)
			.trim()
			.split("\n")
			.map((line) => line.split("\t"));
		for (const [directory, name] of packages) {
			f.write(
				`${directory}/package.json`,
				JSON.stringify({
					name,
					version,
					repository: {
						type: "git",
						url: "git+https://github.com/cyrusagents/cyrus.git",
						directory,
					},
				}),
			);
		}
		f.write(
			"CHANGELOG.md",
			`## [${version}]\n${packages.map(([, name]) => `${name}@${version}`).join("\n")}\n`,
		);
		f.write("CHANGELOG.internal.md", `## [${version}]\n`);
		f.commit();
		const validate = () =>
			execFileSync(
				process.execPath,
				["scripts/release-packages.mjs", "validate", version],
				{ cwd: f.root, encoding: "utf8", stdio: "pipe" },
			);
		expect(validate).toThrow("Missing release verification");
		f.save(f.evidence());
		f.commit();
		expect(validate()).toContain(`release packages at ${version}`);
	});
});
