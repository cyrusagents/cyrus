/** Verify an extracted local-only bundle and every installed consumer's copy.
 * No registry access, publication, Docker, credential or model calls.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackages } from "./release-packages.mjs";

export function verifyLocalArtifact(
	bundleDirectory,
	prefix,
	expectedSourceSha,
) {
	assert.match(expectedSourceSha, /^[a-f0-9]{40}$/);
	const directory = resolve(bundleDirectory),
		installed = realpathSync(prefix);
	const manifest = JSON.parse(
		readFileSync(join(directory, "manifest.json"), "utf8"),
	);
	assert.equal(manifest.kind, "test-only");
	assert.equal(manifest.sourceSha, expectedSourceSha);
	const names = new Set(releasePackages.map((p) => p.name));
	assert.equal(manifest.packages.length, names.size);
	assert.deepEqual(
		manifest.packages.map((p) => p.name).sort(),
		[...names].sort(),
	);
	for (const entry of manifest.packages) {
		assert.equal(entry.version, manifest.version);
		assert.equal(entry.file, `${entry.name}-${manifest.version}.tgz`);
		const bytes = readFileSync(join(directory, entry.file));
		assert.equal(
			createHash("sha256").update(bytes).digest("hex"),
			entry.sha256,
		);
		assert.equal(bytes.length, entry.bytes);
	}
	const visited = new Set(),
		found = new Set();
	function walk(file) {
		const actual = realpathSync(file),
			within = relative(installed, actual);
		assert(
			within !== ".." && !within.startsWith("../"),
			"Dependency resolved outside isolated prefix",
		);
		if (visited.has(actual)) return;
		visited.add(actual);
		const p = JSON.parse(readFileSync(actual, "utf8"));
		assert(names.has(p.name), `Unexpected internal package ${p.name}`);
		assert.equal(p.version, manifest.version, `Version mismatch: ${p.name}`);
		assert.deepEqual(
			p.cyrusLocalTestArtifact,
			{ sourceSha: expectedSourceSha, kind: "unpublished-test-only" },
			`Local provenance mismatch: ${p.name}`,
		);
		assert.equal(
			p.cyrusTestRelease,
			undefined,
			`Registry release stamp must not stand in for local provenance: ${p.name}`,
		);
		found.add(p.name);
		const r = createRequire(actual);
		for (const [name, range] of Object.entries(p.dependencies ?? {})) {
			if (!names.has(name)) continue;
			assert.equal(
				range,
				manifest.version,
				`Dependency version mismatch: ${p.name} -> ${name}`,
			);
			const target = r.resolve
				.paths(name)
				.map((dir) => join(dir, name, "package.json"))
				.find(existsSync);
			assert(target, `Missing internal dependency ${name}`);
			assert.equal(JSON.parse(readFileSync(target, "utf8")).name, name);
			walk(target);
		}
	}
	walk(join(installed, "lib/node_modules/cyrus-ai/package.json"));
	assert.deepEqual([...found].sort(), [...names].sort());
	return {
		passed: true,
		sourceSha: expectedSourceSha,
		version: manifest.version,
		packages: found.size,
		installedCopies: visited.size,
		provenanceField: "cyrusLocalTestArtifact",
		registryPublication: false,
	};
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [directory, prefix, sha] = process.argv.slice(2);
	if (!directory || !prefix || !sha)
		throw Error(
			"Usage: verify-local-artifact.mjs EXTRACTED_BUNDLE INSTALLED_PREFIX SOURCE_SHA",
		);
	console.log(
		JSON.stringify(verifyLocalArtifact(directory, prefix, sha), null, 2),
	);
}
