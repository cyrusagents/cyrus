import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
	it("rejects missing or unverified evidence and an attempt to waive required F1", () => {
		const f = fixture();
		expect(() => validateReleaseEvidence(version, f.root)).toThrow();
		const evidence = f.evidence();
		f.save({
			...evidence,
			checks: [
				{
					command: "install smoke",
					status: "failed",
					result: "Wrong installed version",
				},
			],
		});
		expect(() => validateReleaseEvidence(version, f.root)).toThrow();
		f.save({ ...evidence, f1Applicability: "required" });
		expect(() => validateReleaseEvidence(version, f.root)).toThrow();
	});

	it("accepts assessed evidence after tagging but rejects it after an earlier runtime change and version bump", () => {
		const f = fixture();
		f.save(f.evidence());
		f.commit();
		f.git("tag", `v${version}`);
		expect(() => validateReleaseEvidence(version, f.root)).not.toThrow();
		f.write("runtime.js", "export const behavior = 2;\n");
		f.commit();
		f.write("package.json", JSON.stringify({ version }));
		f.commit();
		expect(() => validateReleaseEvidence(version, f.root)).toThrow();
	});

	it("accepts the same assessed payload under different local Git diff settings", () => {
		const f = fixture();
		f.write("other.md", "Another documentation change\n");
		f.commit();
		f.save(f.evidence());
		f.commit();
		f.git("config", "diff.noprefix", "true");
		f.git("config", "diff.algorithm", "histogram");
		f.git("config", "color.ui", "always");
		f.git("config", "core.abbrev", "5");
		f.git("config", "diff.renames", "copies");
		f.write(".git/diff-order", "other.md\nREADME.md\n");
		f.git("config", "diff.orderFile", ".git/diff-order");
		expect(() => validateReleaseEvidence(version, f.root)).not.toThrow();
	});
});
