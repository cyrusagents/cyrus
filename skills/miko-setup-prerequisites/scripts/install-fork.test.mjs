import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";
import { readInstallation, verifyRelease } from "./miko.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const temporary = [];
afterEach(async () => {
	for (const root of temporary.splice(0))
		await rm(root, { recursive: true, force: true });
});

async function fixture() {
	const root = await realpath(await mkdtemp(join(tmpdir(), "miko-fork-test-")));
	temporary.push(root);
	const release = join(root, "releases/source-test");
	const entry = join(release, "apps/cli/dist/src/app.js");
	await mkdir(dirname(entry), { recursive: true });
	await writeFile(
		entry,
		"console.log(JSON.stringify(process.argv.slice(2))); if (process.send) process.send({type: 'miko:ready', autoUpdate: false}, () => process.disconnect());",
	);
	await mkdir(join(release, "node_modules"), { recursive: true });
	for (const name of ["core", "edge-worker"]) {
		const pkg = join(release, "packages", name);
		await mkdir(join(pkg, "dist"), { recursive: true });
		await writeFile(
			join(pkg, "package.json"),
			JSON.stringify({ name: `miko-${name}`, main: "dist/index.js" }),
		);
		await writeFile(join(pkg, "dist/index.js"), "");
		await symlink(
			pkg,
			join(release, `node_modules/miko-${name}`),
			process.platform === "win32" ? "junction" : "dir",
		);
	}
	const worker = join(release, "packages/edge-worker/dist");
	await mkdir(join(worker, "board"));
	for (const file of [
		"StatusBoard.js",
		"BoardHistory.js",
		"board/index.html",
		"board/app.js",
		"board/app.css",
	])
		await writeFile(join(worker, file), "");
	const info = {
		repository: "https://github.com/mikoagents/miko.git",
		commit: "a".repeat(40),
		release: "source-test",
	};
	await writeFile(join(root, "current.json"), JSON.stringify(info));
	await copyFile(join(scripts, "miko.mjs"), join(root, "miko.mjs"));
	await cp(scripts, join(release, "skills/miko-setup-prerequisites/scripts"), {
		recursive: true,
	});
	return { root, release, entry, worker };
}

test("the launcher verifies workspace artifacts and forwards CLI arguments", async () => {
	const { root, entry } = await fixture();
	const info = await readInstallation(root);
	assert.equal(info.entrypoint, entry);
	const result = spawnSync(
		process.execPath,
		[join(root, "miko.mjs"), "--miko-home", "a path with spaces", "start"],
		{ encoding: "utf8" },
	);
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(JSON.parse(result.stdout), [
		"--miko-home",
		"a path with spaces",
		"start",
	]);
});

test("published-package fallback inside the checkout is rejected", async () => {
	const { release } = await fixture();
	const substitute = join(release, "registry-package");
	await mkdir(substitute);
	await writeFile(
		join(substitute, "package.json"),
		'{"name":"miko-edge-worker","main":"index.js"}',
	);
	await writeFile(join(substitute, "index.js"), "");
	const link = join(release, "node_modules/miko-edge-worker");
	await unlink(link);
	await symlink(
		substitute,
		link,
		process.platform === "win32" ? "junction" : "dir",
	);
	await assert.rejects(verifyRelease(release), /built workspace packages/);
});

test("missing board assets and escaping release paths are rejected", async () => {
	const { root, release, worker } = await fixture();
	await unlink(join(worker, "board/app.js"));
	await assert.rejects(verifyRelease(release), /ENOENT/);
	const path = join(root, "current.json");
	const info = JSON.parse(await readFile(path));
	info.release = "../elsewhere";
	await writeFile(path, JSON.stringify(info));
	await assert.rejects(
		readInstallation(root),
		/Invalid fork installation metadata/,
	);
});

test("invalid install input and a concurrent install preserve the selected runtime", async () => {
	const { root } = await fixture();
	const selected = await readFile(join(root, "current.json"), "utf8");
	const invalid = spawnSync(
		process.execPath,
		[
			join(scripts, "install-fork.mjs"),
			"--ref",
			"bad ref",
			"--install-dir",
			root,
		],
		{ encoding: "utf8" },
	);
	assert.equal(invalid.status, 1);
	assert.match(invalid.stderr, /Invalid Git ref/);
	await writeFile(join(root, "install.lock"), "existing installer");
	const concurrent = spawnSync(
		process.execPath,
		[join(scripts, "install-fork.mjs"), "--install-dir", root],
		{ encoding: "utf8" },
	);
	assert.equal(concurrent.status, 1);
	assert.match(concurrent.stderr, /Another install may be running/);
	assert.equal(await readFile(join(root, "current.json"), "utf8"), selected);
	assert.equal(
		await readFile(join(root, "install.lock"), "utf8"),
		"existing installer",
	);
});

test("reinstalling an immutable pin records opt-out, or an explicit tracking branch", async () => {
	const { root } = await fixture();
	for (const tracking of [false, true]) {
		const result = spawnSync(
			process.execPath,
			[
				join(scripts, "install-fork.mjs"),
				"--ref",
				"a".repeat(40),
				"--install-dir",
				root,
				...(tracking ? ["--update-ref", "main"] : []),
			],
			{ encoding: "utf8" },
		);
		assert.equal(result.status, 0, result.stderr);
		const metadata = JSON.parse(
			await readFile(join(root, "current.json"), "utf8"),
		);
		assert.equal(metadata.autoUpdate, tracking);
		assert.equal(metadata.updateRef, tracking ? "main" : null);
	}
});
