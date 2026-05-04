import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKResultMessage } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Hoisted mock for @cursor/sdk so we can drive Agent.create / Agent.resume
// from inside each test.
const sdkMock = vi.hoisted(() => {
	const create = vi.fn();
	const resume = vi.fn();
	return {
		create,
		resume,
		// Helper for tests to install a stub agent + run.
		__install(opts: {
			agentId?: string;
			events: any[];
			deltas?: any[];
			throwOnSend?: Error | undefined;
		}) {
			const {
				agentId = "agent-test-1",
				events,
				deltas = [],
				throwOnSend,
			} = opts;
			const stubAgent = {
				agentId,
				model: undefined,
				close: vi.fn(),
				reload: vi.fn(),
				listArtifacts: vi.fn(),
				downloadArtifact: vi.fn(),
				[Symbol.asyncDispose]: vi.fn(),
				send: vi.fn().mockImplementation(async (_msg, options) => {
					if (throwOnSend) throw throwOnSend;
					if (options?.onDelta) {
						for (const update of deltas) {
							await options.onDelta({ update });
						}
					}
					const stubRun = {
						id: "run-1",
						agentId,
						supports: () => true,
						unsupportedReason: () => undefined,
						stream: async function* () {
							for (const ev of events) yield ev;
						},
						conversation: async () => [],
						wait: async () => ({
							id: "run-1",
							status: "finished" as const,
						}),
						cancel: vi.fn().mockResolvedValue(undefined),
						status: "finished" as const,
						onDidChangeStatus: () => () => {},
						result: undefined,
						model: undefined,
						durationMs: 0,
						git: undefined,
						createdAt: 0,
					};
					return stubRun;
				}),
			};
			create.mockResolvedValue(stubAgent);
			resume.mockResolvedValue(stubAgent);
			return stubAgent;
		},
	};
});

vi.mock("@cursor/sdk", () => ({
	Agent: {
		create: sdkMock.create,
		resume: sdkMock.resume,
	},
}));

let CursorRunner: typeof import("../src/CursorRunner.js").CursorRunner;
let tempDirs: string[];

beforeEach(async () => {
	sdkMock.create.mockReset();
	sdkMock.resume.mockReset();
	tempDirs = [];
	({ CursorRunner } = await import("../src/CursorRunner.js"));
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tempWorkspace(): string {
	const dir = mkdtempSync(join(tmpdir(), "cursor-runner-"));
	tempDirs.push(dir);
	return dir;
}

describe("CursorRunner (SDK adapter)", () => {
	it("installs and uninstalls .cursor permission artifacts around a session", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-test-1",
					run_id: "run-1",
				},
				{
					type: "assistant",
					agent_id: "agent-test-1",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "hi" }],
					},
				},
				{
					type: "status",
					agent_id: "agent-test-1",
					run_id: "run-1",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			allowedTools: ["Read(src/**)"],
		});

		// While running we expect the artifacts to be present, but since the
		// stream runs synchronously to completion we instead verify the cleanup.
		await runner.start("hello");

		expect(existsSync(join(workspace, ".cursor", "hooks.json"))).toBe(false);
		expect(
			existsSync(join(workspace, ".cursor", "cyrus-permissions.json")),
		).toBe(false);
		expect(
			existsSync(join(workspace, ".cursor", "cyrus-permission-check.mjs")),
		).toBe(false);
	});

	it("emits init, assistant text, and result messages", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-emit",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-emit",
					run_id: "run-1",
				},
				{
					type: "assistant",
					agent_id: "agent-emit",
					run_id: "run-1",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Hello world" }],
					},
				},
				{
					type: "status",
					agent_id: "agent-emit",
					run_id: "run-1",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
		});
		const session = await runner.start("hi");
		const messages = runner.getMessages();

		expect(session.sessionId).toBe("agent-emit");
		expect(messages[0]?.type).toBe("system");
		const assistant = messages.find((m) => m.type === "assistant");
		expect(assistant).toBeDefined();
		const result = messages[messages.length - 1];
		expect(result?.type).toBe("result");
	});

	it("accumulates token usage from turn-ended deltas into the result message", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-tokens",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-tokens",
					run_id: "r",
				},
				{
					type: "status",
					agent_id: "agent-tokens",
					run_id: "r",
					status: "FINISHED",
				},
			],
			deltas: [
				{
					type: "turn-ended",
					usage: {
						inputTokens: 100,
						outputTokens: 50,
						cacheReadTokens: 10,
						cacheWriteTokens: 5,
					},
				},
				{
					type: "turn-ended",
					usage: {
						inputTokens: 200,
						outputTokens: 75,
						cacheReadTokens: 20,
						cacheWriteTokens: 0,
					},
				},
				// Non-token-bearing delta should not affect totals.
				{ type: "text-delta", text: "hello" },
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
		});
		await runner.start("hi");

		const resultMessage = runner
			.getMessages()
			.find((m): m is SDKResultMessage => m.type === "result");
		expect(resultMessage).toBeDefined();
		const usage = resultMessage!.usage;
		expect(usage.input_tokens).toBe(300);
		expect(usage.output_tokens).toBe(125);
		expect(usage.cache_read_input_tokens).toBe(30);
		expect(usage.cache_creation_input_tokens).toBe(5);
	});

	it("coalesces consecutive assistant text deltas into a single message", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-coalesce",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-coalesce",
					run_id: "r",
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Expl" }],
					},
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "oring " }],
					},
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "the codebase." }],
					},
				},
				{
					type: "tool_call",
					agent_id: "agent-coalesce",
					run_id: "r",
					call_id: "tc-1",
					name: "shell",
					status: "completed",
					args: { command: "ls" },
					result: "ok",
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Found " }],
					},
				},
				{
					type: "assistant",
					agent_id: "agent-coalesce",
					run_id: "r",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "the file." }],
					},
				},
				{
					type: "status",
					agent_id: "agent-coalesce",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
		});
		await runner.start("hi");
		type Block = { type: string; text?: string };
		const assistantTexts: string[] = [];
		for (const m of runner.getMessages() as Array<{
			type: string;
			message?: { content?: unknown };
		}>) {
			if (m.type !== "assistant") continue;
			const content = m.message?.content;
			if (!Array.isArray(content)) continue;
			const text = (content as Block[])
				.filter((b) => b?.type === "text")
				.map((b) => b.text ?? "")
				.join("");
			if (text.length > 0) assistantTexts.push(text);
		}

		// Two assistant turns separated by a tool_use should produce exactly two
		// coalesced messages, not seven (one per delta).
		expect(assistantTexts).toHaveLength(2);
		expect(assistantTexts[0]).toBe("Exploring the codebase.");
		expect(assistantTexts[1]).toBe("Found the file.");
	});

	it("maps tool_call events with status=completed into tool_use + tool_result", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-tc",
					run_id: "r",
				},
				{
					type: "tool_call",
					agent_id: "agent-tc",
					run_id: "r",
					call_id: "tc-1",
					name: "shell",
					status: "completed",
					args: { command: "ls -la" },
					result: "file1\nfile2",
				},
				{
					type: "status",
					agent_id: "agent-tc",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("run a tool");

		const msgs = runner.getMessages();
		const toolUse = msgs.find(
			(m) =>
				m.type === "assistant" &&
				Array.isArray((m as any).message?.content) &&
				(m as any).message.content[0]?.type === "tool_use",
		);
		const toolResult = msgs.find(
			(m) =>
				m.type === "user" &&
				Array.isArray((m as any).message?.content) &&
				(m as any).message.content[0]?.type === "tool_result",
		);
		expect(toolUse).toBeDefined();
		expect(toolResult).toBeDefined();
		expect((toolUse as any).message.content[0].name).toBe("Bash");
		expect((toolResult as any).message.content[0].content).toBe("file1\nfile2");
	});

	it("maps mcp tool_use blocks into mcp__server__tool names", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-mcp",
					run_id: "r",
				},
				{
					type: "assistant",
					agent_id: "agent-mcp",
					run_id: "r",
					message: {
						role: "assistant",
						content: [
							{
								type: "tool_use",
								id: "tu-1",
								name: "mcp",
								input: {
									providerIdentifier: "linear",
									toolName: "list_issues",
									args: { teamId: "abc" },
								},
							},
						],
					},
				},
				{
					type: "status",
					agent_id: "agent-mcp",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("call mcp");
		const msgs = runner.getMessages();
		const tu = msgs.find(
			(m) =>
				m.type === "assistant" &&
				(m as any).message.content[0]?.type === "tool_use",
		) as any;
		expect(tu.message.content[0].name).toBe("mcp__linear__list_issues");
		expect(tu.message.content[0].input).toEqual({ teamId: "abc" });
	});

	it("uses Agent.resume when resumeSessionId is provided", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			agentId: "agent-resumed",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-resumed",
					run_id: "r",
				},
				{
					type: "status",
					agent_id: "agent-resumed",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			resumeSessionId: "agent-resumed",
		});
		await runner.start("continue");
		expect(sdkMock.resume).toHaveBeenCalledTimes(1);
		expect(sdkMock.create).not.toHaveBeenCalled();
	});

	it("emits an error result when SDK send throws", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		sdkMock.__install({
			events: [],
			throwOnSend: new Error("auth boom"),
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		runner.on("error", () => {});
		await runner.start("hi");
		const msgs = runner.getMessages();
		const last = msgs[msgs.length - 1] as any;
		expect(last.type).toBe("result");
		expect(last.is_error).toBe(true);
	});

	it("writes Cyrus permission config file with translated patterns during run", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();

		// Capture the file contents during the stream by reading them in the
		// first event handler. We accomplish this with an SDK mock whose stream
		// reads the file before yielding.
		let capturedConfig: any = null;
		sdkMock.__install({
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-cap",
					run_id: "r",
				},
			],
		});
		// Override send to read the file before streaming.
		const installedAgent = await sdkMock.create.mock.results[0]?.value;
		void installedAgent;
		// Re-install with pre-stream file capture via a custom send.
		sdkMock.create.mockResolvedValueOnce({
			agentId: "agent-cap",
			model: undefined,
			close: () => {},
			reload: async () => {},
			listArtifacts: async () => [],
			downloadArtifact: async () => Buffer.alloc(0),
			[Symbol.asyncDispose]: async () => {},
			send: async () => {
				const cfgPath = join(workspace, ".cursor", "cyrus-permissions.json");
				capturedConfig = JSON.parse(readFileSync(cfgPath, "utf8"));
				return {
					id: "run",
					agentId: "agent-cap",
					supports: () => true,
					unsupportedReason: () => undefined,
					stream: async function* () {
						yield {
							type: "status",
							agent_id: "agent-cap",
							run_id: "r",
							status: "FINISHED",
						};
					},
					conversation: async () => [],
					wait: async () => ({ id: "run", status: "finished" as const }),
					cancel: async () => {},
					status: "finished" as const,
					onDidChangeStatus: () => () => {},
				} as any;
			},
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			allowedTools: ["Read(src/**)", "Bash(git:*)"],
			disallowedTools: ["Bash(rm:*)"],
		});
		await runner.start("hi");

		expect(capturedConfig).toBeTruthy();
		expect(capturedConfig.allow).toEqual(
			expect.arrayContaining(["Read(src/**)", "Shell(git)", "Shell(git:*)"]),
		);
		expect(capturedConfig.deny).toEqual(
			expect.arrayContaining(["Shell(rm)", "Shell(rm:*)"]),
		);
	});

	it("writes .cursor/sandbox.json and passes sandboxOptions when sandbox enabled", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		let capturedAgentOpts: any = null;
		const realCreate = sdkMock.create.getMockImplementation();
		sdkMock.create.mockImplementationOnce(async (opts: any) => {
			capturedAgentOpts = opts;
			// Snapshot the sandbox.json that the runner just wrote (the SDK
			// would read it during startup).
			const fs = require("node:fs");
			const path = require("node:path");
			const sbPath = path.join(workspace, ".cursor", "sandbox.json");
			const sandboxJson = fs.existsSync(sbPath)
				? JSON.parse(fs.readFileSync(sbPath, "utf8"))
				: null;
			return realCreate
				? realCreate(opts)
				: {
						agentId: "agent-sandbox",
						model: undefined,
						send: async () => ({
							id: "r",
							agentId: "agent-sandbox",
							supports: () => true,
							unsupportedReason: () => undefined,
							stream: async function* () {},
							conversation: async () => [],
							wait: async () => ({ id: "r", status: "finished" as const }),
							cancel: async () => {},
							status: "finished" as const,
							onDidChangeStatus: () => () => {},
							result: undefined,
							model: undefined,
							durationMs: 0,
							git: undefined,
							createdAt: 0,
						}),
						close: () => {},
						reload: async () => {},
						listArtifacts: async () => [],
						downloadArtifact: async () => Buffer.alloc(0),
						[Symbol.asyncDispose]: async () => {},
						_sandboxJson: sandboxJson,
					};
		});
		sdkMock.__install({
			agentId: "agent-sandbox",
			events: [
				{
					type: "system",
					subtype: "init",
					agent_id: "agent-sandbox",
					run_id: "r",
				},
				{
					type: "status",
					agent_id: "agent-sandbox",
					run_id: "r",
					status: "FINISHED",
				},
			],
		});

		const runner = new CursorRunner({
			cyrusHome,
			workingDirectory: workspace,
			sandboxSettings: {
				enabled: true,
				network: {
					allowedDomains: ["api.linear.app"],
					httpProxyPort: 9876,
				},
				filesystem: {
					allowWrite: [workspace, "/tmp/extra-write"],
				},
			},
			egressCaCertPath: "/abs/ca.pem",
		});

		const prevHttpProxy = process.env.HTTP_PROXY;
		const prevNodeCa = process.env.NODE_EXTRA_CA_CERTS;
		try {
			await runner.start("hi");
		} finally {
			// Confirm env was restored after session
			expect(process.env.HTTP_PROXY).toBe(prevHttpProxy);
			expect(process.env.NODE_EXTRA_CA_CERTS).toBe(prevNodeCa);
		}

		expect(capturedAgentOpts.local.sandboxOptions).toEqual({ enabled: true });

		const fs = require("node:fs");
		const path = require("node:path");
		// sandbox.json should be removed at session end
		expect(fs.existsSync(path.join(workspace, ".cursor", "sandbox.json"))).toBe(
			false,
		);
	});

	it("does not pass sandboxOptions.enabled=true when sandbox is disabled", async () => {
		const workspace = tempWorkspace();
		const cyrusHome = tempWorkspace();
		let capturedAgentOpts: any = null;
		sdkMock.create.mockImplementationOnce(async (opts: any) => {
			capturedAgentOpts = opts;
			return {
				agentId: "agent-no-sb",
				model: undefined,
				send: async () => ({
					id: "r",
					agentId: "agent-no-sb",
					supports: () => true,
					unsupportedReason: () => undefined,
					stream: async function* () {},
					conversation: async () => [],
					wait: async () => ({ id: "r", status: "finished" as const }),
					cancel: async () => {},
					status: "finished" as const,
					onDidChangeStatus: () => () => {},
					result: undefined,
					model: undefined,
					durationMs: 0,
					git: undefined,
					createdAt: 0,
				}),
				close: () => {},
				reload: async () => {},
				listArtifacts: async () => [],
				downloadArtifact: async () => Buffer.alloc(0),
				[Symbol.asyncDispose]: async () => {},
			};
		});

		const runner = new CursorRunner({ cyrusHome, workingDirectory: workspace });
		await runner.start("hi");

		expect(capturedAgentOpts.local.sandboxOptions).toEqual({ enabled: false });
	});
});
