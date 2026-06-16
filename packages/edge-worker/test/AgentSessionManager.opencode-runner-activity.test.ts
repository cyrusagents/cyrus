import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeRunner } from "cyrus-opencode-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager";
import type { IActivitySink } from "../src/sinks/IActivitySink";

function makeTempDir(): string {
	return mkdtempSync(join(tmpdir(), "cyrus-opencode-activity-"));
}

function fixtureLines(): string {
	const url = new URL(
		"../../opencode-runner/test/fixtures/opencode-run-activity.jsonl",
		import.meta.url,
	);
	return readFileSync(url, "utf8");
}

function writeFakeOpenCode(dir: string): string {
	const script = join(dir, "fake-opencode.mjs");
	writeFileSync(
		script,
		`#!/usr/bin/env node
process.stdin.resume();
process.stdout.write(${JSON.stringify(fixtureLines())});
`,
		{ mode: 0o755 },
	);
	return script;
}

describe("AgentSessionManager - OpenCode activity mapping", () => {
	let manager: AgentSessionManager;
	let mockActivitySink: IActivitySink;
	let postActivitySpy: ReturnType<typeof vi.fn>;
	const sessionId = "test-session-opencode";
	const issueId = "issue-opencode";

	beforeEach(() => {
		mockActivitySink = {
			id: "test-workspace",
			postActivity: vi.fn().mockResolvedValue({ activityId: "activity-123" }),
			createAgentSession: vi.fn().mockResolvedValue("session-123"),
		};

		postActivitySpy = vi.spyOn(mockActivitySink, "postActivity");
		manager = new AgentSessionManager();

		manager.createCyrusAgentSession(
			sessionId,
			issueId,
			{
				id: issueId,
				identifier: "TEST-200",
				title: "OpenCode activity test",
				description: "",
				branchName: "test-branch",
			},
			{
				path: "/tmp/cyrus-opencode-activity",
				isGitWorktree: false,
			},
		);
		manager.setActivitySink(sessionId, mockActivitySink);
	});

	it("creates Linear action and response entries for OpenCode text and tool events", async () => {
		const dir = makeTempDir();
		const runner = new OpenCodeRunner({
			openCodePath: writeFakeOpenCode(dir),
			workingDirectory: dir,
			cyrusHome: dir,
		});
		manager.addAgentRunner(sessionId, runner);

		await runner.start("Inspect and update src/index.ts");
		for (const message of runner.getMessages()) {
			await manager.handleClaudeMessage(sessionId, message);
		}

		const calls = postActivitySpy.mock.calls;
		expect(calls.length).toBeGreaterThanOrEqual(6);

		expect(
			calls.some(
				(call: any[]) =>
					call[1]?.type === "thought" &&
					call[1]?.body === "Using model: opencode",
			),
		).toBe(true);

		const readActionWithResult = calls.find(
			(call: any[]) =>
				call[1]?.type === "action" &&
				call[1]?.action === "Read" &&
				call[1]?.parameter === "src/index.ts" &&
				typeof call[1]?.result === "string",
		);
		expect(readActionWithResult).toBeDefined();
		expect(readActionWithResult![1]?.result).toContain("export const value");

		const editActionWithResult = calls.find(
			(call: any[]) =>
				call[1]?.type === "action" &&
				call[1]?.action === "Edit" &&
				call[1]?.parameter === "src/index.ts" &&
				typeof call[1]?.result === "string",
		);
		expect(editActionWithResult).toBeDefined();
		expect(editActionWithResult![1]?.result).toContain(
			"export const value = 2",
		);

		const todoThought = calls.find(
			(call: any[]) =>
				call[1]?.type === "thought" &&
				typeof call[1]?.body === "string" &&
				call[1]?.body.includes(
					"- [x] Explore cyrus-hosted /settings/tools page and current platform selector",
				) &&
				call[1]?.body.includes(
					"- [ ] Add toolsets to cyrus-core EdgeConfig schema + regenerate JSON schemas (in progress)",
				) &&
				call[1]?.body.includes(
					"- [ ] Wire toolsets through cyrus ConfigManager and ToolPermissionResolver (pending)",
				),
		);
		expect(todoThought).toBeDefined();
		expect(
			calls.some(
				(call: any[]) =>
					call[1]?.type === "action" &&
					call[1]?.action === "todowrite" &&
					typeof call[1]?.parameter === "string" &&
					call[1]?.parameter.includes('"todos"'),
			),
		).toBe(false);

		const finalResponse = calls.find(
			(call: any[]) =>
				call[1]?.type === "response" &&
				typeof call[1]?.body === "string" &&
				call[1]?.body.includes("Updated src/index.ts"),
		);
		expect(finalResponse).toBeDefined();
	});
});
