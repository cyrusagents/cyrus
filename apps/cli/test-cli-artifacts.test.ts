import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const script = join(root, "scripts/test-cli-artifacts.mjs");
const version = "0.2.73-cypack1502.0";
const sourceSha = "bd45d03ae855d4148257cfeb93d026f88d886626";
const workflowSha = "e9e1e53d629b023545ebfd821bcd16c67f44f217";
const graph = execFileSync(
	process.execPath,
	[join(root, "scripts/release-packages.mjs"), "list"],
	{ encoding: "utf8" },
)
	.trim()
	.split("\n")
	.map((line) => {
		const [directory, name] = line.split("\t");
		return { directory, name };
	});
let temp: string;
let packagesDir: string;
let output: string;

function pack(index: number, overrides = {}) {
	const { name } = graph[index];
	const staging = join(temp, "fixture");
	mkdirSync(join(staging, "package"), { recursive: true });
	writeFileSync(
		join(staging, "package/package.json"),
		JSON.stringify({
			name,
			version,
			dependencies: index ? { [graph[index - 1].name]: version } : {},
			...overrides,
		}),
	);
	execFileSync("tar", [
		"-czf",
		join(packagesDir, `${name}-${version}.tgz`),
		"-C",
		staging,
		"package",
	]);
}
function invoke(...args: string[]) {
	return spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
}
function build() {
	return invoke("bundle", version, sourceSha, workflowSha, packagesDir, output);
}

beforeEach(() => {
	temp = mkdtempSync(join(tmpdir(), "cyrus-artifact-test-"));
	packagesDir = join(temp, "packages");
	output = join(temp, "output");
	mkdirSync(packagesDir);
});
afterEach(() => rmSync(temp, { recursive: true, force: true }));

describe("immutable artifact request", () => {
	it.each([
		"main",
		"bd45d03",
		`${sourceSha}\n`,
		`$(echo injected)`,
	])("rejects non-commit input %s before reading packages", (sha) => {
		const result = invoke(
			"bundle",
			version,
			sha,
			workflowSha,
			packagesDir,
			output,
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("40-character commit SHA");
	});
	it.each([
		"0.2.73",
		"latest",
		"0.2.73-test.01",
		"0.2.73-test/escape",
		"0.2.73-test+metadata",
	])("rejects non-prerelease or unsafe version %s", (invalid) => {
		const result = invoke(
			"bundle",
			invalid,
			sourceSha,
			workflowSha,
			packagesDir,
			output,
		);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("exact semantic prerelease");
	});
	it("rejects a checkout with the wrong immutable SHA", () => {
		const result = invoke("validate", root, version, "0".repeat(40));
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("checkout does not match");
	});
});

describe("complete package bundle", () => {
	beforeEach(() => {
		for (let index = 0; index < graph.length; index++) pack(index);
	});
	it("archives all 17 packages with exact identities, source/workflow provenance and independently verifiable hashes", () => {
		const result = build();
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const manifest = JSON.parse(
			readFileSync(join(output, "manifest.json"), "utf8"),
		);
		expect(manifest.sourceSha).toBe(sourceSha);
		expect(manifest.workflowSha).toBe(workflowSha);
		expect(manifest.packages).toHaveLength(17);
		for (const [index, entry] of manifest.packages.entries()) {
			expect(entry.name).toBe(graph[index].name);
			expect(entry.version).toBe(version);
			expect(entry.sha256).toBe(
				createHash("sha256")
					.update(readFileSync(join(packagesDir, entry.file)))
					.digest("hex"),
			);
		}
		expect(readdirSync(output).sort()).toEqual([
			"SHA256SUMS",
			`cyrus-${version}-test-bundle.tar.gz`,
			"manifest.json",
		]);
		execFileSync("shasum", ["-a", "256", "--check", "SHA256SUMS"], {
			cwd: output,
		});
		execFileSync("tar", [
			"-xzf",
			join(output, `cyrus-${version}-test-bundle.tar.gz`),
			"-C",
			temp,
		]);
		const extracted = join(temp, `cyrus-${version}-test-bundle`);
		execFileSync("shasum", ["-a", "256", "--check", "SHA256SUMS"], {
			cwd: extracted,
		});
		writeFileSync(
			join(extracted, `${graph[0].name}-${version}.tgz`),
			"tampered",
		);
		const install = spawnSync("bash", ["install.sh", join(temp, "prefix")], {
			cwd: extracted,
			encoding: "utf8",
		});
		expect(install.status).not.toBe(0);
		expect(install.stdout).toContain("FAILED");
	});
	it("refuses missing or extra packages", () => {
		const first = join(packagesDir, `${graph[0].name}-${version}.tgz`);
		copyFileSync(first, join(temp, "backup.tgz"));
		rmSync(first);
		expect(build().stderr).toContain("exactly the canonical graph");
		copyFileSync(join(temp, "backup.tgz"), first);
		copyFileSync(first, join(packagesDir, "extra.tgz"));
		expect(build().stderr).toContain("exactly the canonical graph");
	});
	it("refuses symlinks in place of package files", () => {
		const first = join(packagesDir, `${graph[0].name}-${version}.tgz`);
		rmSync(first);
		symlinkSync(join(packagesDir, `${graph[1].name}-${version}.tgz`), first);
		expect(build().stderr).toContain("not a regular file");
	});
	it.each([
		{ name: "unrelated" },
		{ version: "0.2.72" },
	])("refuses incorrect package identity %j", (override) => {
		pack(0, override);
		expect(build().stderr).toContain("Unexpected package identity");
	});
	it.each([
		"workspace:*",
		"0.2.72",
		`^${version}`,
	])("refuses unresolved or drifting internal dependencies %s", (range) => {
		pack(1, { dependencies: { [graph[0].name]: range } });
		expect(build().stderr).toContain("must resolve to the bundled version");
	});
	it("refuses to reuse an output directory", () => {
		mkdirSync(output);
		expect(build().status).not.toBe(0);
	});
});

describe("artifact workflow boundary", () => {
	it("keeps manual artifact builds credential-free and gates upload on canonical checks and the extracted CLI smoke", () => {
		const workflow = readFileSync(
			join(root, ".github/workflows/test-cli-artifacts.yml"),
			"utf8",
		);
		expect(workflow).toContain("workflow_dispatch:");
		expect(workflow).not.toMatch(
			/^\s+(push|pull_request|pull_request_target):/m,
		);
		expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
		expect(workflow).toContain("permissions:\n  contents: read");
		expect(workflow).not.toMatch(
			/id-token:|contents: write|secrets\.|GH_TOKEN|NODE_AUTH_TOKEN|registry-url:|npm publish|publish-release|git push|gh release/,
		);
		expect(workflow.match(/persist-credentials: false/g)).toHaveLength(2);
		for (const check of [
			"--frozen-lockfile --strict-peer-dependencies",
			"pnpm audit --audit-level low",
			"pnpm lint",
			"pnpm build",
			"pnpm test:packages:run",
			"pnpm --filter cyrus-ai test:run",
			"pnpm typecheck",
			"test-cli-artifacts.mjs validate",
			"test-cli-artifacts.mjs bundle",
			'bash install.sh "$RUNNER_TEMP/test-cli-prefix"',
		]) {
			expect(workflow).toContain(check);
			expect(workflow.indexOf(check)).toBeLessThan(
				workflow.indexOf("uses: actions/upload-artifact"),
			);
		}
		expect(workflow).not.toContain("if: always()");
	});
});
