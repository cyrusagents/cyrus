import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { releasePackages } from "./release-packages.mjs";
import { provenance } from "./test-release.mjs";

// This program is only run in the unprivileged, post-publication install job.
const stamp = provenance();
const root = join(process.env.RUNNER_TEMP, "npm-channel-install");
mkdirSync(root, { mode: 0o700 });
for (const dir of ["home", "cache", "tmp", "prefix"])
	mkdirSync(join(root, dir), { mode: 0o700 });
for (const file of ["user.npmrc", "global.npmrc"])
	writeFileSync(join(root, file), "", { mode: 0o600 });
const env = {
	PATH: process.env.PATH,
	HOME: join(root, "home"),
	TMPDIR: join(root, "tmp"),
	NPM_CONFIG_USERCONFIG: join(root, "user.npmrc"),
	NPM_CONFIG_GLOBALCONFIG: join(root, "global.npmrc"),
	NPM_CONFIG_CACHE: join(root, "cache"),
	CYRUS_SENTRY_DISABLED: "1",
};
const call = (bin, args) =>
	execFileSync(bin, args, {
		env,
		cwd: root,
		encoding: "utf8",
		timeout: 300000,
	});
const proof = {
	version: stamp.version,
	sourceSha: stamp.sourceSha,
	node: process.version,
	npm: call("npm", ["--version"]).trim(),
	channel: stamp.channel,
};
try {
	const args = [
		"install",
		"--global",
		"--prefix",
		join(root, "prefix"),
		`cyrus-ai@${stamp.channel}`,
		"--registry=https://registry.npmjs.org",
		"--no-audit",
		"--no-fund",
	];
	proof.command = `npm install -g cyrus-ai@${stamp.channel}`;
	call("npm", args);
	const cli = join(root, "prefix/bin/cyrus");
	if (call(cli, ["--version"]).trim() !== stamp.version)
		throw new Error("Installed CLI version differs from channel request.");
	call(cli, ["--help"]);
	proof.cli = true;
	const cliPackage = join(
		root,
		"prefix/lib/node_modules/cyrus-ai/package.json",
	);
	const visited = new Map(),
		manifestPaths = new Map();
	function walk(manifestPath) {
		const p = JSON.parse(readFileSync(manifestPath, "utf8"));
		if (visited.has(p.name)) return;
		manifestPaths.set(p.name, manifestPath);
		visited.set(p.name, {
			version: p.version,
			sourceSha: p.cyrusTestRelease?.sourceSha,
		});
		if (releasePackages.some((x) => x.name === p.name)) {
			if (
				p.version !== stamp.version ||
				JSON.stringify(p.cyrusTestRelease) !== JSON.stringify(stamp)
			)
				throw new Error(`Installed provenance mismatch: ${p.name}`);
		}
		const r = createRequire(manifestPath);
		for (const name of Object.keys(p.dependencies ?? {}).filter((n) =>
			releasePackages.some((x) => x.name === n),
		)) {
			// Resolve each dependency from its actual consumer; exports may hide package.json.
			const dependencyManifest = r.resolve
				.paths(name)
				.map((dir) => join(dir, name, "package.json"))
				.find(existsSync);
			if (!dependencyManifest) throw new Error(`Cannot find ${name}`);
			walk(dependencyManifest);
		}
	}
	walk(cliPackage);
	for (const { name } of releasePackages)
		if (!visited.has(name))
			throw new Error(`Installed CLI graph is missing ${name}`);
	proof.packages = Object.fromEntries(visited);
	// npm 12 defaults to blocking dependency install scripts: cloudflared's
	// binary postinstall must be allowed explicitly before claiming tunnel support.
	const cloudflareReq = createRequire(
		manifestPaths.get("cyrus-cloudflare-tunnel-client"),
	);
	const cloudflare = await import(cloudflareReq.resolve("cloudflared"));
	const binary = cloudflare.bin;
	if (!binary) throw new Error("Cannot resolve cloudflared executable");
	proof.cloudflaredBeforeApproval = existsSync(binary);
	if (Number(proof.npm.split(".")[0]) >= 12) {
		call("npm", [
			"rebuild",
			"--global",
			"--prefix",
			join(root, "prefix"),
			"--allow-scripts=cloudflared",
			"cloudflared",
		]);
		proof.npm12RequiredStep =
			"npm rebuild -g --allow-scripts=cloudflared cloudflared";
	}
	proof.cloudflared = call(binary, ["--version"]).trim();
	proof.passed = true;
} catch (error) {
	proof.passed = false;
	proof.error = error.message;
	process.exitCode = 1;
} finally {
	writeFileSync(
		join(root, "install-proof.json"),
		JSON.stringify(proof, null, 2),
	);
	console.log(JSON.stringify(proof, null, 2));
}
