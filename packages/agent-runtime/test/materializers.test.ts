import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	materializeFolderIntoSandbox,
	materializeRepositoryIntoSandbox,
	syncFolderBackToHost,
} from "../src/materializers/index.js";
import { createLocalSandboxProvider } from "../src/sandbox/index.js";

describe("materializeFolderIntoSandbox", () => {
	it("walks the host folder and uploads each file into the sandbox", async () => {
		const host = await mkdtemp(join(tmpdir(), "agent-runtime-folder-host-"));
		const sandboxRoot = await mkdtemp(
			join(tmpdir(), "agent-runtime-folder-sbx-"),
		);
		try {
			await mkdir(join(host, "nested"), { recursive: true });
			await writeFile(join(host, "top.txt"), "alpha");
			await writeFile(join(host, "nested", "deep.txt"), "beta");
			await writeFile(join(host, "skip.tmp"), "should-not-appear");

			const sandbox = await createLocalSandboxProvider({
				workingDirectory: sandboxRoot,
			}).create({ provider: "local" });
			const mount = join(sandboxRoot, "work");

			const result = await materializeFolderIntoSandbox(
				{
					source: host,
					mountPath: mount,
					access: "read",
					exclude: ["*.tmp"],
				},
				sandbox,
			);

			expect(result.filesWritten.sort()).toEqual(
				[`${mount}/nested/deep.txt`, `${mount}/top.txt`].sort(),
			);
			await expect(
				sandbox.filesystem.readFile(`${mount}/top.txt`),
			).resolves.toBe("alpha");
			await expect(
				sandbox.filesystem.readFile(`${mount}/nested/deep.txt`),
			).resolves.toBe("beta");
			await expect(
				sandbox.filesystem.exists(`${mount}/skip.tmp`),
			).resolves.toBe(false);
		} finally {
			await rm(host, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});
});

describe("syncFolderBackToHost", () => {
	it("syncs sandbox edits and new files back to the host folder", async () => {
		const host = await mkdtemp(join(tmpdir(), "agent-runtime-rw-host-"));
		const sandboxRoot = await mkdtemp(join(tmpdir(), "agent-runtime-rw-sbx-"));
		try {
			await writeFile(join(host, "before.txt"), "original");

			const sandbox = await createLocalSandboxProvider({
				workingDirectory: sandboxRoot,
			}).create({ provider: "local" });
			const mount = join(sandboxRoot, "work");

			const folder = {
				source: host,
				mountPath: mount,
				access: "readwrite" as const,
			};
			const materialized = await materializeFolderIntoSandbox(folder, sandbox);
			expect(materialized.filesWritten).toContain(`${mount}/before.txt`);

			// Simulate an agent editing an existing file and creating a new one.
			await sandbox.filesystem.writeFile(`${mount}/before.txt`, "edited");
			await sandbox.filesystem.writeFile(`${mount}/created.txt`, "fresh");

			const result = await syncFolderBackToHost(
				folder,
				sandbox,
				materialized.filesWritten,
			);

			// before.txt should have been overwritten; created.txt should appear.
			await expect(readFile(join(host, "before.txt"), "utf8")).resolves.toBe(
				"edited",
			);
			await expect(readFile(join(host, "created.txt"), "utf8")).resolves.toBe(
				"fresh",
			);
			// At minimum both must have been synced.
			expect(result.filesWritten.length).toBeGreaterThanOrEqual(2);
		} finally {
			await rm(host, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});
});

describe("materializeRepositoryIntoSandbox", () => {
	it("clones a local git repo at the requested branch", async () => {
		// Build a tiny upstream repo on disk, then clone it via the sandbox.
		const upstreamRoot = await mkdtemp(
			join(tmpdir(), "agent-runtime-repo-upstream-"),
		);
		const sandboxRoot = await mkdtemp(
			join(tmpdir(), "agent-runtime-repo-sbx-"),
		);
		try {
			const localSandboxFactory = createLocalSandboxProvider({
				workingDirectory: sandboxRoot,
			});
			const setupSandbox = await localSandboxFactory.create({
				provider: "local",
				workingDirectory: upstreamRoot,
			});
			const run = async (command: string) => {
				const r = await setupSandbox.runCommand(command, {
					cwd: upstreamRoot,
				});
				if (r.exitCode !== 0) {
					throw new Error(
						`${command} failed (${r.exitCode}): ${r.stderr || r.stdout}`,
					);
				}
				return r;
			};
			await run("git init -q -b main");
			await run("git config user.email test@example.com");
			await run("git config user.name Test");
			await writeFile(join(upstreamRoot, "README.md"), "hello main\n");
			await run("git add README.md");
			await run("git commit -q -m main-commit");
			await run("git checkout -q -b feature");
			await writeFile(join(upstreamRoot, "feature.txt"), "branch content\n");
			await run("git add feature.txt");
			await run("git commit -q -m feature-commit");
			await run("git checkout -q main");

			const sandbox = await localSandboxFactory.create({ provider: "local" });

			const result = await materializeRepositoryIntoSandbox(
				{
					source: upstreamRoot,
					mountPath: join(sandboxRoot, "clone"),
					branch: "feature",
					access: "read",
				},
				sandbox,
			);

			expect(result.exitCode).toBe(0);
			expect(result.resolvedSource).toBe(`file://${upstreamRoot}`);
			expect(result.depth).toBe(1);
			// Working tree should reflect the requested branch.
			await expect(
				readFile(join(sandboxRoot, "clone", "feature.txt"), "utf8"),
			).resolves.toBe("branch content\n");
			// Default-branch sentinel file should also be present (clone preserves
			// it on the feature branch).
			await expect(
				readFile(join(sandboxRoot, "clone", "README.md"), "utf8"),
			).resolves.toBe("hello main\n");
		} finally {
			await rm(upstreamRoot, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});
});
