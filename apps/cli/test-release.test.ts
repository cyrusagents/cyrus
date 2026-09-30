import { execFileSync, spawnSync } from "node:child_process";
import {
	copyFileSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");
const helper = join(root, "scripts/test-release.mjs");
const fixture = join(root, "apps/cli/test/fixtures/release");
const names = execFileSync(
	process.execPath,
	[join(root, "scripts/release-packages.mjs"), "list"],
	{ encoding: "utf8" },
)
	.trim()
	.split("\n")
	.map((l) => l.split("\t")[1]);
let dir: string, env: NodeJS.ProcessEnv;
const version = "1.2.3-test.0",
	channel = "test-cypack1502",
	sha = "a".repeat(40);
const stamp = {
	schemaVersion: 1,
	repository: "https://github.com/cyrusagents/cyrus",
	sourceSha: sha,
	version,
	channel,
};
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "test-channel-"));
	for (const p of ["artifacts", "bin", "package"]) mkdirSync(join(dir, p));
	for (const name of names) {
		writeFileSync(
			join(dir, "package/package.json"),
			JSON.stringify({
				name,
				version,
				cyrusTestRelease: stamp,
				publishConfig: { access: "public" },
				scripts: { prepublishOnly: "exit 99" },
			}),
		);
		const tar = join(dir, "artifacts", `${name}-${version}.tgz`);
		execFileSync("tar", ["-czf", tar, "-C", dir, "package"]);
		copyFileSync(tar, join(dir, `registry-${name}.tgz`));
	}
	const command = readFileSync(join(fixture, "command.mjs"), "utf8");
	for (const name of ["npm", "curl"])
		writeFileSync(join(dir, "bin", name), `#!${process.execPath}\n${command}`, {
			mode: 0o700,
		});
	writeFileSync(join(dir, "clock"), "0");
	writeFileSync(join(dir, "events"), "");
	env = {
		...process.env,
		PATH: `${dir}/bin:${process.env.PATH}`,
		FAKE_RELEASE_ROOT: dir,
		FAKE_CLOCK_TICK: "300000",
		RELEASE_MODE: "test",
		GITHUB_REF: "refs/heads/main",
		GITHUB_WORKFLOW_REF:
			"cyrusagents/cyrus/.github/workflows/release-cli.yml@refs/heads/main",
		GITHUB_EVENT_NAME: "workflow_dispatch",
		GITHUB_SHA: "b".repeat(40),
		CANDIDATE_SHA: sha,
		REQUESTED_VERSION: version,
		DIST_TAG: channel,
		DRY_RUN: "false",
		RELEASE_ARTIFACTS: join(dir, "artifacts"),
	};
	execFileSync(process.execPath, [helper, "manifest", env.RELEASE_ARTIFACTS!], {
		env,
	});
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));
function publish(config = {}) {
	writeFileSync(
		join(dir, "config.json"),
		JSON.stringify({ names, version, tag: channel, ...config }),
	);
	const p = spawnSync(
		process.execPath,
		[
			"--import",
			join(fixture, "clock.mjs"),
			join(root, "scripts/publish-release.mjs"),
		],
		{ env, encoding: "utf8", timeout: 30000 },
	);
	const events = readFileSync(join(dir, "events"), "utf8")
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((l) => JSON.parse(l));
	return {
		...p,
		events,
		writes: events.filter((e) => e.args?.[0] === "publish"),
	};
}
describe("npm test-channel publication", () => {
	it("publishes all17 in order with hooks disabled, exact integrity, immutable provenance and protected tags", () => {
		const p = publish();
		expect(p.status, p.stderr).toBe(0);
		expect(p.writes.map((e) => e.name)).toEqual(names);
		expect(
			p.writes.every(
				(e) =>
					e.args.includes("--ignore-scripts") &&
					e.args[e.args.indexOf("--tag") + 1] === channel,
			),
		).toBe(true);
		const proof = JSON.parse(
			readFileSync(join(dir, "artifacts/registry-proof.json"), "utf8"),
		);
		expect(proof.unchanged).toBe(true);
		expect(proof.finalGatePassed).toBe(true);
		expect(proof.sourceSha).toBe(sha);
	});
	it("recovers identical existing packages without republishing", () => {
		const p = publish({ existing: [0, 1] });
		expect(p.status, p.stderr).toBe(0);
		expect(p.writes.map((e) => e.name)).toEqual(names.slice(2));
	});
	it("rejects stable channel, stable version, nonmain and wrong workflow identity before writes", () => {
		for (const [key, value] of [
			["DIST_TAG", "latest"],
			["REQUESTED_VERSION", "1.2.3"],
			["GITHUB_REF", "refs/heads/feature"],
			["GITHUB_WORKFLOW_REF", "repo/other.yml@refs/heads/main"],
		]) {
			const prior = env[key];
			env[key] = value;
			const p = publish();
			expect(p.status).not.toBe(0);
			expect(p.writes).toHaveLength(0);
			env[key] = prior;
		}
	});
	it("rejects altered manifest before registry access", () => {
		const f = join(dir, "artifacts/test-manifest.json"),
			m = JSON.parse(readFileSync(f, "utf8"));
		m.packages[0].sha256 = "bad";
		writeFileSync(f, JSON.stringify(m));
		const p = publish();
		expect(p.status).not.toBe(0);
		expect(p.events).toEqual([]);
	});
	it("rejects registry content mismatches and latest drift", () => {
		const p = publish({ wrongIntegrity: 0 });
		expect(p.status).not.toBe(0);
		expect(p.stderr).toContain("dist.integrity");
	});
	it("fails when latest changes and records before/after evidence without repairing tags", () => {
		const p = publish({ latestDrift: true });
		expect(p.status).not.toBe(0);
		expect(p.stderr).toContain("Protected npm tags changed");
		const proof = JSON.parse(
			readFileSync(join(dir, "artifacts/registry-proof.json"), "utf8"),
		);
		expect(proof.unchanged).toBe(false);
		expect(p.events.every((e) => e.args[0] !== "dist-tag")).toBe(true);
	});
	it("dry run never publishes", () => {
		env.DRY_RUN = "true";
		const p = publish();
		expect(p.status, p.stderr).toBe(0);
		expect(p.writes).toEqual([]);
	});
	it("keeps all candidate execution outside OIDC publication", () => {
		const w = readFileSync(
			join(root, ".github/workflows/release-cli.yml"),
			"utf8",
		);
		const build = w.split("  test_build:")[1].split("  test_publish:")[0],
			pub = w.split("  test_publish:")[1].split("  test_install:")[0],
			install = w.split("  test_install:")[1];
		expect(build).not.toContain("id-token:");
		expect(install).not.toContain("id-token:");
		expect(pub).toContain("id-token: write");
		expect(pub).toContain("sparse-checkout: /scripts/");
		expect(pub).toContain("ref: ${{ github.sha }}");
		expect(pub).not.toMatch(/pnpm|candidate\//);
		expect(pub).toContain('NPM_CONFIG_IGNORE_SCRIPTS: "true"');
		expect(pub).toContain(
			"artifact-ids: ${{ needs.test_build.outputs.artifact_id }}",
		);
		expect(install).toContain("test-release-install.mjs");
	});
});
