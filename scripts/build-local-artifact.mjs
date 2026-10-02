// Local only: builds and packs exact reviewed source. Never publishes or tags.
// Usage: node build-local-artifact.mjs /absolute/clean/repository FULL_SHA /absolute/new/output [WORKFLOW_SHA]

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const [rootArg, sha, outputArg, workflowSha = sha] = process.argv.slice(2);
if (!rootArg || !outputArg || !/^[a-f0-9]{40}$/.test(workflowSha ?? ""))
	throw Error(
		"Usage: build-local-artifact.mjs SOURCE FULL_SHA NEW_OUTPUT [WORKFLOW_SHA]",
	);
const root = resolve(rootArg),
	output = resolve(outputArg);
if (existsSync(output)) throw Error("Choose a new output directory");
const hashFile = (file) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");
const run = (bin, args, cwd = root) =>
	execFileSync(bin, args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "inherit"],
		maxBuffer: 16 * 1024 * 1024,
	});
if (
	!/^[a-f0-9]{40}$/.test(sha) ||
	run("git", ["rev-parse", "HEAD"]).trim() !== sha ||
	run("git", ["status", "--porcelain", "--untracked-files=no"]).trim()
)
	throw Error("Exact clean reviewed checkout required");
const { releasePackages } = await import(
	pathToFileURL(join(root, "scripts/release-packages.mjs"))
);
const { bundle } = await import(
	pathToFileURL(join(root, "scripts/test-cli-artifacts.mjs"))
);
const base = JSON.parse(
	readFileSync(join(root, "apps/cli/package.json")),
).version;
const version = `${base}-cypack1546.${sha.slice(0, 12)}`;
console.log(run("pnpm", ["install", "--frozen-lockfile", "--ignore-scripts"]));
console.log(run("pnpm", ["build"]));
const work = mkdtempSync(join(tmpdir(), "cyrus-local-pack-"));
const raw = join(work, "raw"),
	packages = join(work, "packages");
mkdirSync(raw);
mkdirSync(packages);
const names = new Set(releasePackages.map((x) => x.name));
try {
	for (const { directory, name } of releasePackages) {
		run("pnpm", [
			"--dir",
			join(root, directory),
			"pack",
			"--out",
			join(raw, `${name}.tgz`),
		]);
		const staging = join(work, name);
		mkdirSync(staging);
		run("tar", ["-xzf", join(raw, `${name}.tgz`), "-C", staging]);
		const packageDir = join(staging, "package"),
			manifestPath = join(packageDir, "package.json");
		const manifest = JSON.parse(readFileSync(manifestPath));
		manifest.version = version;
		delete manifest.cyrusTestRelease;
		manifest.cyrusLocalTestArtifact = {
			sourceSha: sha,
			kind: "unpublished-test-only",
		};
		for (const group of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		])
			for (const dependency of Object.keys(manifest[group] ?? {}))
				if (names.has(dependency)) manifest[group][dependency] = version;
		writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
		run(
			"npm",
			[
				"pack",
				"--ignore-scripts",
				"--cache",
				join(work, "npm-cache"),
				"--pack-destination",
				packages,
			],
			packageDir,
		);
	}
	bundle(version, sha, workflowSha, packages, output);
	writeFileSync(
		join(output, "BUILD.json"),
		`${JSON.stringify(
			{
				sourceSha: sha,
				workflowSha,
				builderSha256: hashFile(fileURLToPath(import.meta.url)),
				version,
				node: process.version,
				pnpm: run("pnpm", ["--version"]).trim(),
				npm: run("npm", ["--version"]).trim(),
				packaging:
					"canonical 17-package graph; staged version/provenance only; no source edits or publication",
				lockfileSha256: hashFile(join(root, "pnpm-lock.yaml")),
			},
			null,
			2,
		)}\n`,
	);
	console.log(JSON.stringify({ output, version, sourceSha: sha }));
} finally {
	rmSync(work, { recursive: true, force: true });
}
