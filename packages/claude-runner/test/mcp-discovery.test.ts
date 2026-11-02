import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

// Only the SDK and the Linux sandbox precheck are mocked; the project
// directory and its `.mcp.json` are real files on disk.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({ query: vi.fn() }));
vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";

const SENTINEL = "sentinel-not-a-real-credential";

describe("disableMcpDiscovery (Jira tasks)", () => {
	let root: string;
	let project: string;
	let extraConfig: string;
	const roots: string[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		root = mkdtempSync(join(tmpdir(), "cyrus-mcp-discovery-"));
		roots.push(root);
		// Session log streams are opened asynchronously under cyrusHome.
		mkdirSync(join(root, "home", "logs", "project"), { recursive: true });
		project = join(root, "project");
		mkdirSync(project);
		// A tracked, credential-bearing project MCP config in the worktree.
		writeFileSync(
			join(project, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					"repo-secrets": {
						type: "http",
						url: "https://mcp.example.test/mcp",
						headers: { Authorization: `Bearer ${SENTINEL}` },
					},
				},
			}),
		);
		extraConfig = join(root, "platform.mcp.json");
		writeFileSync(
			extraConfig,
			JSON.stringify({
				mcpServers: { platform: { type: "stdio", command: "echo" } },
			}),
		);
		vi.mocked(query).mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "Done" }] },
				parent_tool_use_id: null,
				session_id: "s1",
			} as any;
		} as any);
	});

	afterAll(async () => {
		await new Promise((resolve) => setTimeout(resolve, 50));
		for (const dir of roots) rmSync(dir, { recursive: true, force: true });
	});

	const lastOptions = () => {
		const calls = vi.mocked(query).mock.calls;
		return (calls[calls.length - 1]![0] as { options: any }).options;
	};

	it("loads no project, file or inline MCP servers and forces strict mode", async () => {
		const runner = new ClaudeRunner({
			workingDirectory: project,
			cyrusHome: join(root, "home"),
			mcpConfigPath: extraConfig,
			mcpConfig: {
				linear: { type: "http", url: "https://mcp.linear.app/mcp" },
			},
			strictMcpConfig: false,
			disableMcpDiscovery: true,
		});
		await runner.start("hi");
		const options = lastOptions();
		expect(options.mcpServers).toBeUndefined();
		expect(options.strictMcpConfig).toBe(true);
		expect(JSON.stringify(options)).not.toContain(SENTINEL);
	});

	it("default sessions still auto-load the worktree .mcp.json", async () => {
		const runner = new ClaudeRunner({
			workingDirectory: project,
			cyrusHome: join(root, "home"),
		});
		await runner.start("hi");
		expect(Object.keys(lastOptions().mcpServers ?? {})).toEqual([
			"repo-secrets",
		]);
	});
});
