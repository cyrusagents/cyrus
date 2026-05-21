import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	type ComputeSdkSandboxLike,
	createComputeSdkSandboxProvider,
	createLocalSandboxProvider,
} from "../src/sandbox/index.js";

describe("LocalSandboxProvider", () => {
	it("creates a local sandbox with filesystem and command execution", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-runtime-local-"));
		try {
			const provider = createLocalSandboxProvider({ workingDirectory: root });
			const sandbox = await provider.create({ provider: "local" });

			expect(sandbox.provider).toBe("local");
			expect(sandbox.capabilities.filesystem).toBe(true);
			expect(sandbox.capabilities.runCommand).toBe(true);
			expect(sandbox.capabilities.streamingProcess).toBe(true);

			await sandbox.filesystem.mkdir("nested");
			await sandbox.filesystem.writeFile("nested/hello.txt", "hello");

			await expect(
				sandbox.filesystem.readFile("nested/hello.txt"),
			).resolves.toBe("hello");
			await expect(sandbox.filesystem.exists("nested/hello.txt")).resolves.toBe(
				true,
			);
			await expect(sandbox.filesystem.readdir("nested")).resolves.toMatchObject(
				[{ name: "hello.txt", type: "file", size: 5 }],
			);

			const result = await sandbox.runCommand(
				"node -e \"console.log(process.cwd()); console.error('err')\"",
			);

			expect(result.exitCode).toBe(0);
			expect(await realpath(result.stdout.trim())).toBe(await realpath(root));
			expect(result.stderr.trim()).toBe("err");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("feeds an input AsyncIterable into the running process's stdin", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-runtime-local-stdin-"));
		try {
			const provider = createLocalSandboxProvider({ workingDirectory: root });
			const sandbox = await provider.create({ provider: "local" });

			// A simple line-echo loop: read lines from stdin, echo each back
			// with a "got:" prefix, until stdin closes.
			const command =
				'node -e "' +
				"const rl = require('readline').createInterface({ input: process.stdin });" +
				"rl.on('line', l => console.log('got:', l));" +
				"rl.on('close', () => console.log('closed'));" +
				'"';

			// Build an async iterable that yields three lines with delays
			// between them — proves stdin chunks land while the process runs.
			async function* messages() {
				yield "hello\n";
				await new Promise((r) => setTimeout(r, 30));
				yield "world\n";
				await new Promise((r) => setTimeout(r, 30));
				yield "fin\n";
			}

			const result = await sandbox.streamCommand!(command, {
				input: messages(),
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("got: hello");
			expect(result.stdout).toContain("got: world");
			expect(result.stdout).toContain("got: fin");
			expect(result.stdout).toContain("closed");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("streams stdout/stderr chunks live via streamCommand", async () => {
		const root = await mkdtemp(join(tmpdir(), "agent-runtime-local-stream-"));
		try {
			const provider = createLocalSandboxProvider({ workingDirectory: root });
			const sandbox = await provider.create({ provider: "local" });

			expect(sandbox.streamCommand).toBeDefined();

			const stdoutChunks: Array<{ chunk: string; elapsedMs: number }> = [];
			const startedAt = Date.now();

			// Emit three lines on stdout with a 100ms gap, and one line on
			// stderr at the end. If streaming works, we'll see the first chunk
			// arrive well before the command exits (~300ms total).
			const command =
				'node -e "' +
				"setTimeout(() => console.log('one'), 0);" +
				"setTimeout(() => console.log('two'), 100);" +
				"setTimeout(() => { console.log('three'); console.error('done'); }, 200);" +
				'"';

			const result = await sandbox.streamCommand!(command, {
				onStdout: (chunk) => {
					stdoutChunks.push({ chunk, elapsedMs: Date.now() - startedAt });
				},
			});

			expect(result.exitCode).toBe(0);
			expect(result.stdout).toContain("one");
			expect(result.stdout).toContain("two");
			expect(result.stdout).toContain("three");
			expect(result.stderr).toContain("done");
			// We must have observed at least one chunk strictly before exit.
			expect(stdoutChunks.length).toBeGreaterThan(0);
			expect(stdoutChunks[0]!.elapsedMs).toBeLessThan(result.durationMs);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});

describe("ComputeSdkSandboxProvider", () => {
	it("wraps an injected compute object and forwards filesystem and command calls", async () => {
		const calls: unknown[] = [];
		const fakeSandbox: ComputeSdkSandboxLike = {
			sandboxId: "sbx_123",
			provider: "daytona",
			workingDirectory: "/remote/workspace",
			filesystem: {
				async readFile(path) {
					calls.push(["readFile", path]);
					return "remote contents";
				},
				async writeFile(path, contents) {
					calls.push(["writeFile", path, contents]);
				},
				async mkdir(path) {
					calls.push(["mkdir", path]);
				},
				async readdir(path) {
					calls.push(["readdir", path]);
					return [{ name: "remote.txt", type: "file" }];
				},
				async exists(path) {
					calls.push(["exists", path]);
					return true;
				},
				async remove(path) {
					calls.push(["remove", path]);
				},
			},
			async runCommand(command, options) {
				calls.push(["runCommand", command, options]);
				return { exitCode: 7, stdout: "out", stderr: "err", durationMs: 5 };
			},
			async destroy() {
				calls.push(["destroy"]);
			},
		};
		const compute = {
			sandbox: {
				async create(options: Record<string, unknown>) {
					calls.push(["create", options]);
					return fakeSandbox;
				},
			},
		};

		const provider = createComputeSdkSandboxProvider({ compute });
		const sandbox = await provider.create({
			provider: "daytona",
			id: "requested-id",
			name: "agent-runtime-test",
			workingDirectory: "/requested/workspace",
			templateId: "template-1",
			timeoutMs: 10_000,
			metadata: { issue: "CYR-1" },
		});

		expect(sandbox.sandboxId).toBe("sbx_123");
		expect(sandbox.provider).toBe("daytona");
		expect(sandbox.workingDirectory).toBe("/remote/workspace");
		expect(sandbox.capabilities.streamingProcess).toBe(false);

		await sandbox.filesystem.mkdir("/tmp/project");
		await sandbox.filesystem.writeFile("/tmp/project/remote.txt", "contents");
		await expect(
			sandbox.filesystem.readFile("/tmp/project/remote.txt"),
		).resolves.toBe("remote contents");
		await expect(sandbox.filesystem.readdir("/tmp/project")).resolves.toEqual([
			{ name: "remote.txt", type: "file" },
		]);
		await expect(
			sandbox.filesystem.exists("/tmp/project/remote.txt"),
		).resolves.toBe(true);
		await sandbox.filesystem.remove("/tmp/project");

		await expect(
			sandbox.runCommand("node --version", {
				cwd: "/tmp/project",
				env: { A: "1" },
			}),
		).resolves.toMatchObject({
			exitCode: 7,
			stdout: "out",
			stderr: "err",
			durationMs: 5,
		});
		await sandbox.destroy();

		expect(calls).toEqual([
			[
				"create",
				{
					timeout: 10_000,
					templateId: "template-1",
					snapshotId: undefined,
					metadata: { issue: "CYR-1" },
					namespace: undefined,
					name: "agent-runtime-test",
					directory: "/requested/workspace",
					volumes: undefined,
					networkEgress: undefined,
				},
			],
			["mkdir", "/tmp/project"],
			["writeFile", "/tmp/project/remote.txt", "contents"],
			["readFile", "/tmp/project/remote.txt"],
			["readdir", "/tmp/project"],
			["exists", "/tmp/project/remote.txt"],
			["remove", "/tmp/project"],
			[
				"runCommand",
				"node --version",
				{ cwd: "/tmp/project", env: { A: "1" } },
			],
			["destroy"],
		]);
	});

	it("streamCommand drives a Daytona-shaped native sandbox via async sessions", async () => {
		const events: string[] = [];
		// Synthetic Daytona Process shape — proves that streamCommand dispatches
		// to createSession → executeSessionCommand(runAsync) → getSessionCommandLogs
		// with live callbacks → getSessionCommand → deleteSession.
		const daytonaProcess = {
			async createSession(sessionId: string) {
				events.push(`createSession:${sessionId}`);
			},
			async executeSessionCommand(
				sessionId: string,
				req: { command: string; runAsync?: boolean },
			) {
				events.push(
					`executeSessionCommand:${sessionId}:${req.command}:async=${req.runAsync}`,
				);
				return { cmdId: "cmd-42" };
			},
			async getSessionCommandLogs(
				_sessionId: string,
				_commandId: string,
				onStdout: (chunk: string) => void,
				onStderr: (chunk: string) => void,
			) {
				onStdout("hello\n");
				onStdout("world\n");
				onStderr("warning\n");
			},
			async getSessionCommand(_sessionId: string, _commandId: string) {
				return { exitCode: 0 };
			},
			async deleteSession(sessionId: string) {
				events.push(`deleteSession:${sessionId}`);
			},
		};
		const nativeSandbox = { process: daytonaProcess };
		const fakeSandbox: ComputeSdkSandboxLike = {
			sandboxId: "sbx_daytona",
			provider: "daytona",
			workingDirectory: "/home/daytona",
			filesystem: {
				async readFile() {
					return "";
				},
				async writeFile() {},
				async mkdir() {},
				async readdir() {
					return [];
				},
				async exists() {
					return true;
				},
				async remove() {},
			},
			async runCommand() {
				return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
			},
			getInstance() {
				return nativeSandbox;
			},
			async destroy() {},
		};
		const compute = {
			sandbox: {
				async create() {
					return fakeSandbox;
				},
			},
		};
		const provider = createComputeSdkSandboxProvider({ compute });
		const sandbox = await provider.create({ provider: "daytona" });

		// Capability flag must surface streaming when getInstance reveals a
		// Daytona-shaped native sandbox, even though the wrapped sandbox's
		// runCommand alone wouldn't expose it.
		expect(sandbox.capabilities.streamingProcess).toBe(true);
		expect(sandbox.streamCommand).toBeDefined();

		const stdoutChunks: string[] = [];
		const stderrChunks: string[] = [];
		const result = await sandbox.streamCommand!(
			"claude -p hi --output-format stream-json",
			{
				cwd: "/home/daytona",
				env: { FOO: "bar" },
				onStdout: (chunk) => stdoutChunks.push(chunk),
				onStderr: (chunk) => stderrChunks.push(chunk),
			},
		);

		expect(stdoutChunks).toEqual(["hello\n", "world\n"]);
		expect(stderrChunks).toEqual(["warning\n"]);
		expect(result.stdout).toBe("hello\nworld\n");
		expect(result.stderr).toBe("warning\n");
		expect(result.exitCode).toBe(0);

		// Verify the orchestration: createSession first, executeSessionCommand
		// with runAsync=true and env/cwd folded into the command, deleteSession last.
		expect(events[0]).toMatch(/^createSession:agent-runtime-stream-/);
		expect(events[1]).toMatch(
			/^executeSessionCommand:agent-runtime-stream-[^:]+:cd "\/home\/daytona" && FOO="bar" claude -p hi --output-format stream-json:async=true$/,
		);
		expect(events[2]).toMatch(/^deleteSession:agent-runtime-stream-/);
	});

	it("forwards RuntimeSandboxConfig.snapshot as snapshotId on create", async () => {
		let received: Record<string, unknown> | undefined;
		const fakeSandbox: ComputeSdkSandboxLike = {
			sandboxId: "sbx_snap",
			provider: "daytona",
			filesystem: {
				async readFile() {
					return "";
				},
				async writeFile() {},
				async mkdir() {},
				async readdir() {
					return [];
				},
				async exists() {
					return false;
				},
				async remove() {},
			},
			async runCommand() {
				return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
			},
			async destroy() {},
		};
		const compute = {
			sandbox: {
				async create(options: Record<string, unknown>) {
					received = options;
					return fakeSandbox;
				},
			},
		};
		const provider = createComputeSdkSandboxProvider({ compute });
		await provider.create({
			provider: "daytona",
			snapshot: "cyrus-base-v3",
		});
		expect(received?.snapshotId).toBe("cyrus-base-v3");
	});

	it("streamCommand rejects when the underlying provider has no streaming primitive", async () => {
		const fakeSandbox: ComputeSdkSandboxLike = {
			sandboxId: "sbx_nostream",
			provider: "blaxel",
			filesystem: {
				async readFile() {
					return "";
				},
				async writeFile() {},
				async mkdir() {},
				async readdir() {
					return [];
				},
				async exists() {
					return false;
				},
				async remove() {},
			},
			async runCommand() {
				return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
			},
			// No getInstance — providers that haven't been wired into the
			// streaming primitive should report streamingProcess: false and
			// surface a clear error if streamCommand is called anyway.
			async destroy() {},
		};
		const compute = {
			sandbox: {
				async create() {
					return fakeSandbox;
				},
			},
		};
		const provider = createComputeSdkSandboxProvider({ compute });
		const sandbox = await provider.create({ provider: "blaxel" });

		expect(sandbox.capabilities.streamingProcess).toBe(false);
		await expect(sandbox.streamCommand!("echo hi", {})).rejects.toThrow(
			/streaming/i,
		);
	});
});
