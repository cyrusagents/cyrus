import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunner } from "../src/ClaudeRunner.js";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));

vi.mock("node:fs", async (importOriginal) => ({
	...(await importOriginal<typeof import("node:fs")>()),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
}));

const roots: string[] = [];
afterEach(() => {
	vi.clearAllMocks();
	for (const root of roots.splice(0))
		rmSync(root, { recursive: true, force: true });
});

// The runner boundary must pin the mode even when the settings the child loads
// or the provider/telemetry environment would select another starting mode.
describe("Cyrus permission policy", () => {
	it.each([
		["first party", {}],
		["Bedrock", { CLAUDE_CODE_USE_BEDROCK: "1" }],
		["Vertex", { CLAUDE_CODE_USE_VERTEX: "1" }],
		["Foundry", { CLAUDE_CODE_USE_FOUNDRY: "1" }],
		["telemetry disabled", { DISABLE_TELEMETRY: "1" }],
		["do not track", { DO_NOT_TRACK: "1" }],
	] as const)("keeps default mode for %s, including settings defaultMode", async (_label, env) => {
		const root = mkdtempSync(join(tmpdir(), "cyrus-permission-mode-"));
		roots.push(root);
		mkdirSync(join(root, ".claude"));
		const settingsPath = join(root, ".claude", "settings.json");
		writeFileSync(
			settingsPath,
			JSON.stringify({ permissions: { defaultMode: "auto" } }),
		);
		writeFileSync(
			join(root, ".claude", "settings.local.json"),
			JSON.stringify({ permissions: { defaultMode: "acceptEdits" } }),
		);
		vi.mocked(query).mockImplementation(
			async function* () {} as unknown as typeof query,
		);
		const onAskUserQuestion = vi.fn();
		const runner = new ClaudeRunner({
			workingDirectory: root,
			cyrusHome: root,
			additionalEnv: { ...env },
			allowedTools: ["Read", "Bash(pwd)"],
			disallowedTools: ["Write"],
			onAskUserQuestion,
			resumeSessionId: "existing-session",
		});
		await runner.start("Check permissions");
		const options = vi.mocked(query).mock.calls[0]?.[0].options;
		expect(options).toMatchObject({
			permissionMode: "default",
			settingSources: ["user", "project", "local"],
			cwd: root,
			resume: "existing-session",
			env,
			allowedTools: expect.arrayContaining(["Read", "Bash(pwd)"]),
			disallowedTools: expect.arrayContaining(["Write"]),
			canUseTool: expect.any(Function),
		});
		// Preserve the existing callback contract; this change does not turn
		// allowedTools into an exclusive allowlist or alter explicit deny rules.
		await expect(
			options?.canUseTool?.(
				"Bash",
				{ command: "pwd" },
				{
					signal: new AbortController().signal,
					toolUseID: "permission-test",
				},
			),
		).resolves.toEqual({ behavior: "allow", updatedInput: { command: "pwd" } });
		expect(onAskUserQuestion).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual({
			permissions: { defaultMode: "auto" },
		});
	});
});
