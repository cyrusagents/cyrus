import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { releasePackages } from "./release-packages.mjs";
import { validateRequest } from "./test-cli-artifacts.mjs";

export function request(env = process.env) {
	const {
		REQUESTED_VERSION: version,
		CANDIDATE_SHA: sourceSha,
		DIST_TAG: channel,
		GITHUB_SHA: workflowSha,
	} = env;
	validateRequest(version, sourceSha, workflowSha);
	if (!/^test(?:-[a-z0-9]+)*$/.test(channel ?? "") || channel.endsWith("\n"))
		throw new Error(
			"Test releases require a dedicated test or test-* channel.",
		);
	return { version, sourceSha, channel, workflowSha };
}
export function provenance(env = process.env) {
	const { version, sourceSha, channel } = request(env);
	return {
		schemaVersion: 1,
		repository: "https://github.com/cyrusagents/cyrus",
		sourceSha,
		version,
		channel,
	};
}
export function inspect(directory, env = process.env) {
	const r = request(env),
		stamp = provenance(env);
	const expected = releasePackages.map(
		({ name }) => `${name}-${r.version}.tgz`,
	);
	const files = readdirSync(directory)
		.filter((f) => f !== "test-manifest.json" && f !== "registry-proof.json")
		.sort();
	if (JSON.stringify(files) !== JSON.stringify([...expected].sort()))
		throw new Error("Incomplete or unexpected test package graph.");
	const names = new Set(releasePackages.map((p) => p.name));
	const packages = releasePackages.map(({ name }, i) => {
		const file = expected[i],
			path = join(directory, file);
		if (!lstatSync(path).isFile())
			throw new Error("Test package must be a regular file.");
		const p = JSON.parse(
			execFileSync("tar", ["-xOf", path, "package/package.json"], {
				encoding: "utf8",
			}),
		);
		if (
			p.name !== name ||
			p.version !== r.version ||
			JSON.stringify(p.cyrusTestRelease) !== JSON.stringify(stamp)
		)
			throw new Error(`Identity/provenance mismatch: ${name}`);
		if (
			Object.entries(p.publishConfig ?? {}).some(
				([k, v]) => k !== "access" || v !== "public",
			)
		)
			throw new Error(`Unsafe publishConfig: ${name}`);
		for (const group of [
			"dependencies",
			"optionalDependencies",
			"peerDependencies",
		])
			for (const [dep, range] of Object.entries(p[group] ?? {})) {
				if (
					String(range).startsWith("workspace:") ||
					(names.has(dep) && range !== r.version)
				)
					throw new Error(`Dependency drift: ${name} -> ${dep}`);
			}
		return {
			name,
			file,
			sha256: createHash("sha256").update(readFileSync(path)).digest("hex"),
		};
	});
	return { schemaVersion: 1, ...r, packages };
}
export function verify(directory, env = process.env) {
	const expected = inspect(directory, env);
	const actual = JSON.parse(
		readFileSync(join(directory, "test-manifest.json"), "utf8"),
	);
	if (JSON.stringify(actual) !== JSON.stringify(expected))
		throw new Error(
			"Test manifest hashes or immutable provenance do not match.",
		);
	return expected;
}
if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	const [cmd, directory] = process.argv.slice(2);
	if (cmd === "stamp") {
		const stamp = provenance();
		for (const { directory: sub } of releasePackages) {
			const path = join(directory, sub, "package.json"),
				p = JSON.parse(readFileSync(path, "utf8"));
			if (p.version !== stamp.version)
				throw new Error("Version drift before stamping.");
			p.cyrusTestRelease = stamp;
			writeFileSync(path, `${JSON.stringify(p, null, 2)}\n`);
		}
	} else if (cmd === "manifest")
		writeFileSync(
			join(directory, "test-manifest.json"),
			`${JSON.stringify(inspect(directory), null, 2)}\n`,
		);
	else if (cmd === "verify") verify(directory);
	else throw new Error("Use stamp, manifest or verify with a directory.");
}
