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

export async function readInstallation(root, filename = "current.json") {
	const info = JSON.parse(await readFile(join(root, filename), "utf8"));
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
	const root = dirname(fileURLToPath(import.meta.url));
	let trial;
	try {
		trial = JSON.parse(
			await readFile(join(root, "update-state.json"), "utf8"),
		).trial;
	} catch (error) {
		if (error.code !== "ENOENT") throw error;
	}
	// A crash during activation may leave the candidate incomplete. Load the
	// known-good supervisor to recover before trying to import candidate code.
	const info = await readInstallation(
		root,
		trial ? "previous.json" : "current.json",
	);
	if (process.argv[2] === "--installation") {
		console.log(JSON.stringify(info, null, 2));
		return;
	}
	const args = process.argv.slice(2);
	// One-shot commands (authentication, --version, --help) must never start
	// background checks. The managed worker owns its ordinary shutdown hooks.
	const commands = args.filter((arg, index) => {
		if (index > 0 && ["--miko-home", "--env-file"].includes(args[index - 1]))
			return false;
		return !arg.startsWith("-");
	});
	if (
		!args.some((arg) => ["--version", "-V", "--help", "-h"].includes(arg)) &&
		(commands.length === 0 ||
			(commands.length === 1 && commands[0] === "start"))
	) {
		const modulePath = join(
			info.checkout,
			"skills/miko-setup-prerequisites/scripts/auto-update.mjs",
		);
		const hasSupervisor = await access(modulePath).then(
			() => true,
			(error) => {
				if (error.code === "ENOENT") return false;
				throw error;
			},
		);
		if (hasSupervisor) {
			const { runManaged } = await import(pathToFileURL(modulePath).href);
			process.exitCode = await runManaged(root, args);
			return;
		}
		console.warn(
			"This pinned release predates automatic updates; starting it directly.",
		);
	}
	// Authentication and inspection commands run directly without supervision.
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
