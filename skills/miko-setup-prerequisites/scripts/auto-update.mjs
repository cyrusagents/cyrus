import { execFile, fork, spawn } from "node:child_process";
import { readdir, readFile, rm, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { acquireInstallLock, atomicWrite, readJson } from "./install-state.mjs";
import { readInstallation } from "./miko.mjs";

const exec = promisify(execFile);
const CHECK_INTERVAL = 6 * 60 * 60 * 1000;
const RETRY_INTERVAL = 15 * 60 * 1000;
const SCRIPT_DIR = "skills/miko-setup-prerequisites/scripts";

async function writeJson(path, value) {
	await atomicWrite(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function latestCommit(info) {
	if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(info.updateRef))
		throw Error("Invalid automatic update branch");
	const { stdout } = await exec(
		"git",
		[
			"ls-remote",
			"--exit-code",
			info.repository,
			`refs/heads/${info.updateRef}`,
		],
		{ timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
	);
	const [commit, ref] = stdout.trim().split(/\s+/);
	if (!/^[a-f0-9]{40}$/.test(commit) || ref !== `refs/heads/${info.updateRef}`)
		throw Error("Update branch did not resolve to one commit");
	return commit;
}

/** Builds off-process: the existing worker keeps serving tasks throughout. */
export function stageRelease(root, info, commit, signal) {
	return new Promise((resolve, reject) => {
		const child = spawn(
			process.execPath,
			[
				join(info.checkout, SCRIPT_DIR, "install-fork.mjs"),
				"--ref",
				commit,
				"--install-dir",
				root,
				"--update-ref",
				info.updateRef,
				"--stage-only",
			],
			{
				stdio: "inherit",
				detached: process.platform !== "win32",
				env: { ...process.env, GIT_TERMINAL_PROMPT: "0", CI: "true" },
			},
		);
		let failure;
		const stop = () => {
			failure = Error("Background update build stopped or timed out");
			if (!child.pid) return;
			if (process.platform === "win32") {
				// pnpm and git are descendants of the installer, not of the worker.
				void exec("taskkill", ["/pid", String(child.pid), "/t", "/f"]).catch(
					() => {},
				);
			} else {
				try {
					process.kill(-child.pid, "SIGTERM");
				} catch {}
			}
		};
		const timeout = setTimeout(stop, 30 * 60 * 1000);
		signal.addEventListener("abort", stop, { once: true });
		if (signal.aborted) stop();
		const cleanup = () => {
			clearTimeout(timeout);
			signal.removeEventListener("abort", stop);
		};
		child.once("error", (error) => {
			cleanup();
			reject(error);
		});
		child.once("exit", (code) => {
			cleanup();
			if (failure || code !== 0)
				reject(failure ?? Error(`Update build exited with ${code}`));
			else resolve();
		});
	});
}

function worker(info, args, startupTimeout, previousSkills, trial = false) {
	const child = fork(info.entrypoint, args, {
		stdio: ["inherit", "inherit", "inherit", "ipc"],
		execArgv: [],
		env: {
			...process.env,
			MIKO_MANAGED_WORKER: "1",
			MIKO_UPDATE_TRIAL: trial ? "1" : "0",
			...(previousSkills ? { MIKO_PREVIOUS_SKILLS_DIR: previousSkills } : {}),
		},
	});
	let exited = false;
	const exit = new Promise((resolve) => {
		child.once("exit", (code, signal) => {
			exited = true;
			resolve({ code: code ?? (signal ? 1 : 0) });
		});
		child.once("error", () => {
			exited = true;
			resolve({ code: 1 });
		});
	});
	const message = (type, timeout) =>
		new Promise((resolve, reject) => {
			const listener = (data) => {
				if (data?.type === type) {
					cleanup();
					resolve(data);
				}
			};
			const timer = setTimeout(() => {
				cleanup();
				reject(Error(`Worker timed out waiting for ${type}`));
			}, timeout);
			const onExit = () => {
				cleanup();
				reject(Error(`Worker exited before ${type}`));
			};
			const cleanup = () => {
				clearTimeout(timer);
				child.off("message", listener);
				child.off("exit", onExit);
				child.off("error", onExit);
			};
			child.on("message", listener);
			child.once("exit", onExit);
			child.once("error", onExit);
		});
	const ready = message("miko:ready", startupTimeout);
	return {
		child,
		ready,
		exit,
		get exited() {
			return exited;
		},
		async requestRestart() {
			if (exited || !child.connected) return false;
			const response = message("miko:update-restart", 10_000);
			child.send({ type: "miko:prepare-update" });
			return (await response).accepted === true;
		},
		async activate() {
			const response = message("miko:activated", 10_000);
			child.send({ type: "miko:activate-update" });
			await response;
		},
		async stop() {
			if (exited) return;
			child.kill("SIGTERM");
			const timer = setTimeout(() => child.kill("SIGKILL"), 30_000);
			await exit;
			clearTimeout(timer);
		},
	};
}

/**
 * The installed launcher owns worker restarts, including foreground installs.
 * IPC readiness/draining is private to this parent and its own child; no HTTP
 * endpoint can trigger installation or restart a different Miko instance.
 */
export class UpdateSupervisor {
	constructor(root, args, options = {}) {
		this.root = root;
		this.args = args;
		this.options = {
			pollInterval: 30_000,
			firstCheckDelay: 60_000 + Math.random() * 60_000,
			checkInterval: CHECK_INTERVAL,
			retryInterval: RETRY_INTERVAL,
			failedRetryInterval: 24 * 60 * 60 * 1000,
			startupTimeout: 120_000,
			drainTimeout: 60_000,
			probation: 30_000,
			latestCommit,
			stageRelease,
			log: (message) => console.log(`[AutoUpdate] ${message}`),
			...options,
		};
		this.abort = new AbortController();
		this.statePath = join(root, "update-state.json");
		this.state = {};
		this.stopping = false;
	}

	async saveState(patch) {
		const next = { ...this.state, ...patch };
		await writeJson(this.statePath, next);
		this.state = next;
	}

	isFailed(commit) {
		return (
			commit === this.state.failedCommit &&
			Date.now() - (this.state.failedAt ?? 0) < this.options.failedRetryInterval
		);
	}

	async recover() {
		this.state = await readJson(this.statePath, {});
		if (!this.state.trial) return;
		const releaseLock = await acquireInstallLock(this.root);
		try {
			const selected = await readJson(join(this.root, "current.json"));
			if (selected.commit === this.state.trial) {
				const previous = await readInstallation(this.root, "previous.json");
				await atomicWrite(
					join(this.root, "current.json"),
					await readFile(join(this.root, "previous.json")),
				);
				this.options.log(
					`Recovered interrupted update; restored ${previous.commit}`,
				);
			}
			await this.saveState({
				failedCommit: this.state.trial,
				failedAt: Date.now(),
				trial: null,
				status: "rolled-back",
			});
			await unlink(join(this.root, "pending.json")).catch((error) => {
				if (error.code !== "ENOENT") throw error;
			});
		} finally {
			await releaseLock();
		}
	}

	async start(info, trial = false) {
		this.info = info;
		const previous = await readInstallation(this.root, "previous.json").catch(
			() => null,
		);
		this.worker = worker(
			info,
			this.args,
			this.options.startupTimeout,
			previous
				? join(
						previous.checkout,
						"packages/edge-worker/dist/miko-skills-plugin/skills",
					)
				: undefined,
			trial,
		);
		this.worker.exit.then(() => this.buildAbort?.abort());
		const ready = await this.worker.ready;
		this.enabled =
			info.autoUpdate === true &&
			!!info.updateRef &&
			ready.autoUpdate !== false;
	}

	async prune() {
		const keep = new Set([this.info.release]);
		for (const file of ["current.json", "previous.json", "pending.json"]) {
			const info = await readJson(join(this.root, file), null);
			if (info?.release) keep.add(info.release);
		}
		for (const entry of await readdir(join(this.root, "releases"), {
			withFileTypes: true,
		})) {
			if (
				!entry.isDirectory() ||
				!/^source-[a-zA-Z0-9]+$/.test(entry.name) ||
				keep.has(entry.name)
			)
				continue;
			const path = join(this.root, "releases", entry.name);
			const info = await readJson(join(path, "fork-install.json"), null);
			if (
				info?.repository === this.info.repository &&
				info.release === entry.name
			)
				await rm(path, { recursive: true });
		}
	}

	async activate() {
		const releaseLock = await acquireInstallLock(this.root);
		let changed = false;
		const previousWorker = this.worker;
		try {
			const selected = await readInstallation(this.root);
			// An explicit manual install wins over a background candidate.
			if (selected.commit !== this.info.commit) return;
			const pending = await readInstallation(this.root, "pending.json");
			if (pending.commit === this.info.commit || this.isFailed(pending.commit))
				return;
			if (
				pending.repository !== this.info.repository ||
				pending.updateRef !== this.info.updateRef
			)
				throw Error(
					"Pending update belongs to a different installation channel",
				);
			if (!(await this.worker.requestRestart())) return;
			this.options.log(`Worker is idle; switching to ${pending.commit}`);
			// Never launch a second worker while the first still owns its ports.
			const drained = await Promise.race([
				this.worker.exit,
				delay(this.options.drainTimeout, null, { signal: this.abort.signal }),
			]);
			if (!drained) await this.worker.stop();
			if (this.stopping) return;
			await atomicWrite(
				join(this.root, "previous.json"),
				await readFile(join(this.root, "current.json")),
			);
			await this.saveState({ trial: pending.commit, status: "activating" });
			await atomicWrite(
				join(this.root, "current.json"),
				await readFile(join(this.root, "pending.json")),
			);
			changed = true;
			try {
				await this.start(pending, true);
				const earlyExit = await Promise.race([
					this.worker.exit,
					delay(this.options.probation, null, { signal: this.abort.signal }),
				]);
				if (earlyExit)
					throw Error("New version exited during startup probation");
				// Refresh bootstrap only after the new worker has proved healthy.
				await atomicWrite(
					join(this.root, "miko.mjs"),
					await readFile(join(pending.checkout, SCRIPT_DIR, "miko.mjs")),
				);
				await unlink(join(this.root, "pending.json"));
				await this.saveState({
					trial: null,
					status: "ready-to-activate",
					error: null,
				});
				// Candidate admission stays closed throughout readiness/probation
				// and metadata writes, so rollback cannot interrupt a new task.
				await this.worker.activate();
				await this.saveState({ status: "up-to-date" }).catch((error) =>
					this.options.log(
						`Update is active; status write deferred: ${error.message}`,
					),
				);
				this.options.log(`Updated successfully to ${pending.commit}`);
			} catch (error) {
				await this.worker.stop();
				await atomicWrite(
					join(this.root, "current.json"),
					await readFile(join(this.root, "previous.json")),
				);
				await atomicWrite(
					join(this.root, "miko.mjs"),
					await readFile(join(selected.checkout, SCRIPT_DIR, "miko.mjs")),
				);
				await this.saveState({
					trial: null,
					failedCommit: pending.commit,
					failedAt: Date.now(),
					status: "rolled-back",
					error: error.message,
				});
				await unlink(join(this.root, "pending.json")).catch(() => {});
				this.options.log(
					`Update failed; restored ${selected.commit}: ${error.message}`,
				);
				if (!this.stopping) await this.start(selected);
			}
			// Cleanup must never turn a healthy activation into a rollback.
			await this.prune().catch((error) =>
				this.options.log(`Release cleanup deferred: ${error.message}`),
			);
		} finally {
			await releaseLock();
			// Failures before pointer activation must still restore service after
			// a successfully drained worker (e.g. disk-full writing metadata).
			if (
				!changed &&
				previousWorker.exited &&
				!this.stopping &&
				this.worker === previousWorker
			)
				await this.start(await readInstallation(this.root));
		}
	}

	async check() {
		const checkedAt = Date.now();
		await this.saveState({ lastCheckedAt: checkedAt, status: "checking" });
		const commit = await this.options.latestCommit(this.info);
		if (commit === this.info.commit || this.isFailed(commit)) {
			await this.saveState({
				status: this.isFailed(commit) ? "rolled-back" : "up-to-date",
				error: null,
			});
			return;
		}
		this.options.log(`Preparing ${commit} in the background`);
		await this.saveState({ status: "building", availableCommit: commit });
		this.buildAbort = new AbortController();
		const abortBuild = () => this.buildAbort.abort();
		this.abort.signal.addEventListener("abort", abortBuild, { once: true });
		try {
			if (this.stopping || this.worker.exited) return;
			await this.options.stageRelease(
				this.root,
				this.info,
				commit,
				this.buildAbort.signal,
			);
			await this.saveState({ status: "waiting-for-idle", error: null });
		} finally {
			this.abort.signal.removeEventListener("abort", abortBuild);
			this.buildAbort = null;
		}
	}

	async run() {
		const releaseRuntimeLock = await acquireInstallLock(
			this.root,
			"runtime.lock",
		);
		const stop = () => {
			void this.stop();
		};
		process.once("SIGTERM", stop);
		process.once("SIGINT", stop);
		try {
			await this.recover();
			await this.start(await readInstallation(this.root));
			let nextCheck = Math.max(
				Date.now() + this.options.firstCheckDelay,
				(this.state.lastCheckedAt ?? 0) +
					(this.state.status === "retrying"
						? this.options.retryInterval
						: this.options.checkInterval),
			);
			let nextActivation = 0;
			while (!this.stopping && !this.worker.exited) {
				const exited = await Promise.race([
					this.worker.exit,
					delay(this.options.pollInterval, null, { signal: this.abort.signal }),
				]);
				if (exited) return exited.code;
				if (!this.enabled) continue;
				try {
					const pending = await readJson(join(this.root, "pending.json"), null);
					if (
						pending &&
						!this.isFailed(pending.commit) &&
						pending.commit !== this.info.commit
					) {
						if (Date.now() >= nextActivation) await this.activate();
					} else if (Date.now() >= nextCheck) {
						await this.check();
						nextCheck = Date.now() + this.options.checkInterval;
					}
				} catch (error) {
					if (this.stopping) break;
					this.options.log(`Keeping current version: ${error.message}`);
					await this.saveState({
						status: "retrying",
						error: error.message,
					}).catch((writeError) =>
						this.options.log(
							`Could not record update status: ${writeError.message}`,
						),
					);
					nextCheck = Date.now() + this.options.retryInterval;
					nextActivation = nextCheck;
				}
			}
			return this.stopping ? 0 : (await this.worker.exit).code;
		} catch (error) {
			if (!this.stopping) throw error;
			return 0;
		} finally {
			process.off("SIGTERM", stop);
			process.off("SIGINT", stop);
			this.abort.abort();
			await this.worker?.stop();
			await releaseRuntimeLock();
		}
	}

	async stop() {
		this.stopping = true;
		this.abort.abort();
		await this.worker?.stop();
	}
}

export async function runManaged(root, args, options) {
	return new UpdateSupervisor(root, args, options).run();
}
