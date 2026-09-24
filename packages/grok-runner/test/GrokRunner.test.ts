import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SDKAssistantMessage, SDKResultMessage } from "miko-core";
import { describe, expect, it } from "vitest";
import { GrokRunner } from "../src/GrokRunner.js";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "miko-grok-runner-"));
}

function writeFakeGrok(
	dir: string,
	body: string,
	captureFile = join(dir, "capture.json"),
): string {
	const script = join(dir, "fake-grok.mjs");
	writeFileSync(
		script,
		`#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const promptFileIdx = argv.indexOf("--prompt-file");
const promptFile = promptFileIdx >= 0 ? argv[promptFileIdx + 1] : undefined;
const promptContents = promptFile ? readFileSync(promptFile, "utf8") : null;
writeFileSync(
	${JSON.stringify(captureFile)},
	JSON.stringify({ argv, promptFile, promptContents }),
);
${body}
`,
		{ mode: 0o755 },
	);
	chmodSync(script, 0o755);
	return script;
}

const sampleOutput = [
	JSON.stringify({
		type: "system",
		subtype: "init",
		session_id: "grok-session-123",
		apiKeySource: "user",
		model: "grok-4.6",
		cwd: "/tmp",
		permissionMode: "default",
		tools: [],
		slash_commands: [],
		mcp_servers: [],
		skills: [],
		uuid: "11111111-1111-1111-1111-111111111111",
	}),
	JSON.stringify({
		type: "assistant",
		session_id: "grok-session-123",
		uuid: "22222222-2222-2222-2222-222222222222",
		parent_tool_use_id: null,
		message: {
			id: "msg_1",
			type: "message",
			role: "assistant",
			model: "grok-4.6",
			content: [{ type: "text", text: "Hello from Grok" }],
			stop_reason: null,
			stop_sequence: null,
			usage: { input_tokens: 1, output_tokens: 2 },
		},
	}),
	JSON.stringify({
		type: "result",
		subtype: "success",
		session_id: "grok-session-123",
		uuid: "33333333-3333-3333-3333-333333333333",
		is_error: false,
		duration_ms: 12,
		duration_api_ms: 10,
		num_turns: 1,
		result: "Hello from Grok",
		stop_reason: "end_turn",
		total_cost_usd: 0,
		usage: {
			input_tokens: 1,
			output_tokens: 2,
			cache_creation_input_tokens: 0,
			cache_read_input_tokens: 0,
		},
		modelUsage: {},
		permission_denials: [],
	}),
].join("\n");

describe("GrokRunner", () => {
	it("spawns grok with streaming-messages-json and maps SDK messages", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const grokPath = writeFakeGrok(
			dir,
			`process.stdout.write(${JSON.stringify(`${sampleOutput}\n`)});`,
			captureFile,
		);
		const messages: unknown[] = [];
		const runner = new GrokRunner({
			grokPath,
			workingDirectory: dir,
			mikoHome: dir,
			model: "grok-4.6",
			maxTurns: 4,
			appendSystemPrompt: "Be brief.",
			onMessage: (message) => {
				messages.push(message);
			},
		});

		const session = await runner.start("Say hello");

		expect(session.sessionId).toBe("grok-session-123");
		expect(session.isRunning).toBe(false);
		expect(runner.supportsStreamingInput).toBe(false);
		expect(runner.isRunning()).toBe(false);
		expect(messages).toEqual(runner.getMessages());

		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.argv.slice(0, 4)).toEqual([
			"--output-format",
			"streaming-messages-json",
			"--always-approve",
			"--cwd",
		]);
		expect(capture.argv).toContain(dir);
		expect(capture.argv).toContain("--prompt-file");
		expect(capture.argv).toContain("-m");
		expect(capture.argv).toContain("grok-4.6");
		expect(capture.argv).toContain("--max-turns");
		expect(capture.argv).toContain("4");

		expect(capture.promptFile).toEqual(expect.stringContaining("prompt.txt"));
		expect(capture.promptContents).toContain("Be brief.");
		expect(capture.promptContents).toContain("Say hello");

		const allMessages = runner.getMessages();
		expect(allMessages[0]).toMatchObject({
			type: "system",
			subtype: "init",
			session_id: "grok-session-123",
		});

		const assistant = allMessages.find(
			(message) => message.type === "assistant",
		) as SDKAssistantMessage | undefined;
		expect(assistant).toBeDefined();
		expect((assistant?.message.content[0] as { text?: string }).text).toBe(
			"Hello from Grok",
		);

		const result = allMessages.at(-1) as SDKResultMessage;
		expect(result.type).toBe("result");
		expect(result.is_error).toBe(false);
	});

	it("resumes with -r when resumeSessionId is set", async () => {
		const dir = makeTempDir();
		const captureFile = join(dir, "capture.json");
		const grokPath = writeFakeGrok(
			dir,
			`process.stdout.write(${JSON.stringify(`${sampleOutput}\n`)});`,
			captureFile,
		);
		const runner = new GrokRunner({
			grokPath,
			workingDirectory: dir,
			mikoHome: dir,
			resumeSessionId: "grok-session-123",
		});

		await runner.start("Continue");
		const capture = JSON.parse(readFileSync(captureFile, "utf8"));
		expect(capture.argv).toContain("-r");
		expect(capture.argv).toContain("grok-session-123");
	});
});
