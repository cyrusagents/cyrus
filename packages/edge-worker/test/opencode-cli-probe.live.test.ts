import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeRunner } from "cyrus-opencode-runner";
import { describe, expect, it } from "vitest";

const liveEnabled = process.env.OPENCODE_LIVE === "1";
const describeLive = liveEnabled ? describe : describe.skip;

describeLive("OpenCode CLI live probe", () => {
	it("runs opencode with JSON output and exposes text/tool activity messages", async () => {
		const dir = mkdtempSync(join(tmpdir(), "cyrus-opencode-live-probe-"));
		const runner = new OpenCodeRunner({
			openCodePath: process.env.OPENCODE_PATH,
			workingDirectory: dir,
			cyrusHome: dir,
			model: process.env.OPENCODE_PROBE_MODEL,
			title: "Cyrus OpenCode live probe",
			allowedTools: ["Read(**)", "Bash(ls:*)"],
			disallowedTools: ["Write(**)", "Edit(**)"],
		});

		await runner.start(
			"List the files in the current directory, then respond with exactly: OPENCODE_PROBE_OK",
		);

		const messages = runner.getMessages();
		const result = messages.at(-1);
		expect(result).toMatchObject({
			type: "result",
			subtype: "success",
			is_error: false,
		});
		expect(JSON.stringify(messages)).toContain("OPENCODE_PROBE_OK");
		expect(
			messages.some(
				(message: any) =>
					message.type === "assistant" &&
					message.message?.content?.some(
						(block: any) => block.type === "tool_use",
					),
			),
		).toBe(true);
	});
});

describe("OpenCode CLI live probe guard", () => {
	it("documents the opt-in command", () => {
		expect(
			"OPENCODE_LIVE=1 OPENCODE_PROBE_MODEL=openai/gpt-5.5 pnpm --filter cyrus-edge-worker exec vitest run test/opencode-cli-probe.live.test.ts",
		).toContain("OPENCODE_LIVE=1");
	});
});
