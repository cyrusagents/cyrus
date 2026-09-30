import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	copyFileSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackages } from "./release-packages.mjs";

const toolingRoot = resolve(import.meta.dirname, "..");
const prerelease =
	/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)$/;

export function validateRequest(version, ...shas) {
	const match = prerelease.exec(version ?? "");
	if (
		!match ||
		match[0] !== version ||
		match[4].split(".").some((part) => /^0\d+$/.test(part))
	) {
		throw new Error(
			"Test artifacts require an exact semantic prerelease version.",
		);
	}
	if (
		shas.length === 0 ||
		shas.some((sha) => sha?.length !== 40 || !/^[0-9a-f]{40}$/.test(sha))
	) {
		throw new Error("A full lowercase 40-character commit SHA is required.");
	}
}

function run(command, args, options = {}) {
	return execFileSync(command, args, { encoding: "utf8", ...options });
}

export function validateCandidate(directory, version, sha) {
	validateRequest(version, sha);
	const cwd = resolve(directory);
	if (run("git", ["rev-parse", "HEAD"], { cwd }).trim() !== sha) {
		throw new Error("Candidate checkout does not match the requested SHA.");
	}
	if (run("git", ["status", "--porcelain", "--untracked-files=no"], { cwd })) {
		throw new Error("Candidate has modified tracked files.");
	}
	// Execute the canonical validator only when it matches reviewed tooling.
	// Changes to the package graph require a corresponding tooling review.
	const validator = "scripts/release-packages.mjs";
	if (
		!readFileSync(join(cwd, validator)).equals(
			readFileSync(join(toolingRoot, validator)),
		)
	) {
		throw new Error(
			"Candidate canonical release tooling differs; review it first.",
		);
	}
	run(process.execPath, [validator, "validate", version], {
		cwd,
		stdio: "inherit",
	});
}

const sha256 = (file) =>
	createHash("sha256").update(readFileSync(file)).digest("hex");

export function bundle(
	version,
	sourceSha,
	workflowSha,
	packagesDir,
	outputDir,
) {
	validateRequest(version, sourceSha, workflowSha);
	const expected = releasePackages.map(({ name }) => `${name}-${version}.tgz`);
	const actual = readdirSync(packagesDir).sort();
	if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) {
		throw new Error(
			"Package directory must contain exactly the canonical graph.",
		);
	}
	const names = new Set(releasePackages.map(({ name }) => name));
	const packages = releasePackages.map(({ directory, name }, index) => {
		const file = expected[index];
		const path = join(packagesDir, file);
		if (!lstatSync(path).isFile())
			throw new Error(`${file} is not a regular file.`);
		const packed = JSON.parse(
			run("tar", ["-xOf", path, "package/package.json"]),
		);
		if (packed.name !== name || packed.version !== version) {
			throw new Error(`Unexpected package identity in ${file}.`);
		}
		for (const group of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		]) {
			for (const [dependency, range] of Object.entries(packed[group] ?? {})) {
				if (
					String(range).startsWith("workspace:") ||
					(names.has(dependency) && range !== version)
				) {
					throw new Error(
						`${name}: ${dependency} must resolve to the bundled version.`,
					);
				}
			}
		}
		return {
			name,
			directory,
			version,
			file,
			bytes: lstatSync(path).size,
			sha256: sha256(path),
		};
	});
	// Refuse to mix outputs with a previous attempt.
	mkdirSync(outputDir);
	const bundleName = `cyrus-${version}-test-bundle`;
	const staging = join(outputDir, bundleName);
	mkdirSync(staging);
	for (const { file } of packages)
		copyFileSync(join(packagesDir, file), join(staging, file));
	const manifest = {
		schemaVersion: 1,
		kind: "test-only",
		version,
		repository: "https://github.com/cyrusagents/cyrus",
		sourceSha,
		workflowSha,
		packages,
	};
	writeFileSync(
		join(staging, "manifest.json"),
		`${JSON.stringify(manifest, null, 2)}\n`,
	);
	writeFileSync(
		join(staging, "install.sh"),
		`#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
prefix="\${1:?Usage: bash install.sh /absolute/path/to/disposable-prefix}"
[[ "$prefix" = /* ]] || { echo 'Use an absolute isolated prefix.' >&2; exit 1; }
while [[ "$prefix" != / && "$prefix" = */ ]]; do prefix="\${prefix%/}"; done
if [[ -e "$prefix" || -L "$prefix" ]]; then
  echo 'Choose a new test prefix; refusing to overwrite an existing path.' >&2
  exit 1
fi
if command -v sha256sum >/dev/null; then
  sha256sum --check SHA256SUMS
else
  shasum -a 256 --check SHA256SUMS
fi
umask 077
# Atomic mkdir (without -p) also refuses a path created after the check above.
mkdir "$prefix"
mkdir "$prefix/test-home" "$prefix/cache" "$prefix/tmp" \
  "$prefix/test-home/.config" "$prefix/test-home/.cache" "$prefix/test-home/.local"
: > "$prefix/test-home/npm-user.npmrc"
: > "$prefix/test-home/npm-global.npmrc"
# Only child processes receive this disposable environment; the caller is unchanged.
isolated_env=(env -i "PATH=$PATH" "HOME=$prefix/test-home" \
  "TMPDIR=$prefix/tmp" "TMP=$prefix/tmp" "TEMP=$prefix/tmp" \
  "XDG_CONFIG_HOME=$prefix/test-home/.config" "XDG_CACHE_HOME=$prefix/test-home/.cache" \
  "XDG_DATA_HOME=$prefix/test-home/.local" "CYRUS_SENTRY_DISABLED=1" \
  "NPM_CONFIG_USERCONFIG=$prefix/test-home/npm-user.npmrc" \
  "NPM_CONFIG_GLOBALCONFIG=$prefix/test-home/npm-global.npmrc" \
  "NPM_CONFIG_CACHE=$prefix/cache" "NPM_CONFIG_REGISTRY=https://registry.npmjs.org")
"\${isolated_env[@]}" npm install --global --prefix "$prefix" --no-audit --no-fund ./*.tgz
actual="$("\${isolated_env[@]}" "$prefix/bin/cyrus" --version)"
test "$actual" = '${version}'
"\${isolated_env[@]}" "$prefix/bin/cyrus" --help > /dev/null
printf 'Verified Cyrus %s at %s/bin/cyrus\\n' "$actual" "$prefix"
`,
	);
	writeFileSync(
		join(staging, "INSTALL.md"),
		`# Cyrus test artifact ${version}

Source: ${sourceSha}
Workflow: ${workflowSha}

Verify the outer SHA256SUMS against the workflow summary before extracting.
Then run bash install.sh /absolute/path/to/disposable-prefix here. The prefix
must not exist (symlinks are refused too); its parent directory must exist.
The installer creates private test-home/cache directories beneath that prefix,
uses empty npm config files and a clean child environment for installation and
CLI checks, and preserves the caller's installation, home, auth and configuration.
All ${packages.length} coordinated packages are installed together. npm downloads
external dependencies; no Cyrus prerelease needs to exist on the registry.
Use the resulting prefix/bin/cyrus with a separate --cyrus-home for testing.
This artifact is not an npm publication, stable release, or provider acceptance proof.
`,
	);
	const members = [...expected, "manifest.json", "install.sh", "INSTALL.md"];
	writeFileSync(
		join(staging, "SHA256SUMS"),
		members.map((file) => `${sha256(join(staging, file))}  ${file}\n`).join(""),
	);
	const archive = `${bundleName}.tar.gz`;
	run("tar", [
		"-czf",
		join(resolve(outputDir), archive),
		"-C",
		resolve(outputDir),
		bundleName,
	]);
	copyFileSync(
		join(staging, "manifest.json"),
		join(outputDir, "manifest.json"),
	);
	writeFileSync(
		join(outputDir, "SHA256SUMS"),
		[archive, "manifest.json"]
			.map((file) => `${sha256(join(outputDir, file))}  ${file}\n`)
			.join(""),
	);
	rmSync(staging, { recursive: true });
	console.log(
		`Verified ${packages.length} packages; bundle: ${join(outputDir, archive)}`,
	);
	return manifest;
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [command, ...args] = process.argv.slice(2);
	if (command === "validate" && args.length === 3) validateCandidate(...args);
	else if (command === "bundle" && args.length === 5) bundle(...args);
	else
		throw new Error(
			"Usage: test-cli-artifacts.mjs validate <source> <version> <sha> | bundle <version> <source-sha> <workflow-sha> <packages-dir> <new-output-dir>",
		);
}
