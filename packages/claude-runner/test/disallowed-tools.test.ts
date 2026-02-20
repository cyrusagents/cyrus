import * as claudeCode from "@anthropic-ai/claude-agent-sdk";
import { createLogger, LogLevel } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

// Mock the query function from @anthropic-ai/claude-agent-sdk
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock file system with all required methods
vi.mock("fs", () => ({
	readFileSync: vi.fn(),
	existsSync: vi.fn(() => true),
	mkdirSync: vi.fn(),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	statSync: vi.fn(() => ({
		isDirectory: vi.fn(() => true),
	})),
}));

describe("ClaudeRunner - disallowedTools", () => {
	const queryMock = vi.mocked(claudeCode.query);

	beforeEach(() => {
		vi.clearAllMocks();

		// Mock the query to return an async generator
		queryMock.mockImplementation(async function* () {
			// Empty generator for testing
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
	});

	it("should pass disallowedTools to Claude Code when configured", async () => {
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read(**)", "Edit(**)"],
			disallowedTools: ["Bash", "WebFetch"],
			cyrusHome: "/test/cyrus",
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			// Yield a session ID message
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);

		// Run the query with a test prompt
		const prompt = "Test prompt";
		const _messages = [];

		await runner.start(prompt);

		// Check that query was called with disallowedTools
		expect(queryMock).toHaveBeenCalledTimes(1);
		const callArgs = queryMock.mock.calls[0][0];

		expect(callArgs.options).toBeDefined();
		expect(callArgs.options.disallowedTools).toEqual(["Bash", "WebFetch"]);
		expect(callArgs.options.allowedTools).toContain("Read(**)");
		expect(callArgs.options.allowedTools).toContain("Edit(**)");
	});

	it("should not pass disallowedTools when not configured", async () => {
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read(**)", "Edit(**)"],
			// No disallowedTools
			cyrusHome: "/test/cyrus",
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);
		await runner.start("Test prompt");

		// Check that query was called without disallowedTools
		expect(queryMock).toHaveBeenCalledTimes(1);
		const callArgs = queryMock.mock.calls[0][0];

		expect(callArgs.options).toBeDefined();
		expect(callArgs.options.disallowedTools).toBeUndefined();
		expect(callArgs.options.allowedTools).toContain("Read(**)");
		expect(callArgs.options.allowedTools).toContain("Edit(**)");
	});

	it("should handle empty disallowedTools array", async () => {
		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			allowedTools: ["Read(**)", "Edit(**)"],
			disallowedTools: [], // Empty array
			cyrusHome: "/test/cyrus",
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);
		await runner.start("Test prompt");

		// Check that query was called without disallowedTools (empty array is falsy)
		expect(queryMock).toHaveBeenCalledTimes(1);
		const callArgs = queryMock.mock.calls[0][0];

		expect(callArgs.options).toBeDefined();
		expect(callArgs.options.disallowedTools).toBeUndefined();
	});

	it("should log disallowedTools when configured", async () => {
		const consoleSpy = vi.spyOn(console, "log");

		const config: ClaudeRunnerConfig = {
			workingDirectory: "/test",
			disallowedTools: ["Bash", "SystemAccess", "DangerousTool"],
			cyrusHome: "/test/cyrus",
			logger: createLogger({
				component: "ClaudeRunner",
				level: LogLevel.DEBUG,
			}),
		};

		// Mock the query to capture arguments and return a session ID message
		queryMock.mockImplementation(async function* (_args: any) {
			yield {
				type: "system",
				role: "session_info",
				content: {
					session_id: "test-session",
				},
			};
		});

		const runner = new ClaudeRunner(config);
		await runner.start("Test");

		// Check that disallowedTools were logged (now at DEBUG level via logger)
		expect(consoleSpy).toHaveBeenCalledWith(
			"[DEBUG] [ClaudeRunner] Disallowed tools configured:",
			["Bash", "SystemAccess", "DangerousTool"],
		);

		consoleSpy.mockRestore();
	});
});
