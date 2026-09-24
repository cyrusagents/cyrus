#!/usr/bin/env node
import { access, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	relative,
	resolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function inside(parent, child) {
	const path = relative(parent, child);
	return (
		path !== ".." &&
		!path.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) &&
		!isAbsolute(path)
	);
}

export async function verifyRelease(directory) {
	const root = await realpath(directory);
	const entrypoint = join(root, "apps/cli/dist/src/app.js");
	const edgeWorker = await realpath(
		createRequire(entrypoint).resolve("miko-edge-worker"),
	);
	const core = await realpath(createRequire(edgeWorker).resolve("miko-core"));
	const expectedWorker = await realpath(
		join(root, "packages/edge-worker/dist/index.js"),
	);
	const expectedCore = await realpath(
		join(root, "packages/core/dist/index.js"),
	);
	if (edgeWorker !== expectedWorker || core !== expectedCore)
		throw Error(
			"Miko dependencies must resolve to the built workspace packages",
		);
	for (const path of [edgeWorker, core]) {
		if (!inside(root, path))
			throw Error(
				"A Miko workspace dependency resolves outside the source release: " +
					path,
			);
	}
	for (const path of [
		entrypoint,
		join(dirname(edgeWorker), "StatusBoard.js"),
		join(dirname(edgeWorker), "BoardHistory.js"),
		join(dirname(edgeWorker), "board/index.html"),
		join(dirname(edgeWorker), "board/app.js"),
		join(dirname(edgeWorker), "board/app.css"),
	])
		await access(path);
	return { entrypoint, edgeWorker, core };
}

export async function readInstallation(root) {
	const info = JSON.parse(await readFile(join(root, "current.json"), "utf8"));
	if (
		info.repository !== "https://github.com/mikoagents/miko.git" ||
		!/^[a-f0-9]{40}$/.test(info.commit) ||
		typeof info.release !== "string" ||
		!/^source-[a-zA-Z0-9]+$/.test(info.release) ||
		basename(info.release) !== info.release
	)
		throw Error("Invalid fork installation metadata");
	const releases = await realpath(join(root, "releases"));
	const checkout = await realpath(join(releases, info.release));
	if (!inside(releases, checkout))
		throw Error("Source release is outside the installation directory");
	return { ...info, checkout, ...(await verifyRelease(checkout)) };
}

async function main() {
	const info = await readInstallation(dirname(fileURLToPath(import.meta.url)));
	if (process.argv[2] === "--installation") {
		console.log(JSON.stringify(info, null, 2));
		return;
	}
	// Import in this process so Miko owns signals and its normal shutdown hooks.
	process.argv[1] = info.entrypoint;
	await import(pathToFileURL(info.entrypoint).href);
}

if (
	process.argv[1] &&
	resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
	main().catch((error) => {
		console.error(`Miko fork: ${error.message}`);
		process.exitCode = 1;
	});
}
