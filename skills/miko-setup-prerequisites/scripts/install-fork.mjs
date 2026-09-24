#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
	mkdir,
	mkdtemp,
	open,
	readFile,
	rename,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { readInstallation, verifyRelease } from "./miko.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const source = JSON.parse(await readFile(join(scripts, "source.json"), "utf8"));
const windows = process.platform === "win32";
const defaultRoot = windows
	? join(process.env.LOCALAPPDATA || join(homedir(), "AppData/Local"), "Miko")
	: join(homedir(), ".local/share/miko");

function run(command, args, cwd, env = process.env, capture = false) {
	const result = spawnSync(command, args, {
		cwd,
		env,
		windowsHide: true,
		encoding: "utf8",
		stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0)
		throw Error(
			command +
				" failed (" +
				result.status +
				"). " +
				(capture ? result.stderr : "See output above."),
		);
	return result.stdout?.trim();
}

function pnpm(version, args, cwd, env) {
	if (!/^\d+\.\d+\.\d+$/.test(version)) throw Error("Unsupported pnpm version");
	const command = ["--yes", `pnpm@${version}`, ...args];
	if (windows) {
		// Only internal, validated tokens enter cmd.exe. User paths stay in cwd/env.
		if (!command.every((arg) => /^[a-zA-Z0-9@=._-]+$/.test(arg)))
			throw Error("Invalid package-manager argument");
		run(
			process.env.ComSpec || "cmd.exe",
			["/d", "/s", "/c", `npx ${command.join(" ")}`],
			cwd,
			env,
		);
	} else run("npx", command, cwd, env);
}

async function atomicWrite(path, content) {
	const temporary = `${path}.${process.pid}.tmp`;
	await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
	await rename(temporary, path);
}

async function install() {
	const { values } = parseArgs({
		options: {
			ref: { type: "string", default: source.ref },
			"install-dir": { type: "string", default: defaultRoot },
			help: { type: "boolean", default: false },
		},
	});
	if (values.help) {
		console.log(
			"node install-fork.mjs [--ref <commit-or-branch>] [--install-dir <directory>]",
		);
		console.log(`Source: ${source.repository} @ ${source.ref}`);
		console.log(`Default directory: ${defaultRoot}`);
		return;
	}
	if (Number(process.versions.node.split(".")[0]) < 22)
		throw Error("Node.js 22 or later is required");
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(values.ref))
		throw Error("Invalid Git ref");
	const root = resolve(values["install-dir"]);
	await mkdir(root, { recursive: true });
	const lockPath = join(root, "install.lock");
	let lock;
	try {
		lock = await open(lockPath, "wx");
	} catch (error) {
		if (error.code === "EEXIST")
			throw Error(
				"Another install may be running. Check " +
					lockPath +
					" before retrying.",
			);
		throw error;
	}
	let checkout;
	try {
		await lock.writeFile(String(process.pid));
		// A verified immutable pin can be reused; branch overrides are fetched again.
		if (
			/^[a-f0-9]{40}$/.test(values.ref) &&
			existsSync(join(root, "current.json"))
		) {
			const previous = await readInstallation(root);
			if (previous.commit === values.ref) {
				await atomicWrite(
					join(root, "miko.mjs"),
					await readFile(join(scripts, "miko.mjs")),
				);
				console.log(`Already installed and verified: ${previous.commit}`);
				console.log(`Launcher: ${join(root, "miko.mjs")}`);
				return;
			}
		}
		const env = { ...process.env, HUSKY: "0" };
		if (windows) {
			const gitExecPath = run("git", ["--exec-path"], root, env, true);
			const bash =
				process.env.MIKO_BUILD_SHELL ||
				resolve(gitExecPath, "../../..", "bin/bash.exe");
			if (!existsSync(bash))
				throw Error(
					"Git Bash is required. Install Git for Windows or set MIKO_BUILD_SHELL to bash.exe.",
				);
			env.npm_config_script_shell = bash;
		}
		await mkdir(join(root, "releases"), { recursive: true });
		checkout = await mkdtemp(join(root, "releases/source-"));
		// Build in the final location: moving pnpm Windows junctions would break them.
		run("git", ["init", "--quiet", checkout], root, env);
		run("git", ["remote", "add", "origin", source.repository], checkout, env);
		run("git", ["fetch", "--depth", "1", "origin", values.ref], checkout, env);
		const commit = run("git", ["rev-parse", "FETCH_HEAD"], checkout, env, true);
		if (!/^[a-f0-9]{40}$/.test(commit))
			throw Error("Git did not resolve a commit");
		if (/^[a-f0-9]{40}$/.test(values.ref) && commit !== values.ref)
			throw Error("Git returned a different commit");
		run("git", ["checkout", "--quiet", "--detach", commit], checkout, env);
		const pkg = JSON.parse(
			await readFile(join(checkout, "package.json"), "utf8"),
		);
		const version = /^pnpm@(\d+\.\d+\.\d+)$/.exec(pkg.packageManager)?.[1];
		if (!version) throw Error("Source does not declare an exact pnpm version");
		pnpm(
			version,
			["--filter", "miko...", "install", "--prod=false", "--frozen-lockfile"],
			checkout,
			env,
		);
		pnpm(version, ["--filter", "miko...", "build"], checkout, env);
		const { entrypoint } = await verifyRelease(checkout);
		// Version verification uses an empty config home, never existing credentials.
		const verificationHome = await mkdtemp(join(root, "verify-"));
		run(
			process.execPath,
			[entrypoint, "--miko-home", verificationHome, "--version"],
			checkout,
			{ ...env, MIKO_HOME: verificationHome, MIKO_SENTRY_DISABLED: "1" },
		);
		const info = {
			repository: source.repository,
			requestedRef: values.ref,
			commit,
			release: basename(checkout),
			installedAt: new Date().toISOString(),
			nodeVersion: process.version,
			pnpmVersion: version,
		};
		const json = `${JSON.stringify(info, null, 2)}\n`;
		await writeFile(join(checkout, "fork-install.json"), json);
		if (existsSync(join(root, "current.json"))) {
			await atomicWrite(
				join(root, "previous.json"),
				await readFile(join(root, "current.json")),
			);
		}
		await atomicWrite(
			join(root, "miko.mjs"),
			await readFile(join(scripts, "miko.mjs")),
		);
		await atomicWrite(join(root, "current.json"), json);
		console.log(`Installed mikoagents/miko @ ${commit}`);
		console.log(`Launcher: ${join(root, "miko.mjs")}`);
		console.log(`Verify: node "${join(root, "miko.mjs")}" --installation`);
		console.log(`Start:  node "${join(root, "miko.mjs")}" start`);
		console.log(
			"Existing services were not restarted. Use this launcher for all setup commands.",
		);
	} catch (error) {
		if (checkout)
			console.error(`Incomplete source checkout retained at: ${checkout}`);
		throw error;
	} finally {
		await lock.close();
		await unlink(lockPath);
	}
}

install().catch((error) => {
	console.error(`Fork installation failed: ${error.message}`);
	process.exitCode = 1;
});
