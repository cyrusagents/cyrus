import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock file system operations
vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
}));

// Mock os module
vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

describe("spawnClaudeCodeProcess", () => {
	let mockQuery: any;

	const baseConfig: ClaudeRunnerConfig = {
		workingDirectory: "/tmp/test",
		atmikoHome: "/tmp/test-atmiko-home",
	};

	function mockSuccessfulQuery() {
		mockQuery.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "Done" }] },
				parent_tool_use_id: null,
				session_id: "test-session",
			} as any;
		});
	}

	function getQueryOptions(): Record<string, unknown> {
		const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
		return call[0].options;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		mockQuery = vi.mocked(query);
	});

	it("should forward the spawn override to the SDK when configured", async () => {
		const spawnClaudeCodeProcess = vi.fn() as unknown as NonNullable<
			ClaudeRunnerConfig["spawnClaudeCodeProcess"]
		>;

		mockSuccessfulQuery();
		const runner = new ClaudeRunner({ ...baseConfig, spawnClaudeCodeProcess });
		await runner.start("test");

		expect(getQueryOptions().spawnClaudeCodeProcess).toBe(
			spawnClaudeCodeProcess,
		);
	});

	it("should omit the spawn override when not configured", async () => {
		mockSuccessfulQuery();
		const runner = new ClaudeRunner(baseConfig);
		await runner.start("test");

		expect(getQueryOptions()).not.toHaveProperty("spawnClaudeCodeProcess");
	});
});
