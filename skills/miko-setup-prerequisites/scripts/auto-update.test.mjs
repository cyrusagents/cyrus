import assert from "node:assert/strict";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { UpdateSupervisor } from "./auto-update.mjs";
import { acquireInstallLock } from "./install-state.mjs";

const scripts = dirname(fileURLToPath(import.meta.url));
const A = "a".repeat(40);
const B = "b".repeat(40);
const disposers = [];
afterEach(async () => {
	for (const dispose of disposers.splice(0).reverse()) await dispose();
});

async function json(path) {
	return JSON.parse(await readFile(path, "utf8"));
}
async function waitFor(condition) {
	const until = Date.now() + 8_000;
	while (!(await condition())) {
		assert.ok(Date.now() < until, "Timed out waiting for update state");
		await delay(10);
	}
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "miko-auto-update-"));
	disposers.push(() => rm(root, { recursive: true, force: true }));
	const runtime = (commit) => `
const fs = require('node:fs');
const path = require('node:path');
const root = ${JSON.stringify(root)};
fs.appendFileSync(path.join(root, 'events'), 'start ${commit}\\n');
process.on('message', message => {
  if (message.type === 'miko:activate-update') { process.send({type: 'miko:activated'}); return; }
  if (message.type !== 'miko:prepare-update') return;
  const accepted = !fs.existsSync(path.join(root, 'busy'));
  process.send({type: 'miko:update-restart', accepted}, () => {
    if (accepted) { fs.appendFileSync(path.join(root, 'events'), 'stop ${commit}\\n'); process.exit(0); }
  });
});
process.on('SIGTERM', () => process.exit(0));
process.send({type: 'miko:ready', autoUpdate: process.env.MIKO_AUTO_UPDATE !== 'false'});
`;
	async function release(commit, code = runtime(commit)) {
		const name = `source-${commit.slice(0, 8)}`;
		const checkout = join(root, "releases", name);
		const entry = join(checkout, "apps/cli/dist/src/app.js");
		await mkdir(dirname(entry), { recursive: true });
		await writeFile(entry, code);
		await mkdir(join(checkout, "node_modules"), { recursive: true });
		for (const name of ["core", "edge-worker"]) {
			const pkg = join(checkout, "packages", name);
			await mkdir(join(pkg, "dist"), { recursive: true });
			await writeFile(
				join(pkg, "package.json"),
				JSON.stringify({ name: `miko-${name}`, main: "dist/index.js" }),
			);
			await writeFile(join(pkg, "dist/index.js"), "");
			await symlink(
				pkg,
				join(checkout, `node_modules/miko-${name}`),
				process.platform === "win32" ? "junction" : "dir",
			);
		}
		const worker = join(checkout, "packages/edge-worker/dist");
		await mkdir(join(worker, "board"));
		for (const name of [
			"StatusBoard.js",
			"BoardHistory.js",
			"board/index.html",
			"board/app.js",
			"board/app.css",
		])
			await writeFile(join(worker, name), "");
		await cp(
			scripts,
			join(checkout, "skills/miko-setup-prerequisites/scripts"),
			{ recursive: true },
		);
		return {
			repository: "https://github.com/mikoagents/miko.git",
			commit,
			release: name,
			autoUpdate: true,
			updateRef: "main",
		};
	}
	const initial = await release(A);
	await writeFile(join(root, "current.json"), JSON.stringify(initial));
	await writeFile(join(root, "miko.mjs"), "old bootstrap");
	return { root, initial, release };
}

function supervise(root, overrides = {}) {
	const supervisor = new UpdateSupervisor(root, ["start"], {
		pollInterval: 10,
		firstCheckDelay: 0,
		checkInterval: 100_000,
		retryInterval: 100_000,
		startupTimeout: 2_000,
		probation: 30,
		log: () => {},
		latestCommit: async () => B,
		...overrides,
	});
	const running = supervisor.run();
	// Attach rejection handling immediately, but still surface errors in cleanup.
	running.catch(() => {});
	disposers.push(async () => {
		await supervisor.stop();
		await running;
	});
	return supervisor;
}

test("builds off-process, waits for idle, then starts the candidate after the old worker exits", async () => {
	const { root, release } = await fixture();
	const candidate = await release(B);
	await writeFile(join(root, "busy"), "busy");
	let builds = 0;
	const supervisor = supervise(root, {
		stageRelease: async () => {
			builds++;
			assert.equal((await json(join(root, "current.json"))).commit, A);
			await writeFile(join(root, "pending.json"), JSON.stringify(candidate));
		},
	});
	await waitFor(() => supervisor.state.status === "waiting-for-idle");
	await delay(60);
	assert.equal((await json(join(root, "current.json"))).commit, A);
	assert.equal(builds, 1);
	await unlink(join(root, "busy"));
	await waitFor(() => supervisor.state.status === "up-to-date");
	assert.equal((await json(join(root, "current.json"))).commit, B);
	assert.equal((await json(join(root, "previous.json"))).commit, A);
	assert.equal(
		await readFile(join(root, "events"), "utf8"),
		`start ${A}\nstop ${A}\nstart ${B}\n`,
	);
	assert.equal(
		await readFile(join(root, "miko.mjs"), "utf8"),
		await readFile(join(scripts, "miko.mjs"), "utf8"),
	);
});

test("network or build failure keeps the original worker and selected version", async () => {
	for (const failure of ["network", "build"]) {
		const { root } = await fixture();
		const supervisor = supervise(root, {
			latestCommit: async () => {
				if (failure === "network") throw Error("offline");
				return B;
			},
			stageRelease: async () => {
				throw Error("build failed");
			},
		});
		await waitFor(() => supervisor.state.status === "retrying");
		assert.equal((await json(join(root, "current.json"))).commit, A);
		assert.equal(await readFile(join(root, "events"), "utf8"), `start ${A}\n`);
		assert.equal(supervisor.worker.exited, false);
	}
});

test("failed candidate startup automatically rolls back and suppresses that commit", async () => {
	const { root, release } = await fixture();
	const candidate = await release(B, "process.exit(1)");
	const supervisor = supervise(root, {
		stageRelease: async () =>
			writeFile(join(root, "pending.json"), JSON.stringify(candidate)),
	});
	await waitFor(
		() =>
			supervisor.state.status === "rolled-back" && supervisor.info.commit === A,
	);
	assert.equal((await json(join(root, "current.json"))).commit, A);
	assert.equal(supervisor.state.failedCommit, B);
	assert.equal(supervisor.state.trial, null);
	await supervisor.check();
	assert.equal(supervisor.state.status, "rolled-back");
});

test("restart recovers an interrupted activation even when candidate artifacts are missing", async () => {
	const { root, initial } = await fixture();
	await writeFile(join(root, "previous.json"), JSON.stringify(initial));
	await writeFile(
		join(root, "current.json"),
		JSON.stringify({ ...initial, commit: B, release: "source-missing" }),
	);
	await writeFile(
		join(root, "update-state.json"),
		JSON.stringify({ trial: B }),
	);
	const supervisor = supervise(root, { latestCommit: async () => A });
	await waitFor(() => supervisor.info?.commit === A);
	assert.equal((await json(join(root, "current.json"))).commit, A);
	assert.equal(supervisor.state.failedCommit, B);
});

test("pinned installs do not check or build updates", async () => {
	const { root, initial } = await fixture();
	await writeFile(
		join(root, "current.json"),
		JSON.stringify({ ...initial, autoUpdate: false }),
	);
	let checks = 0;
	const supervisor = supervise(root, {
		latestCommit: async () => {
			checks++;
			return B;
		},
	});
	await waitFor(() => supervisor.enabled === false);
	await delay(80);
	assert.equal(checks, 0);
});

test("an unchanged remote head does not invoke the installer", async () => {
	const { root } = await fixture();
	let builds = 0;
	const supervisor = supervise(root, {
		latestCommit: async () => A,
		stageRelease: async () => {
			builds++;
		},
	});
	await waitFor(() => supervisor.state.status === "up-to-date");
	assert.equal(builds, 0);
});

test("supervisor shutdown cancels an in-flight build and stops its worker", async () => {
	const { root } = await fixture();
	let cancelled = false;
	const supervisor = supervise(root, {
		stageRelease: async (_root, _info, _commit, signal) =>
			new Promise((resolve) => {
				signal.addEventListener(
					"abort",
					() => {
						cancelled = true;
						resolve();
					},
					{ once: true },
				);
			}),
	});
	await waitFor(() => supervisor.buildAbort);
	await supervisor.stop();
	assert.equal(cancelled, true);
	assert.equal(supervisor.worker.exited, true);
	assert.equal((await json(join(root, "current.json"))).commit, A);
});

test("a live installation lock prevents activation without stopping the current worker", async () => {
	const { root, release } = await fixture();
	const candidate = await release(B);
	const releaseLock = await acquireInstallLock(root);
	disposers.push(releaseLock);
	await writeFile(join(root, "pending.json"), JSON.stringify(candidate));
	const supervisor = supervise(root);
	await waitFor(() => supervisor.state.status === "retrying");
	assert.equal((await json(join(root, "current.json"))).commit, A);
	assert.equal(await readFile(join(root, "events"), "utf8"), `start ${A}\n`);
});
