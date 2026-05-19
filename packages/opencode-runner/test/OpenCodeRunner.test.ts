import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	SDKAssistantMessage,
	SDKResultMessage,
	SDKUserMessage,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { OpenCodeRunner } from "../src/OpenCodeRunner.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "cyrus-opencode-runner-"));
}

function fixtureLines(): string {
	const url = new URL("./fixtures/opencode-run-sample.jsonl", import.meta.url);
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
import { readFileSync, writeFileSync } from "node:fs";
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
});
