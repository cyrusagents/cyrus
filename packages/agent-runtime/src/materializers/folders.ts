import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import type {
	RunnerSandbox,
	RuntimeFolderConfig,
	SandboxFileEntry,
} from "../types.js";

/**
 * Walk a host directory and upload every regular file into the sandbox at
 * `mountPath`. Skips entries whose source-relative path matches any glob
 * in `exclude`. Returns the list of files materialized (sandbox-relative
 * paths) so the caller can sync-back exactly those entries later.
 */
export async function materializeFolderIntoSandbox(
	folder: RuntimeFolderConfig,
	sandbox: RunnerSandbox,
): Promise<{ filesWritten: string[]; bytes: number }> {
	const sourceAbsolute = resolveHostPath(folder.source);
	const sourceStat = await stat(sourceAbsolute);
	if (!sourceStat.isDirectory()) {
		throw new Error(
			`RuntimeFolderConfig.source must be a directory: ${folder.source}`,
		);
	}
	await sandbox.filesystem.mkdir(folder.mountPath);
	const filesWritten: string[] = [];
	let bytes = 0;
	for await (const entry of walkFiles(sourceAbsolute, folder.exclude ?? [])) {
		const sandboxPath = joinSandboxPath(folder.mountPath, entry.relativePath);
		const dir = sandboxDirname(sandboxPath);
		if (dir) await sandbox.filesystem.mkdir(dir);
		const content = await readFile(entry.absolutePath, "utf8");
		await sandbox.filesystem.writeFile(sandboxPath, content);
		filesWritten.push(sandboxPath);
		bytes += content.length;
	}
	return { filesWritten, bytes };
}

/**
 * For an `access: "readwrite"` folder, walk the sandbox tree under
 * `mountPath` and write each file back to its host counterpart under
 * `source`. The set of files synced back is the union of `originalFiles`
 * (everything we wrote in) and anything new the sandbox produced under
 * `mountPath` — this picks up files the agent created during the run.
 *
 * Returns the list of host paths written.
 */
export async function syncFolderBackToHost(
	folder: RuntimeFolderConfig,
	sandbox: RunnerSandbox,
	originalFiles: readonly string[],
): Promise<{ filesWritten: string[]; bytes: number }> {
	const { writeFile, mkdir } = await import("node:fs/promises");
	const sourceAbsolute = resolveHostPath(folder.source);
	const remoteFiles = new Set<string>();
	await walkSandbox(sandbox, folder.mountPath, "", (path) => {
		remoteFiles.add(path);
	});
	for (const f of originalFiles) remoteFiles.add(f);

	const filesWritten: string[] = [];
	let bytes = 0;
	for (const sandboxPath of remoteFiles) {
		const relativeToMount = sandboxRelative(folder.mountPath, sandboxPath);
		if (!relativeToMount) continue;
		const hostPath = join(sourceAbsolute, relativeToMount);
		let content: string;
		try {
			content = await sandbox.filesystem.readFile(sandboxPath);
		} catch {
			// File may have been deleted in-sandbox; skip.
			continue;
		}
		await mkdir(hostDirname(hostPath), { recursive: true });
		await writeFile(hostPath, content);
		filesWritten.push(hostPath);
		bytes += content.length;
	}
	return { filesWritten, bytes };
}

async function* walkFiles(
	root: string,
	excludes: readonly string[],
	prefix = "",
): AsyncGenerator<{ absolutePath: string; relativePath: string }> {
	const entries = await readdir(root, { withFileTypes: true });
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (excludes.some((pattern) => matchesGlob(rel, pattern))) continue;
		const absolutePath = join(root, entry.name);
		if (entry.isDirectory()) {
			yield* walkFiles(absolutePath, excludes, rel);
		} else if (entry.isFile()) {
			yield { absolutePath, relativePath: rel };
		}
	}
}

async function walkSandbox(
	sandbox: RunnerSandbox,
	root: string,
	prefix: string,
	visit: (sandboxPath: string) => void,
): Promise<void> {
	let entries: SandboxFileEntry[];
	try {
		entries = await sandbox.filesystem.readdir(
			prefix ? joinSandboxPath(root, prefix) : root,
		);
	} catch {
		return;
	}
	for (const entry of entries) {
		const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
		const sandboxPath = joinSandboxPath(root, rel);
		if (entry.type === "directory") {
			await walkSandbox(sandbox, root, rel, visit);
		} else {
			visit(sandboxPath);
		}
	}
}

/**
 * Minimal glob matcher — supports `*` (any segment chars) and `**` (across
 * segments). Intentionally lightweight so we don't add a glob dep.
 */
function matchesGlob(path: string, pattern: string): boolean {
	const re = new RegExp(
		`^${pattern
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*/g, "::DOUBLESTAR::")
			.replace(/\*/g, "[^/]*")
			.replace(/::DOUBLESTAR::/g, ".*")}$`,
	);
	return re.test(path);
}

function resolveHostPath(path: string): string {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

function joinSandboxPath(base: string, sub: string): string {
	if (!sub) return base;
	return base.endsWith("/") ? `${base}${sub}` : `${base}/${sub}`;
}

function sandboxDirname(path: string): string | undefined {
	const slash = path.lastIndexOf("/");
	if (slash <= 0) return undefined;
	return path.slice(0, slash);
}

function sandboxRelative(mountPath: string, sandboxPath: string): string {
	const trimmed = sandboxPath.startsWith(`${mountPath}/`)
		? sandboxPath.slice(mountPath.length + 1)
		: sandboxPath === mountPath
			? ""
			: sandboxPath;
	return trimmed;
}

function hostDirname(path: string): string {
	const slash = path.lastIndexOf(sep);
	if (slash <= 0) return path;
	return path.slice(0, slash);
}

// Reference posix/relative to keep TypeScript from removing the imports when
// only used inside helpers above (in case node:path types tighten further).
void posix;
void relative;
