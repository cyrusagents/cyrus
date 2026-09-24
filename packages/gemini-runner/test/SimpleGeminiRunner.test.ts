import type {
	SDKAssistantMessage,
	SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { SimpleAgentRunnerConfig } from "miko-simple-agent-runner";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeminiRunner } from "../src/GeminiRunner.js";
import { SimpleGeminiRunner } from "../src/SimpleGeminiRunner.js";
import { TEST_MIKO_HOME, TEST_WORKING_DIR } from "./test-dirs.js";

// Mock GeminiRunner
vi.mock("../src/GeminiRunner.js", () => {
	return {
		GeminiRunner: vi.fn(),
	};
});

const MockedGeminiRunner = vi.mocked(GeminiRunner);

describe("SimpleGeminiRunner", () => {
	let runner: SimpleGeminiRunner<"approve" | "reject">;
	let mockRunner: any;
	let eventHandlers: Map<string, (arg: any) => void>;

	const defaultConfig: SimpleAgentRunnerConfig<"approve" | "reject"> = {
		validResponses: ["approve", "reject"] as const,
		mikoHome: TEST_MIKO_HOME,
		workingDirectory: TEST_WORKING_DIR,
		model: "gemini-2.5-flash",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		eventHandlers = new Map();

		// Create a fresh mock for each test with proper event handling
		mockRunner = {
			start: vi.fn().mockImplementation(async () => {
				// Simulate message event
				const messageHandler = eventHandlers.get("message");
				const completeHandler = eventHandlers.get("complete");

				if (messageHandler && mockRunner._messages) {
					for (const msg of mockRunner._messages) {
						messageHandler(msg);
					}
				}

				if (completeHandler && mockRunner._messages) {
					completeHandler(mockRunner._messages);
				}

				return undefined;
			}),
			getMessages: vi.fn().mockImplementation(() => mockRunner._messages || []),
			isRunning: vi.fn().mockReturnValue(false),
			stop: vi.fn(),
			on: vi
				.fn()
				.mockImplementation((event: string, handler: (arg: any) => void) => {
					eventHandlers.set(event, handler);
					return mockRunner;
				}),
			emit: vi.fn(),
			_messages: [], // Internal state for test control
		};

		// Regular function (not arrow) so vitest 4 can invoke the mock with `new`;
		// returning an object from a constructor makes `new GeminiRunner()` yield it.
		MockedGeminiRunner.mockImplementation(function () {
			return mockRunner;
		} as unknown as () => GeminiRunner);

		runner = new SimpleGeminiRunner(defaultConfig);
	});

	describe("Configuration Validation", () => {
		it("should create runner with valid configuration", () => {
			expect(runner).toBeInstanceOf(SimpleGeminiRunner);
		});

		it("should throw when validResponses is empty", () => {
			const invalidConfig = {
				...defaultConfig,
				validResponses: [] as const,
			};

			expect(() => new SimpleGeminiRunner(invalidConfig as any)).toThrow(
				"validResponses must be a non-empty array",
			);
		});

		it("should throw when validResponses contains duplicates", () => {
			const invalidConfig = {
				...defaultConfig,
				validResponses: ["approve", "approve"] as const,
			};

			expect(() => new SimpleGeminiRunner(invalidConfig as any)).toThrow(
				"validResponses contains duplicate values",
			);
		});

		it("should throw when mikoHome is not provided", () => {
			const invalidConfig = {
				validResponses: ["approve", "reject"] as const,
				workingDirectory: TEST_WORKING_DIR,
			};

			expect(() => new SimpleGeminiRunner(invalidConfig as any)).toThrow(
				"mikoHome is required",
			);
		});

		it("should accept optional onProgress callback", () => {
			const onProgress = vi.fn();
			const configWithProgress = {
				...defaultConfig,
				onProgress,
			};

			const progressRunner = new SimpleGeminiRunner(configWithProgress);
			expect(progressRunner).toBeInstanceOf(SimpleGeminiRunner);
		});
	});

	describe("executeAgent()", () => {
		it("should call GeminiRunner.start() with prompt", async () => {
			mockRunner._messages = [createAssistantMessage("approve")];

			await runner.query("Should we proceed?");

			expect(mockRunner.start).toHaveBeenCalledWith("Should we proceed?");
		});

		it("should return messages from GeminiRunner", async () => {
			const mockMessages: SDKMessage[] = [
				createUserMessage("Test"),
				createAssistantMessage("approve"),
			];

			mockRunner._messages = mockMessages;

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should handle GeminiRunner errors", async () => {
			mockRunner.start.mockRejectedValue(new Error("Gemini error"));

			await expect(runner.query("Test")).rejects.toThrow("Gemini error");
		});
	});

	describe("extractResponse()", () => {
		it("should extract text from last assistant message", async () => {
			mockRunner._messages = [createAssistantMessage("approve")];

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should extract text from multiple content blocks", async () => {
			const messages: SDKMessage[] = [
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "Analyzing...\napprove" }],
					},
					session_id: "test",
				} as SDKAssistantMessage,
			];

			mockRunner._messages = messages;

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should clean markdown code blocks from response", async () => {
			mockRunner._messages = [
				createAssistantMessage(
					"Here is my response:\n```\nsome code\n```\napprove",
				),
			];

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should clean backticks from response", async () => {
			mockRunner._messages = [createAssistantMessage("`approve`")];

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should handle mixed content with tool use", async () => {
			const messages: SDKMessage[] = [
				{
					type: "assistant",
					message: {
						role: "assistant",
						content: [
							{ type: "tool_use", id: "tool-1", name: "Read", input: {} },
							{ type: "text", text: "approve" },
						],
					},
					session_id: "test",
				} as SDKAssistantMessage,
			];

			mockRunner._messages = messages;

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should trim whitespace from response", async () => {
			mockRunner._messages = [createAssistantMessage("  approve  \n")];

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});
	});

	describe("Response Validation", () => {
		it("should accept valid response", async () => {
			mockRunner._messages = [createAssistantMessage("approve")];

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});

		it("should throw InvalidResponseError for invalid response", async () => {
			mockRunner._messages = [createAssistantMessage("invalid")];

			await expect(runner.query("Test")).rejects.toThrow(
				"Agent returned invalid response",
			);
		});

		it("should throw InvalidResponseError for empty response", async () => {
			mockRunner._messages = [createAssistantMessage("")];

			await expect(runner.query("Test")).rejects.toThrow();
		});

		it("should handle case-sensitive responses", async () => {
			mockRunner._messages = [createAssistantMessage("APPROVE")];

			// Should throw because "APPROVE" !== "approve"
			await expect(runner.query("Test")).rejects.toThrow(
				"Agent returned invalid response",
			);
		});
	});

	describe("isValidResponse()", () => {
		it("should return true for valid response", () => {
			expect(runner.isValidResponse("approve")).toBe(true);
			expect(runner.isValidResponse("reject")).toBe(true);
		});

		it("should return false for invalid response", () => {
			expect(runner.isValidResponse("invalid")).toBe(false);
			expect(runner.isValidResponse("")).toBe(false);
		});

		it("should be case-sensitive", () => {
			expect(runner.isValidResponse("APPROVE")).toBe(false);
			expect(runner.isValidResponse("Approve")).toBe(false);
		});
	});

	describe("System Prompt Building", () => {
		it("should build system prompt with valid responses", async () => {
			mockRunner._messages = [createAssistantMessage("approve")];

			await runner.query("Test");

			// Verify GeminiRunner was constructed with correct config including appended system prompt
			const constructorCall = MockedGeminiRunner.mock.calls[0];
			const config = constructorCall[0];

			expect(config.appendSystemPrompt).toContain("approve");
			expect(config.appendSystemPrompt).toContain("reject");
		});

		it("should include custom system prompt in final prompt", async () => {
			const customConfig = {
				...defaultConfig,
				systemPrompt: "You are a review assistant.",
			};

			const customRunner = new SimpleGeminiRunner(customConfig);
			mockRunner._messages = [createAssistantMessage("approve")];

			await customRunner.query("Test");

			const constructorCall =
				MockedGeminiRunner.mock.calls[MockedGeminiRunner.mock.calls.length - 1];
			const config = constructorCall[0];

			expect(config.appendSystemPrompt).toContain(
				"You are a review assistant.",
			);
			expect(config.appendSystemPrompt).toContain("approve");
			expect(config.appendSystemPrompt).toContain("reject");
		});
	});

	describe("Timeout Handling", () => {
		it("should timeout if agent takes too long", async () => {
			const timeoutConfig = {
				...defaultConfig,
				timeoutMs: 100,
			};

			const timeoutRunner = new SimpleGeminiRunner(timeoutConfig);

			// Mock runner that never completes
			mockRunner.start.mockImplementation(() => new Promise(() => {}));

			await expect(timeoutRunner.query("Test")).rejects.toThrow("timed out");
		}, 10000);

		it("should not timeout if agent completes in time", async () => {
			const timeoutConfig = {
				...defaultConfig,
				timeoutMs: 5000,
			};

			const timeoutRunner = new SimpleGeminiRunner(timeoutConfig);

			mockRunner._messages = [createAssistantMessage("approve")];

			const result = await timeoutRunner.query("Test");

			expect(result.response).toBe("approve");
		});
	});

	describe("Cost Extraction", () => {
		it("should extract cost from result message", async () => {
			const messages: SDKMessage[] = [
				createAssistantMessage("approve"),
				{
					type: "result",
					total_cost_usd: 0.0042,
					session_id: "test",
				} as any,
			];

			mockRunner._messages = messages;

			const result = await runner.query("Test");

			expect(result.costUSD).toBe(0.0042);
		});

		it("should return undefined cost when no result message", async () => {
			mockRunner._messages = [createAssistantMessage("approve")];

			const result = await runner.query("Test");

			expect(result.costUSD).toBeUndefined();
		});

		it("should return undefined cost when result has no cost", async () => {
			const messages: SDKMessage[] = [
				createAssistantMessage("approve"),
				{
					type: "result",
					session_id: "test",
				} as any,
			];

			mockRunner._messages = messages;

			const result = await runner.query("Test");

			expect(result.costUSD).toBeUndefined();
		});
	});

	describe("Progress Callbacks", () => {
		it("should call onProgress callback during execution", async () => {
			const onProgress = vi.fn();
			const progressConfig = {
				...defaultConfig,
				onProgress,
			};

			const progressRunner = new SimpleGeminiRunner(progressConfig);

			mockRunner._messages = [createAssistantMessage("approve")];

			await progressRunner.query("Test");

			// onProgress should have been called at least once
			expect(onProgress).toHaveBeenCalled();
		});

		it("should work without onProgress callback", async () => {
			mockRunner._messages = [createAssistantMessage("approve")];

			const result = await runner.query("Test");

			expect(result.response).toBe("approve");
		});
	});

	describe("Multiple Response Types", () => {
		it("should handle boolean responses", async () => {
			type BooleanResponse = "true" | "false";
			const boolConfig: SimpleAgentRunnerConfig<BooleanResponse> = {
				validResponses: ["true", "false"] as const,
				mikoHome: TEST_MIKO_HOME,
				workingDirectory: TEST_WORKING_DIR,
			};

			const boolRunner = new SimpleGeminiRunner(boolConfig);

			mockRunner._messages = [createAssistantMessage("true")];

			const result = await boolRunner.query("Test");

			expect(result.response).toBe("true");
		});

		it("should handle many response options", async () => {
			type Status =
				| "pending"
				| "approved"
				| "rejected"
				| "needs-info"
				| "escalated";
			const statusConfig: SimpleAgentRunnerConfig<Status> = {
				validResponses: [
					"pending",
					"approved",
					"rejected",
					"needs-info",
					"escalated",
				] as const,
				mikoHome: TEST_MIKO_HOME,
				workingDirectory: TEST_WORKING_DIR,
			};

			const statusRunner = new SimpleGeminiRunner(statusConfig);

			mockRunner._messages = [createAssistantMessage("needs-info")];

			const result = await statusRunner.query("Test");

			expect(result.response).toBe("needs-info");
		});
	});

	describe("Error Recovery", () => {
		it("should cleanup on error", async () => {
			mockRunner.start.mockRejectedValue(new Error("Test error"));

			await expect(runner.query("Test")).rejects.toThrow("Test error");

			// Verify cleanup happened (isRunning should be false)
			expect(mockRunner.isRunning()).toBe(false);
		});

		it("should throw InvalidResponseError for invalid response", async () => {
			mockRunner._messages = [createAssistantMessage("invalid")];

			try {
				await runner.query("Test");
				expect.fail("Should have thrown");
			} catch (error: any) {
				expect(error.name).toBe("InvalidResponseError");
				expect(error.message).toContain("Agent returned invalid response");
			}
		});

		it("should throw SimpleAgentError for timeout", async () => {
			const timeoutConfig = {
				...defaultConfig,
				timeoutMs: 100,
			};

			const timeoutRunner = new SimpleGeminiRunner(timeoutConfig);
			mockRunner.start.mockImplementation(() => new Promise(() => {}));

			try {
				await timeoutRunner.query("Test");
				expect.fail("Should have thrown");
			} catch (error: any) {
				expect(error.name).toBe("SimpleAgentError");
				expect(error.message).toContain("timed out");
			}
		}, 10000);
	});
});

// Helper functions
function createUserMessage(content: string): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content,
		},
		session_id: "test",
	} as any;
}

function createAssistantMessage(text: string): SDKAssistantMessage {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "text",
					text,
				},
			],
		},
		session_id: "test",
	} as SDKAssistantMessage;
}
