import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	statSync,
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

describe("generated installer isolation", () => {
	let extracted: string;
	let fakeBin: string;
	let marker: string;
	let operatorHome: string;
	const capture = `({home:process.env.HOME,cache:process.env.npm_config_cache ?? process.env.NPM_CONFIG_CACHE,xdg:process.env.XDG_CONFIG_HOME, hasAuth:!!process.env.GITHUB_TOKEN, hasNpmAuth:!!process.env.NODE_AUTH_TOKEN, hasNodeOptions:!!process.env.NODE_OPTIONS, userConfig:process.env.NPM_CONFIG_USERCONFIG,globalConfig:process.env.NPM_CONFIG_GLOBALCONFIG,args:process.argv.slice(2)})`;
	beforeEach(() => {
		for (let i = 0; i < graph.length; i++) pack(i);
		expect(build().status).toBe(0);
		execFileSync("tar", [
			"-xzf",
			join(output, `cyrus-${version}-test-bundle.tar.gz`),
			"-C",
			temp,
		]);
		extracted = join(temp, `cyrus-${version}-test-bundle`);
		fakeBin = join(temp, "fake-bin");
		marker = join(temp, "npm-called.json");
		operatorHome = join(temp, "operator-home");
		mkdirSync(fakeBin);
		mkdirSync(operatorHome);
		writeFileSync(join(operatorHome, ".npmrc"), "operator config sentinel");
		writeFileSync(
			join(operatorHome, "auth-sentinel"),
			"operator auth sentinel",
		);
		const cli = `#!${process.execPath}\nconst fs=require('node:fs');fs.appendFileSync(${JSON.stringify(join(temp, "cli-env.jsonl"))},JSON.stringify(${capture})+'\\n');if(process.argv[2]==='--version')console.log(${JSON.stringify(version)});`;
		writeFileSync(
			join(fakeBin, "npm"),
			`#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path');fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify(${capture}));const prefix=process.argv[process.argv.indexOf('--prefix')+1];fs.mkdirSync(path.join(prefix,'bin'),{recursive:true});fs.writeFileSync(path.join(prefix,'bin/cyrus'),${JSON.stringify(cli)},{mode:0o700});`,
			{ mode: 0o700 },
		);
	});
	function install(prefix: string) {
		return spawnSync("bash", ["install.sh", prefix], {
			cwd: extracted,
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${fakeBin}:${process.env.PATH}`,
				HOME: operatorHome,
				NPM_CONFIG_USERCONFIG: join(operatorHome, ".npmrc"),
				NPM_CONFIG_GLOBALCONFIG: join(operatorHome, ".npmrc"),
				npm_config_cache: join(operatorHome, "cache"),
				npm_config_registry: "https://invalid.example.invalid",
				NODE_OPTIONS: "--no-warnings",
				GITHUB_TOKEN: "offline-auth-sentinel",
				NODE_AUTH_TOKEN: "offline-npm-sentinel",
			},
		});
	}
	it("refuses an existing installation before invoking npm, preserving its contents and operator state", () => {
		const prefix = join(temp, "existing-prefix");
		mkdirSync(prefix);
		writeFileSync(join(prefix, "sentinel"), "existing Cyrus install");
		const result = install(prefix);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing");
		expect(existsSync(marker)).toBe(false);
		expect(readdirSync(prefix)).toEqual(["sentinel"]);
		expect(readFileSync(join(prefix, "sentinel"), "utf8")).toBe(
			"existing Cyrus install",
		);
		expect(readdirSync(operatorHome).sort()).toEqual([
			".npmrc",
			"auth-sentinel",
		]);
	});
	it.each([
		"",
		"/",
	])("refuses a dangling symlink prefix (suffix %j) without npm or link changes", (suffix) => {
		const prefix = join(temp, "dangling-prefix"),
			target = join(temp, "absent-target");
		symlinkSync(target, prefix);
		const result = install(prefix + suffix);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("refusing");
		expect(existsSync(marker)).toBe(false);
		expect(lstatSync(prefix).isSymbolicLink()).toBe(true);
		expect(readlinkSync(prefix)).toBe(target);
		expect(existsSync(target)).toBe(false);
	});
	it("creates a private fresh prefix and isolates npm and both CLI checks from operator configuration/auth", () => {
		const prefix = join(temp, "fresh prefix");
		const result = install(prefix);
		expect(result.stderr).toBe("");
		expect(result.status).toBe(0);
		const npm = JSON.parse(readFileSync(marker, "utf8"));
		const cli = readFileSync(join(temp, "cli-env.jsonl"), "utf8")
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(cli.map((c) => c.args)).toEqual([["--version"], ["--help"]]);
		for (const env of [npm, ...cli]) {
			expect(env.home).toBe(join(prefix, "test-home"));
			expect(env.cache).toBe(join(prefix, "cache"));
			expect(env.xdg).toBe(join(prefix, "test-home/.config"));
			expect(env.hasAuth).toBe(false);
			expect(env.hasNpmAuth).toBe(false);
			expect(env.hasNodeOptions).toBe(false);
			expect(env.userConfig).toBe(join(prefix, "test-home/npm-user.npmrc"));
			expect(env.globalConfig).toBe(join(prefix, "test-home/npm-global.npmrc"));
		}
		expect(npm.args).toContain("--global");
		expect(npm.args[npm.args.indexOf("--prefix") + 1]).toBe(prefix);
		expect(npm.args.filter((s: string) => s.endsWith(".tgz"))).toHaveLength(17);
		for (const directory of [
			prefix,
			join(prefix, "test-home"),
			join(prefix, "cache"),
		])
			expect(statSync(directory).mode & 0o777).toBe(0o700);
		for (const file of [npm.userConfig, npm.globalConfig]) {
			expect(statSync(file).mode & 0o777).toBe(0o600);
			expect(readFileSync(file, "utf8")).toBe("");
		}
		expect(readdirSync(operatorHome).sort()).toEqual([
			".npmrc",
			"auth-sentinel",
		]);
		expect(readFileSync(join(operatorHome, ".npmrc"), "utf8")).toBe(
			"operator config sentinel",
		);
		expect(readFileSync(join(operatorHome, "auth-sentinel"), "utf8")).toBe(
			"operator auth sentinel",
		);
	});
});

describe("artifact workflow boundary", () => {
	it("keeps manual artifact builds credential-free and gates upload on canonical checks and the extracted CLI smoke", () => {
		const full = readFileSync(
			join(root, ".github/workflows/release-cli.yml"),
			"utf8",
		);
		const workflow = full.split("  test_build:")[1].split("  test_publish:")[0];
		expect(full).toContain("workflow_dispatch:");
		expect(workflow).not.toMatch(
			/^\s+(push|pull_request|pull_request_target):/m,
		);
		expect(workflow).toContain('test "$GITHUB_REF" = "refs/heads/main"');
		expect(workflow).toContain("permissions:\n      contents: read");
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
