import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	SDKAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { OpenCodeRunner } from "../src/OpenCodeRunner.js";
import { SimpleOpenCodeRunner } from "../src/SimpleOpenCodeRunner.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "cyrus-opencode-runner-"));
}

function fixtureLines(
	name:
		| "opencode-run-sample.jsonl"
		| "opencode-run-realistic.jsonl" = "opencode-run-sample.jsonl",
): string {
	const url = new URL(`./fixtures/${name}`, import.meta.url);
	return readFileSync(url, "utf8");
}

function writeFakeOpenCode(
	dir: string,
	body: string,
	captureFile = join(dir, "capture.json"),
): string {
	const script = join(dir, "fake-opencode.mjs");
	writeFileSync(
		script,
		`#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
const stdin = readFileSync(0, "utf8");
writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin }));
${body}
`,
		{ mode: 0o755 },
	);
	return script;
}

describe("OpenCodeRunner", () => {
	it("spawns opencode run with JSON output flags and maps replay events to Cyrus messages", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const opencodePath = writeFakeOpenCode(
			dir,
			`process.stdout.write(${JSON.stringify(fixtureLines())});`,
			captureFile,
		);
		const messages: unknown[] = [];
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			title: "NG-61 OpenCode runner",
			model: "anthropic/claude-sonnet-4.5",
			agent: "build",
			onMessage: (message) => {
				messages.push(message);
			},
		});

		const session = await runner.start("Implement OpenCode runner");

		expect(session.sessionId).toBe("oc_session_123");
		expect(session.isRunning).toBe(false);
		expect(runner.supportsStreamingInput).toBe(false);
		expect(runner.isRunning()).toBe(false);
		expect(messages).toEqual(runner.getMessages());

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.stdin).toBe("Implement OpenCode runner");
		expect(capture.argv).toEqual([
			"run",
			"--format",
			"json",
			"--dir",
			dir,
			"--title",
			"NG-61 OpenCode runner",
			"--model",
			"anthropic/claude-sonnet-4.5",
			"--agent",
			"build",
		]);

		const allMessages = runner.getMessages();
		expect(allMessages[0]).toMatchObject({
			type: "system",
			subtype: "init",
			session_id: "oc_session_123",
		});

		const toolUse = allMessages.find(
			(message) =>
				message.type === "assistant" &&
				(message as SDKAssistantMessage).message.content.some(
					(block: any) => block.type === "tool_use" && block.id === "call_1",
				),
		) as SDKAssistantMessage | undefined;
		expect(toolUse).toBeDefined();
		expect((toolUse?.message.content[0] as any).name).toBe("Bash");
		expect((toolUse?.message.content[0] as any).input).toEqual({
			command: 'rg -n "OpenCode" packages',
		});

		const toolResult = allMessages.find(
			(message) =>
				message.type === "user" &&
				(message as SDKUserMessage).message.content.some(
					(block: any) =>
						block.type === "tool_result" && block.tool_use_id === "call_1",
				),
		) as SDKUserMessage | undefined;
		expect(toolResult).toBeDefined();
		expect((toolResult?.message.content[0] as any).is_error).toBe(false);
		expect((toolResult?.message.content[0] as any).content).toContain(
			"OpenCodeRunner.ts",
		);

		const assistantText = allMessages.find(
			(message) =>
				message.type === "assistant" &&
				(message as SDKAssistantMessage).message.content.some(
					(block: any) =>
						block.type === "text" &&
						block.text === "Implemented the OpenCode runner package.",
				),
		);
		expect(assistantText).toBeDefined();

		const result = allMessages.at(-1) as SDKResultMessage;
		expect(result).toMatchObject({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "Implemented the OpenCode runner package.",
			session_id: "oc_session_123",
			total_cost_usd: 0.0042,
		});
		expect(result.usage.input_tokens).toBe(111);
		expect(result.usage.output_tokens).toBe(22);
		expect(result.usage.cache_read_input_tokens).toBe(3);
	});

	it("preserves provider-qualified models for OpenCode CLI", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const opencodePath = writeFakeOpenCode(
			dir,
			`process.stdout.write(${JSON.stringify(fixtureLines())});`,
			captureFile,
		);
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			model: "openai/gpt-5.5",
		});

		await runner.start("Run with OpenAI model");

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.argv).toContain("--model");
		expect(capture.argv).toContain("openai/gpt-5.5");

		const init = runner.getMessages()[0];
		expect(init).toMatchObject({
			type: "system",
			subtype: "init",
			model: "openai/gpt-5.5",
		});
	});

	it("coerces realistic OpenCode JSON events into Cyrus messages and final result", async () => {
		const dir = makeTempDir();
		const opencodePath = writeFakeOpenCode(
			dir,
			`process.stdout.write(${JSON.stringify(fixtureLines("opencode-run-realistic.jsonl"))});`,
		);
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			model: "openai/gpt-5.5",
		});

		const session = await runner.start("Replay a realistic OpenCode run");

		expect(session.sessionId).toBe("oc_realistic_456");
		const allMessages = runner.getMessages();

		const readUse = allMessages.find(
			(message) =>
				message.type === "assistant" &&
				(message as SDKAssistantMessage).message.content.some(
					(block: any) => block.type === "tool_use" && block.id === "read_1",
				),
		) as SDKAssistantMessage | undefined;
		expect(readUse).toBeDefined();
		expect((readUse?.message.content[0] as any).name).toBe("Read");
		expect((readUse?.message.content[0] as any).input).toMatchObject({
			filePath: "/tmp/f1-test/src/index.ts",
			file_path: "/tmp/f1-test/src/index.ts",
		});

		const erroredToolResult = allMessages.find(
			(message) =>
				message.type === "user" &&
				(message as SDKUserMessage).message.content.some(
					(block: any) =>
						block.type === "tool_result" && block.tool_use_id === "shell_1",
				),
		) as SDKUserMessage | undefined;
		expect(erroredToolResult).toBeDefined();
		expect((erroredToolResult?.message.content[0] as any).is_error).toBe(true);
		expect((erroredToolResult?.message.content[0] as any).content).toContain(
			"No projects matched the filter",
		);

		const editResult = allMessages.find(
			(message) =>
				message.type === "user" &&
				(message as SDKUserMessage).message.content.some(
					(block: any) =>
						block.type === "tool_result" && block.tool_use_id === "edit_1",
				),
		) as SDKUserMessage | undefined;
		expect(editResult).toBeDefined();
		expect((editResult?.message.content[0] as any).content).toContain(
			"OpenCodeProbe",
		);

		const result = allMessages.at(-1) as SDKResultMessage;
		expect(result).toMatchObject({
			type: "result",
			subtype: "success",
			is_error: false,
			result: "Validated OpenCode transcript replay.",
			session_id: "oc_realistic_456",
			stop_reason: "end_turn",
			total_cost_usd: 0.0123,
		});
		expect(result.usage.input_tokens).toBe(321);
		expect(result.usage.output_tokens).toBe(45);
		expect(result.usage.cache_read_input_tokens).toBe(7);
		expect(result.usage.cache_creation_input_tokens).toBe(2);
	});

	it("passes resume session id through --session", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const opencodePath = writeFakeOpenCode(
			dir,
			`process.stdout.write(${JSON.stringify(fixtureLines())});`,
			captureFile,
		);
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			title: "Resume OpenCode",
			resumeSessionId: "oc_existing",
		});

		await runner.start("Continue work");

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.argv).toContain("--session");
		expect(capture.argv).toContain("oc_existing");
	});

	it("warns when shared runner config fields are unsupported by OpenCode", async () => {
		const dir = makeTempDir();
		const opencodePath = writeFakeOpenCode(
			dir,
			`process.stdout.write(${JSON.stringify(fixtureLines())});`,
		);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			appendSystemPrompt: "Use terse answers",
			maxTurns: 3,
			fallbackModel: "anthropic/claude-haiku-4.5",
		});

		await runner.start("Configured run");

		expect(warn).toHaveBeenCalledWith(
			"[OpenCodeRunner] Unsupported config entry skipped: appendSystemPrompt: OpenCode CLI does not support appended system prompts for `opencode run`",
		);
		expect(warn).toHaveBeenCalledWith(
			"[OpenCodeRunner] Unsupported config entry skipped: maxTurns: OpenCode CLI does not expose a max-turns runtime option",
		);
		expect(warn).toHaveBeenCalledWith(
			"[OpenCodeRunner] Unsupported config entry skipped: fallbackModel: OpenCode CLI does not expose a fallback-model runtime option",
		);
		warn.mockRestore();
	});

	it("passes OpenCode runtime config through environment", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const opencodePath = writeFakeOpenCode(
			dir,
			`
writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  argv: process.argv.slice(2),
  stdin,
  opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT,
  xdgDataHome: process.env.XDG_DATA_HOME,
  xdgStateHome: process.env.XDG_STATE_HOME,
  xdgCacheHome: process.env.XDG_CACHE_HOME,
  xdgConfigHome: process.env.XDG_CONFIG_HOME,
}));
process.stdout.write(${JSON.stringify(fixtureLines())});
`,
			captureFile,
		);
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			env: {
				XDG_STATE_HOME: "/parent/state",
				XDG_CACHE_HOME: "/parent/cache",
				XDG_CONFIG_HOME: "/parent/config",
			},
			allowedTools: ["Read(**)", "mcp__linear__get_issue"],
			disallowedTools: ["Bash(rm:*)"],
			mcpConfig: {
				linear: {
					type: "http",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
				} as any,
			},
		});

		await runner.start("Configured run");

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.xdgDataHome).toBeUndefined();
		expect(capture.xdgStateHome).toBe("/parent/state");
		expect(capture.xdgCacheHome).toBe("/parent/cache");
		expect(capture.xdgConfigHome).toBe("/parent/config");
		expect(JSON.parse(capture.opencodeConfig)).toMatchObject({
			mcp: {
				linear: {
					type: "remote",
					url: "https://mcp.linear.app/mcp",
					headers: { Authorization: "Bearer token" },
					enabled: true,
				},
			},
			permission: {
				"*": "deny",
				read: {
					"*": "deny",
					"**": "allow",
				},
				bash: {
					"*": "deny",
					"rm *": "deny",
				},
				linear_get_issue: "allow",
			},
		});
	});

	it("SimpleOpenCodeRunner extracts the final result when no assistant text is emitted", async () => {
		const dir = makeTempDir();
		const opencodePath = writeFakeOpenCode(
			dir,
			`
process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "oc_simple" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", result: "approve" }) + "\\n");
`,
		);
		const runner = new SimpleOpenCodeRunner({
			validResponses: ["approve", "reject"] as const,
			cyrusHome: dir,
			workingDirectory: dir,
			openCodePath: opencodePath,
		} as any);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const result = await runner.query("Should we approve?");
		warn.mockRestore();

		expect(result.response).toBe("approve");
		expect(result.messages.at(-1)).toMatchObject({
			type: "result",
			result: "approve",
		});
	});

	it("SimpleOpenCodeRunner grants read, glob, and grep when file reading is allowed", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const opencodePath = writeFakeOpenCode(
			dir,
			`
writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  opencodeConfig: process.env.OPENCODE_CONFIG_CONTENT,
}));
process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "oc_simple" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "step_finish", result: "approve" }) + "\\n");
`,
			captureFile,
		);
		const runner = new SimpleOpenCodeRunner({
			validResponses: ["approve", "reject"] as const,
			cyrusHome: dir,
			workingDirectory: dir,
			openCodePath: opencodePath,
		} as any);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		await runner.query("Should we approve?", { allowFileReading: true });
		warn.mockRestore();

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(JSON.parse(capture.opencodeConfig).permission).toMatchObject({
			"*": "deny",
			read: {
				"*": "deny",
				"**": "allow",
			},
			glob: {
				"*": "allow",
			},
			grep: {
				"*": "allow",
			},
		});
	});

	it("does not copy Cyrus skills or synthesize bootstrap skills into OpenCode config", async () => {
		const dir = makeTempDir();
		const pluginPath = join(dir, "cyrus-skills-plugin");
		const skillPath = join(pluginPath, "skills", "debug");
		const captureFile = join(dir, "capture.json");
		mkdirSync(skillPath, { recursive: true });
		writeFileSync(
			join(skillPath, "SKILL.md"),
			[
				"---",
				"name: debug",
				"description: Debug a reported issue",
				"---",
				"Reproduce the bug before fixing it.",
			].join("\n"),
			{ flag: "w" },
		);
		const opencodePath = writeFakeOpenCode(
			dir,
			`
writeFileSync(${JSON.stringify(captureFile)}, JSON.stringify({
  opencodeConfigDir: process.env.OPENCODE_CONFIG_DIR,
  debugSkillExists: process.env.OPENCODE_CONFIG_DIR
    && existsSync(process.env.OPENCODE_CONFIG_DIR + "/skills/debug/SKILL.md")
    ? readFileSync(process.env.OPENCODE_CONFIG_DIR + "/skills/debug/SKILL.md", "utf8").includes("Debug a reported issue")
    : false,
  skillsDirectoryExists: process.env.OPENCODE_CONFIG_DIR
    && existsSync(process.env.OPENCODE_CONFIG_DIR + "/skills"),
}));
process.stdout.write(${JSON.stringify(fixtureLines())});
`,
			captureFile,
		);
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
			opencodeStateScope: "shared",
			allowedTools: ["Skill"],
			plugins: [{ type: "local", path: pluginPath } as any],
			skills: ["debug"],
		});

		await runner.start("Use the configured local workflow");

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.opencodeConfigDir).toBeTruthy();
		expect(capture.debugSkillExists).toBe(false);
		expect(capture.skillsDirectoryExists).toBe(false);
		expect(
			existsSync(
				join(capture.opencodeConfigDir, "skills", "debug", "SKILL.md"),
			),
		).toBe(false);
	});

	it("stops a running OpenCode process", async () => {
		const dir = makeTempDir();
		const opencodePath = writeFakeOpenCode(
			dir,
			`
process.stdout.write(JSON.stringify({ type: "step_start", sessionID: "oc_slow" }) + "\\n");
setTimeout(() => process.stdout.write(JSON.stringify({ type: "text", part: { text: "too late" } }) + "\\n"), 2000);
setTimeout(() => process.exit(0), 3000);
`,
		);
		const runner = new OpenCodeRunner({
			openCodePath: opencodePath,
			workingDirectory: dir,
			cyrusHome: dir,
		});

		const startPromise = runner.start("Long task");
		await new Promise((resolve) => setTimeout(resolve, 100));

		expect(runner.isRunning()).toBe(true);
		runner.stop();
		await startPromise;

		expect(runner.isRunning()).toBe(false);
		const result = runner.getMessages().at(-1) as SDKResultMessage;
		expect(result.type).toBe("result");
		expect(result.is_error).toBe(true);
		expect(result.subtype).toBe("error_during_execution");
	});

	it("finalizes once when child error and close events both fire", async () => {
		const dir = makeTempDir();
		const errors: Error[] = [];
		let completeCount = 0;
		const messages: unknown[] = [];
		const runner = new OpenCodeRunner({
			openCodePath: join(dir, "missing-opencode"),
			workingDirectory: dir,
			cyrusHome: dir,
			onError: (error) => errors.push(error),
			onComplete: () => completeCount++,
			onMessage: (message) => messages.push(message),
		});

		await runner.start("Run missing binary");

		expect(errors).toHaveLength(1);
		expect(completeCount).toBe(1);
		expect(
			messages.filter((message: any) => message.type === "result"),
		).toHaveLength(1);
		expect(
			runner.getMessages().filter((message) => message.type === "result"),
		).toHaveLength(1);
	});
});
