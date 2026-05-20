import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createAgentSession, normalizeConfig } from "../src/runtime.js";
import type {
	CommandExecutionResult,
	RunnerSandbox,
	RunnerSandboxCapabilities,
	SandboxFilesystem,
	SandboxProvider,
	SandboxStreamCommandOptions,
} from "../src/types.js";

describe("AgentRuntime", () => {
	it("normalizes minimal session config", () => {
		const config = normalizeConfig({
			harness: "codex",
			secrets: {
				CURSOR_API_KEY: "secret",
			},
		});

		expect(config.sessionId).toBeTruthy();
		expect(config.harness).toEqual({ kind: "codex", model: undefined });
		expect(config.sandbox.provider).toBe("local");
		expect(config.secrets.CURSOR_API_KEY).toEqual({
			value: "secret",
			redact: true,
		});
	});

	it("preserves sandbox.snapshot through normalization", () => {
		const config = normalizeConfig({
			harness: "claude",
			sandbox: {
				provider: "daytona",
				snapshot: "cyrus-base-v3",
			},
		});
		expect(config.sandbox.snapshot).toBe("cyrus-base-v3");
	});

	it("runs a session through an injected sandbox provider", async () => {
		const sandbox = new FakeSandbox(
			[
				JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "done" },
				}),
			].join("\n"),
		);
		const events = [];
		const session = await createAgentSession(
			{
				sessionId: "session-1",
				harness: "codex",
				env: { NODE_ENV: "test" },
				secrets: { API_KEY: "secret" },
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(sandbox) },
				callbacks: {
					onTranscriptEvent(event) {
						events.push(event.kind);
					},
				},
			},
		);

		await session.addMessage("queued");
		const result = await session.run("Do it");

		expect(result).toMatchObject({
			sessionId: "session-1",
			harness: "codex",
			success: true,
			result: "done",
		});
		expect(events).toEqual(["message.queued", "item.completed"]);
		expect(sandbox.commands[0]).toMatchObject({
			command: "codex exec --json --skip-git-repo-check 'Do it'",
			options: {
				env: {
					NODE_ENV: "test",
					API_KEY: "secret",
				},
			},
		});
	});

	it("runs setup commands before the harness command and emits setup events", async () => {
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "ready" },
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-setup",
				harness: "codex",
				packages: {
					npm: ["example-cli"],
					commands: ["example-cli --version"],
				},
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(sandbox) },
			},
		);

		const result = await session.run("Run after setup");

		expect(result.success).toBe(true);
		expect(result.events.map((event) => event.kind)).toEqual([
			"setup.started",
			"setup.completed",
			"setup.started",
			"setup.completed",
			"item.completed",
		]);
		expect(sandbox.commands.map((entry) => entry.command)).toEqual([
			"npm install -g example-cli",
			"example-cli --version",
			"codex exec --json --skip-git-repo-check 'Run after setup'",
		]);
	});

	it("prefers streamCommand and emits transcript events live, line-by-line", async () => {
		// Three Codex events delivered as separate chunks with delays — proves
		// the session parses each line as it arrives, not after the command exits.
		const streamingSandbox = new StreamingFakeSandbox([
			{
				delayMs: 0,
				stdout: `${JSON.stringify({
					type: "item.started",
					item: { type: "thought", text: "starting" },
				})}\n`,
			},
			{
				delayMs: 80,
				stdout: `${JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "midway" },
				})}\n`,
			},
			{
				delayMs: 80,
				stdout: `${JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "done" },
				})}\n`,
			},
		]);

		const arrivals: Array<{ kind: string; elapsedMs: number }> = [];
		const startedAt = Date.now();
		const session = await createAgentSession(
			{
				sessionId: "session-stream",
				harness: "codex",
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(streamingSandbox) },
				callbacks: {
					onTranscriptEvent(event) {
						arrivals.push({
							kind: event.kind,
							elapsedMs: Date.now() - startedAt,
						});
					},
				},
			},
		);

		const result = await session.run("Do it");

		expect(streamingSandbox.streamCalls).toBe(1);
		expect(streamingSandbox.runCalls).toBe(0);
		expect(result.success).toBe(true);
		expect(result.result).toBe("done");
		expect(arrivals.map((a) => a.kind)).toEqual([
			"item.started",
			"item.completed",
			"item.completed",
		]);
		// The first event must arrive before the command exits — that's the
		// "live" part. Each scheduled chunk is 80ms apart so the third event
		// lands at least ~160ms after the first.
		const firstToLast = arrivals[2]!.elapsedMs - arrivals[0]!.elapsedMs;
		expect(firstToLast).toBeGreaterThanOrEqual(100);
	});

	it("falls back to runCommand when streamingProcess capability is false", async () => {
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "buffered" },
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-buffered",
				harness: "codex",
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(sandbox) },
			},
		);
		const result = await session.run("fallback");
		expect(result.success).toBe(true);
		expect(result.result).toBe("buffered");
		// Non-streaming sandboxes still get the harness command through runCommand.
		expect(sandbox.commands).toHaveLength(1);
	});

	it("does NOT pipe stdin when interactiveInput is false (default)", async () => {
		// Reproduces the codex-hang scenario: many one-shot CLIs block on a
		// piped-but-never-closed stdin. The session must default to NOT
		// attaching an input iterable.
		const streamingSandbox = new StreamingFakeSandbox([
			{
				delayMs: 0,
				stdout: `${JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "ok" },
				})}\n`,
			},
		]);
		const session = await createAgentSession(
			{
				sessionId: "session-no-stdin",
				harness: "codex",
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(streamingSandbox) },
			},
		);
		// Push messages before run — under no-pipe contract these stay in
		// the queue and never reach the fake's stdinChunks.
		await session.addMessage("queued-only");
		const result = await session.run("no stdin please");
		expect(result.success).toBe(true);
		expect(streamingSandbox.stdinChunks).toEqual([]);
		expect(session.getQueuedMessages()).toEqual(["queued-only"]);
	});

	it("routes addMessage into the running process's stdin while streaming", async () => {
		const streamingSandbox = new StreamingFakeSandbox([
			{
				delayMs: 30,
				stdout: `${JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "ack" },
				})}\n`,
			},
		]);

		const session = await createAgentSession(
			{
				sessionId: "session-stdin",
				harness: "codex",
				interactiveInput: true,
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(streamingSandbox) },
			},
		);

		// Kick the session, then push messages while it's streaming. Capture
		// what reaches the fake's stdin in real time.
		const sessionPromise = session.run("open a stream");
		// Give the sandbox a moment to begin reading its input iterable.
		await new Promise((resolve) => setTimeout(resolve, 10));
		await session.addMessage("hello");
		await session.addMessage("world");

		const result = await sessionPromise;
		expect(result.success).toBe(true);
		// Messages should have been delivered to the fake's stdin as
		// newline-terminated wire lines, ordered.
		expect(streamingSandbox.stdinChunks).toEqual(["hello\n", "world\n"]);
	});

	it("materializes folders and syncs read-write edits back to the host", async () => {
		// End-to-end through createAgentSession with a real local sandbox:
		// host folder is uploaded, setup commands stand in for an agent's
		// edits, and syncFoldersBack writes them back to the host. The
		// harness is set to `true` so the "session" itself is a no-op.
		const host = await mkdtemp(join(tmpdir(), "agent-runtime-rt-folder-"));
		const sandboxRoot = await mkdtemp(
			join(tmpdir(), "agent-runtime-rt-folder-sbx-"),
		);
		try {
			await writeFile(join(host, "input.txt"), "before");
			const mount = join(sandboxRoot, "work");

			const session = await createAgentSession({
				sessionId: "session-folder",
				harness: { kind: "codex", command: "true" },
				sandbox: { provider: "local", workingDirectory: sandboxRoot },
				folders: [{ source: host, mountPath: mount, access: "readwrite" }],
				packages: {
					// These setup commands stand in for what an agent would do
					// during the run: edit one file, create another.
					commands: [
						`sh -c 'printf after > ${mount}/input.txt'`,
						`sh -c 'printf created > ${mount}/new.txt'`,
					],
				},
			});

			const result = await session.run("edit files please");
			// Sync-back happens on session.destroy() now, not at the end of
			// run() — call it so the test can assert the host file deltas.
			await session.destroy();
			expect(result.success).toBe(true);

			// Materialize events fire inside run(); syncback fires inside destroy()
			// — both are in result.events because run()'s event slice happens
			// from eventStartIndex through call-time, and destroy ran after.
			// Materialize events are guaranteed in result.events.
			const kinds = result.events.map((e) => e.kind);
			expect(kinds).toContain("folder.materialize.started");
			expect(kinds).toContain("folder.materialize.completed");

			// Host file deltas prove sync-back ran via destroy().
			await expect(readFile(join(host, "input.txt"), "utf8")).resolves.toBe(
				"after",
			);
			await expect(readFile(join(host, "new.txt"), "utf8")).resolves.toBe(
				"created",
			);
		} finally {
			await rm(host, { recursive: true, force: true });
			await rm(sandboxRoot, { recursive: true, force: true });
		}
	});

	it("routes repository config through git-clone/checkout commands and emits lifecycle events", async () => {
		// Session-level wiring test: verify that declaring `repositories`
		// causes the runtime to invoke `git clone` (and `git checkout` when a
		// branch is set) on the sandbox, before the harness command runs, with
		// the right env. Real git behavior is covered by materializers.test.ts.
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "cloned" },
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-repo",
				harness: "codex",
				repositories: [
					{
						source: "/tmp/upstream",
						mountPath: "/work/repo",
						branch: "feature",
						access: "read",
					},
				],
			},
			{ sandboxProviders: { local: new FakeSandboxProvider(sandbox) } },
		);

		const result = await session.run("clone please");
		expect(result.success).toBe(true);

		const kinds = result.events.map((e) => e.kind);
		expect(kinds).toContain("repository.materialize.started");
		expect(kinds).toContain("repository.materialize.completed");

		const commands = sandbox.commands.map((c) => c.command);
		// Shallow clones (depth=1 because access:"read") steer with --branch
		// on the clone itself, because a post-clone `git checkout` of a
		// non-default branch fails when only one branch's history is fetched.
		expect(commands[0]).toBe(
			"git clone --depth 1 --branch feature file:///tmp/upstream /work/repo",
		);
		// Harness command runs after the repo command.
		expect(commands.at(-1)).toBe(
			"codex exec --json --skip-git-repo-check 'clone please'",
		);
	});

	it("supports multi-turn run() — first turn fresh, second turn continues", async () => {
		// First run is a fresh harness invocation (materializes setup, no
		// --continue). Second run skips materialization and passes --continue.
		// We verify both by inspecting the recorded sandbox commands.
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "ok" },
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-multi-turn",
				harness: "claude", // claude has stateDirectories: [".claude"]
				packages: { commands: ["echo install"] },
			},
			{ sandboxProviders: { local: new FakeSandboxProvider(sandbox) } },
		);

		const r1 = await session.run("first message");
		expect(r1.success).toBe(true);

		const r2 = await session.run("second message");
		expect(r2.success).toBe(true);

		// Setup commands ran only once (first turn).
		const setupRuns = sandbox.commands.filter(
			(c) => c.command === "echo install",
		);
		expect(setupRuns).toHaveLength(1);

		// First harness invocation: no --continue.
		// Second: --continue present.
		const harnessRuns = sandbox.commands.filter((c) =>
			c.command.startsWith("claude "),
		);
		expect(harnessRuns).toHaveLength(2);
		expect(harnessRuns[0]!.command).not.toContain("--continue");
		expect(harnessRuns[1]!.command).toContain("--continue");

		await session.destroy();
	});

	it("decouples stop() from sandbox destruction; destroy() is the only release path", async () => {
		// stop() cancels the run; destroy() releases the sandbox. They are
		// separate operations: stop() must NOT destroy, and destroy() can
		// be called independently. Both AgentSession.destroy() and
		// AgentSessionResult.destroy() share a one-shot, so calling either
		// or both is safe.
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "done" },
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-destroy",
				harness: "codex",
			},
			{ sandboxProviders: { local: new FakeSandboxProvider(sandbox) } },
		);

		const result = await session.run("anything");
		expect(result.success).toBe(true);
		expect(typeof result.destroy).toBe("function");
		expect(typeof session.destroy).toBe("function");
		expect(sandbox.destroyed).toBe(0);

		// stop() must NOT destroy the sandbox.
		await session.stop();
		expect(sandbox.destroyed).toBe(0);

		// destroy() on the result releases the sandbox exactly once.
		await result.destroy();
		expect(sandbox.destroyed).toBe(1);

		// Idempotent — calling result.destroy() again is a no-op.
		await result.destroy();
		expect(sandbox.destroyed).toBe(1);

		// Calling session.destroy() afterward shares the one-shot, also no-op.
		await session.destroy();
		expect(sandbox.destroyed).toBe(1);
	});

	it("session.destroy() cancels an in-flight run and releases the sandbox", async () => {
		// destroy() on the live session should: (a) cancel the harness if
		// still running via stop(), (b) release the sandbox exactly once.
		// The streaming fake's schedule is intentionally long enough that
		// we can call destroy() mid-run.
		const sandbox = new StreamingFakeSandbox([
			{ delayMs: 50, stdout: "" },
			{
				delayMs: 500,
				stdout: `${JSON.stringify({
					type: "item.completed",
					item: { type: "agent_message", text: "should-not-arrive" },
				})}\n`,
			},
		]);
		const session = await createAgentSession(
			{
				sessionId: "session-destroy-live",
				harness: "codex",
			},
			{ sandboxProviders: { local: new FakeSandboxProvider(sandbox) } },
		);

		const startPromise = session.run("anything");
		await new Promise((resolve) => setTimeout(resolve, 80));
		// Run is in flight; destroy must both cancel and release.
		await session.destroy();
		expect(sandbox.destroyed).toBe(1);

		const result = await startPromise;
		// The destroy() path goes through stop() which emits stop.requested.
		expect(result.events.some((e) => e.kind === "stop.requested")).toBe(true);

		// Idempotent — calling either destroy again is a no-op.
		await session.destroy();
		await result.destroy();
		expect(sandbox.destroyed).toBe(1);
	});

	it("materializes a Claude plugin and wires --plugin-dir into the harness invocation", async () => {
		// Verifies: session calls the right materializer, writes plugin
		// files into the fake sandbox, and passes the resulting plugin
		// dir as `--plugin-dir` on the harness CLI.
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "result",
				subtype: "success",
				result: "ok",
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-plugin-claude",
				harness: { kind: "claude" },
				sandbox: { provider: "local", workingDirectory: "/work" },
				plugins: [
					{
						name: "demo",
						version: "0.0.1",
						mcpServers: { foo: { command: "echo", args: ["x"] } },
						hooks: [
							{ event: "PreToolUse", command: "echo pre", matcher: "Bash" },
						],
						skills: [
							{
								name: "hi",
								description: "Greet the user.",
								content: "Say hi.",
							},
						],
					},
				],
			},
			{ sandboxProviders: { local: new FakeSandboxProvider(sandbox) } },
		);
		const result = await session.run("hello");
		expect(result.success).toBe(true);

		// Plugin files landed at the expected paths.
		const paths = sandbox.files.map((f) => f.path).sort();
		expect(paths).toContain(
			"/work/.cyrus-plugins/demo/.claude-plugin/plugin.json",
		);
		expect(paths).toContain("/work/.cyrus-plugins/demo/.mcp.json");
		expect(paths).toContain("/work/.cyrus-plugins/demo/hooks/hooks.json");
		expect(paths).toContain("/work/.cyrus-plugins/demo/skills/hi/SKILL.md");

		// Harness command got --plugin-dir + --mcp-config + --strict-mcp-config.
		const harnessCmd = sandbox.commands.at(-1)!.command;
		expect(harnessCmd).toContain("--plugin-dir /work/.cyrus-plugins/demo");
		expect(harnessCmd).toContain(
			"--mcp-config /work/.cyrus-plugins/demo/.mcp.json",
		);
		expect(harnessCmd).toContain("--strict-mcp-config");

		// Plugin lifecycle events present.
		const kinds = result.events.map((e) => e.kind);
		expect(kinds).toContain("plugin.materialize.started");
		expect(kinds).toContain("plugin.materialize.completed");

		// SKILL.md content has the right frontmatter.
		const skillFile = sandbox.files.find(
			(f) => f.path === "/work/.cyrus-plugins/demo/skills/hi/SKILL.md",
		)!;
		expect(skillFile.content).toContain("name: hi");
		expect(skillFile.content).toContain("description: Greet the user.");
		expect(skillFile.content).toContain("Say hi.");
	});

	it("materializes sensitive files before setup without exposing contents", async () => {
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "item.completed",
				item: { type: "agent_message", text: "ready" },
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-files",
				harness: "codex",
				files: [
					{
						path: "/home/daytona/.codex/auth.json",
						content: "secret-auth-json",
						sensitive: true,
					},
				],
			},
			{
				sandboxProviders: { local: new FakeSandboxProvider(sandbox) },
			},
		);

		const result = await session.run("Run after files");

		expect(result.success).toBe(true);
		expect(sandbox.files).toEqual([
			{ path: "/home/daytona/.codex/auth.json", content: "secret-auth-json" },
		]);
		expect(result.events.slice(0, 2)).toMatchObject([
			{
				kind: "file.write.started",
				raw: { path: "/home/daytona/.codex/auth.json", sensitive: true },
			},
			{
				kind: "file.write.completed",
				raw: {
					path: "/home/daytona/.codex/auth.json",
					bytes: 16,
					content: "[redacted]",
				},
			},
		]);
	});

	it("threads resumeHarnessSessionId into claude --resume and surfaces harnessSessionId on the result", async () => {
		// End-to-end through createAgentSession: caller hands in the prior
		// harness session id (the AgentSessionManager owns this mapping in
		// real Cyrus), the Claude adapter adds --resume, and the new id
		// emitted by the run lands on the result for the caller to persist.
		const sandbox = new FakeSandbox(
			JSON.stringify({
				type: "system",
				subtype: "init",
				session_id: "claude-new-uuid",
			}),
		);
		const session = await createAgentSession(
			{
				sessionId: "session-resume",
				harness: "claude",
				resumeHarnessSessionId: "claude-prior-uuid",
			},
			{ sandboxProviders: { local: new FakeSandboxProvider(sandbox) } },
		);

		const result = await session.run("follow-up");

		expect(result.success).toBe(true);
		expect(result.harnessSessionId).toBe("claude-new-uuid");
		// `commands[0].args` includes --resume + the prior session id;
		// joining with spaces lets us assert without depending on exact
		// argument order.
		const fullCmdline = [
			sandbox.commands[0]?.command,
			...(sandbox.commands[0]?.args ?? []),
		].join(" ");
		expect(fullCmdline).toContain("--resume claude-prior-uuid");
	});
});

class FakeSandboxProvider implements SandboxProvider {
	readonly provider = "local";

	constructor(private readonly sandbox: RunnerSandbox) {}

	async create(): Promise<RunnerSandbox> {
		return this.sandbox;
	}
}

interface ScheduledChunk {
	delayMs: number;
	stdout?: string;
	stderr?: string;
}

class StreamingFakeSandbox implements RunnerSandbox {
	readonly sandboxId = "fake-stream";
	readonly provider = "local";
	readonly capabilities: RunnerSandboxCapabilities = {
		filesystem: true,
		runCommand: true,
		streamingProcess: true,
	};
	readonly filesystem: SandboxFilesystem = {
		async readFile() {
			return "";
		},
		async writeFile() {},
		async readdir() {
			return [];
		},
		async mkdir() {},
		async exists() {
			return true;
		},
		async remove() {},
	};
	readonly stdinChunks: string[] = [];
	streamCalls = 0;
	runCalls = 0;
	destroyed = 0;

	constructor(private readonly schedule: readonly ScheduledChunk[]) {}

	async runCommand(): Promise<CommandExecutionResult> {
		this.runCalls += 1;
		return { stdout: "", stderr: "", exitCode: 0, durationMs: 0 };
	}

	async streamCommand(
		_command: string,
		options: SandboxStreamCommandOptions = {},
	): Promise<CommandExecutionResult> {
		this.streamCalls += 1;
		const startedAt = Date.now();

		// Drain the input iterable concurrently — fire-and-forget; the caller
		// owns the iterable's lifetime and closes it after streamCommand
		// returns. Mirrors the local + Daytona contract.
		const inputDrainer = options.input
			? (async () => {
					for await (const chunk of options.input!) {
						this.stdinChunks.push(chunk);
					}
				})()
			: undefined;
		inputDrainer?.catch(() => {});

		let stdoutBuf = "";
		let stderrBuf = "";
		let exitCode = 0;
		for (const event of this.schedule) {
			// Honor cancellation so callers that abort via session.stop() /
			// session.destroy() get a timely return rather than waiting out
			// the schedule.
			if (options.signal?.aborted) {
				exitCode = 137; // SIGKILL-ish, common convention for cancelled
				break;
			}
			await new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, event.delayMs);
				options.signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timer);
						resolve();
					},
					{ once: true },
				);
			});
			if (options.signal?.aborted) {
				exitCode = 137;
				break;
			}
			if (event.stdout) {
				stdoutBuf += event.stdout;
				options.onStdout?.(event.stdout);
			}
			if (event.stderr) {
				stderrBuf += event.stderr;
				options.onStderr?.(event.stderr);
			}
		}
		// Give the input drainer a tick to pick up any messages pushed
		// during the schedule before we return.
		await new Promise((resolve) => setTimeout(resolve, 10));
		return {
			stdout: stdoutBuf,
			stderr: stderrBuf,
			exitCode,
			durationMs: Date.now() - startedAt,
		};
	}

	async destroy(): Promise<void> {
		this.destroyed += 1;
	}
}

class FakeSandbox implements RunnerSandbox {
	readonly sandboxId = "fake";
	readonly provider = "local";
	readonly capabilities: RunnerSandboxCapabilities = {
		filesystem: true,
		runCommand: true,
		streamingProcess: false,
	};
	readonly files: Array<{ path: string; content: string }> = [];
	readonly filesystem: SandboxFilesystem = {
		async readFile() {
			return "";
		},
		writeFile: async (path, content) => {
			this.files.push({ path, content });
		},
		async readdir() {
			return [];
		},
		async mkdir() {
			return;
		},
		async exists() {
			return true;
		},
		async remove() {
			return;
		},
	};
	readonly commands: Array<{
		command: string;
		options: unknown;
	}> = [];
	destroyed = 0;

	constructor(private readonly stdout: string) {}

	async runCommand(
		command: string,
		options?: unknown,
	): Promise<CommandExecutionResult> {
		this.commands.push({ command, options });
		return {
			stdout: this.stdout,
			stderr: "",
			exitCode: 0,
			durationMs: 1,
		};
	}

	async destroy(): Promise<void> {
		this.destroyed += 1;
	}
}
