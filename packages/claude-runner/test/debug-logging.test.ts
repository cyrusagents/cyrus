import { createLogger, LogLevel } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

vi.mock("../src/sandbox-requirements", () => ({
	checkLinuxSandboxRequirements: vi.fn(() => ({
		supported: true,
		platform: "linux",
		failures: [],
	})),
	logSandboxRequirementFailures: vi.fn(),
	resetSandboxRequirementsCacheForTesting: vi.fn(),
}));

vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn(() => false),
	readFileSync: vi.fn(() => ""),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
}));

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

const mockQuery = vi.mocked(query);

function mockSuccessfulQuery(): void {
	mockQuery.mockImplementation(async function* () {
		yield {
			type: "assistant",
			message: { content: [{ type: "text", text: "Done" }] },
			parent_tool_use_id: null,
			session_id: "test-session",
		} as any;
	});
}

function getQueryOptions(): any {
	const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
	return call[0];
}

function makeConfig(
	level: LogLevel,
	debugSpy: ReturnType<typeof vi.fn>,
): ClaudeRunnerConfig {
	const logger = createLogger({ component: "ClaudeRunner", level });
	// Spy on the debug method so we can assert what was logged.
	logger.debug = debugSpy;
	return {
		workingDirectory: "/repo-a",
		cyrusHome: "/tmp/test-cyrus-home",
		logger,
	};
}

describe("ClaudeRunner debug logging", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("sets DEBUG_CLAUDE_AGENT_SDK=1 in the subprocess env when logger level is DEBUG", async () => {
		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig(LogLevel.DEBUG, vi.fn()));
		await runner.start("test");

		expect(getQueryOptions().options.env.DEBUG_CLAUDE_AGENT_SDK).toBe("1");
	});

	it("omits DEBUG_CLAUDE_AGENT_SDK when logger level is above DEBUG", async () => {
		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig(LogLevel.INFO, vi.fn()));
		await runner.start("test");

		expect(
			getQueryOptions().options.env.DEBUG_CLAUDE_AGENT_SDK,
		).toBeUndefined();
	});

	it("logs the query options as JSON when logger level is DEBUG", async () => {
		const debugSpy = vi.fn();
		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig(LogLevel.DEBUG, debugSpy));
		await runner.start("test");

		const optionsLog = debugSpy.mock.calls.find((call) =>
			String(call[0]).startsWith("Claude query options:"),
		);
		expect(optionsLog).toBeDefined();
		const payload = String(optionsLog![0]).replace(
			/^Claude query options:\s*/,
			"",
		);
		const parsed = JSON.parse(payload);
		expect(parsed.options.model).toBe("opus");
		expect(parsed.options.env.DEBUG_CLAUDE_AGENT_SDK).toBe("1");
		expect(parsed.options.abortController).toBe("[AbortController]");
	});

	it("does not log query options at non-debug levels", async () => {
		const debugSpy = vi.fn();
		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig(LogLevel.INFO, debugSpy));
		await runner.start("test");

		const optionsLog = debugSpy.mock.calls.find((call) =>
			String(call[0]).startsWith("Claude query options:"),
		);
		expect(optionsLog).toBeUndefined();
	});
});
