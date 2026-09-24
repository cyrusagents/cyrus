import { randomUUID } from "node:crypto";
import { open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function atomicWrite(path, content) {
	const temporary = `${path}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
		await rename(temporary, path);
	} finally {
		await unlink(temporary).catch(() => {});
	}
}

export async function readJson(path, fallback) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch (error) {
		if (error.code === "ENOENT") return fallback;
		throw error;
	}
}

/** Shared by manual installs, background builds, and activation/rollback. */
export async function acquireInstallLock(root, filename = "install.lock") {
	const path = join(root, filename);
	let file;
	try {
		file = await open(path, "wx", 0o600);
	} catch (error) {
		if (error.code !== "EEXIST") throw error;
		const owner = await readFile(path, "utf8");
		// Only recover a lock whose recorded owner has definitely exited.
		// Empty/unknown locks may belong to an installer still writing its PID.
		if (/^[1-9]\d*$/.test(owner)) {
			try {
				process.kill(Number(owner), 0);
			} catch (probe) {
				if (probe.code === "ESRCH") {
					await unlink(path);
					return acquireInstallLock(root, filename);
				}
			}
		}
		throw Error(
			`Another install may be running. Check ${path} before retrying.`,
		);
	}
	await file.writeFile(String(process.pid));
	return async () => {
		await file.close();
		await unlink(path);
	};
}
