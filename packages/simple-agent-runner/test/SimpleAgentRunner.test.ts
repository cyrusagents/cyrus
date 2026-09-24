import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vitest";
import { InvalidResponseError, SimpleAgentError } from "../src/errors.js";
import { SimpleAgentRunner } from "../src/SimpleAgentRunner.js";
import type {
	SimpleAgentQueryOptions,
	SimpleAgentRunnerConfig,
} from "../src/types.js";

// Mock implementation for testing
class MockAgentRunner extends SimpleAgentRunner<"yes" | "no"> {
	private mockMessages: SDKMessage[] = [];
	private mockResponse: string = "yes";

	setMockMessages(messages: SDKMessage[]): void {
		this.mockMessages = messages;
	}

	setMockResponse(response: string): void {
		this.mockResponse = response;
	}

	protected async executeAgent(
		_prompt: string,
		_options?: SimpleAgentQueryOptions,
	): Promise<SDKMessage[]> {
		return Promise.resolve(this.mockMessages);
	}

	protected extractResponse(_messages: SDKMessage[]): string {
		return this.mockResponse;
	}
}

describe("SimpleAgentRunner", () => {
	const validConfig: SimpleAgentRunnerConfig<"yes" | "no"> = {
		validResponses: ["yes", "no"] as const,
		mikoHome: "/test/miko",
	};

	describe("Configuration Validation", () => {
		it("should accept valid configuration", () => {
			expect(() => new MockAgentRunner(validConfig)).not.toThrow();
		});

		it("should reject empty validResponses", () => {
			const config = {
				...validConfig,
				validResponses: [] as const,
			};

			expect(() => new MockAgentRunner(config as any)).toThrow(
				SimpleAgentError,
			);
			expect(() => new MockAgentRunner(config as any)).toThrow(
				/validResponses must be a non-empty array/,
			);
		});

		it("should reject duplicate validResponses", () => {
			const config = {
				...validConfig,
				validResponses: ["yes", "yes", "no"] as const,
			};

			expect(() => new MockAgentRunner(config as any)).toThrow(
				SimpleAgentError,
			);
			expect(() => new MockAgentRunner(config as any)).toThrow(
				/duplicate values/,
			);
		});

		it("should reject missing mikoHome", () => {
			const config = {
				...validConfig,
				mikoHome: "",
			};

			expect(() => new MockAgentRunner(config)).toThrow(SimpleAgentError);
			expect(() => new MockAgentRunner(config)).toThrow(/mikoHome is required/);
		});
	});

	describe("query()", () => {
		it("should return valid response", async () => {
			const runner = new MockAgentRunner(validConfig);
			runner.setMockMessages([
				{
					type: "system",
					session_id: "test-session",
					model: "test",
				} as any,
			]);
			runner.setMockResponse("yes");

			const result = await runner.query("Test prompt");

			expect(result.response).toBe("yes");
			expect(result.sessionId).toBe("test-session");
			expect(result.durationMs).toBeGreaterThanOrEqual(0);
		});

		it("should throw InvalidResponseError for invalid response", async () => {
			const runner = new MockAgentRunner(validConfig);
			runner.setMockMessages([]);
			runner.setMockResponse("maybe");

			await expect(runner.query("Test")).rejects.toThrow(InvalidResponseError);
			await expect(runner.query("Test")).rejects.toThrow(/maybe/);
		});

		it("should handle timeout", async () => {
			const runner = new MockAgentRunner({
				...validConfig,
				timeoutMs: 100,
			});

			// Mock a slow execution
			runner.setMockMessages([]);
			runner.setMockResponse("yes");

			// Override executeAgent to be slow
			(runner as any).executeAgent = async () => {
				await new Promise((resolve) => setTimeout(resolve, 500));
				return [];
			};

			await expect(runner.query("Test")).rejects.toThrow(SimpleAgentError);
			await expect(runner.query("Test")).rejects.toThrow(/timed out/);
		});

		it("should extract cost from result message", async () => {
			const runner = new MockAgentRunner(validConfig);
			runner.setMockMessages([
				{
					type: "system",
					session_id: "test-session",
					model: "test",
				} as any,
				{
					type: "result",
					total_cost_usd: 0.0042,
				} as any,
			]);
			runner.setMockResponse("no");

			const result = await runner.query("Test");

			expect(result.costUSD).toBe(0.0042);
		});
	});

	describe("buildSystemPrompt()", () => {
		it("should include valid responses in prompt", () => {
			const runner = new MockAgentRunner(validConfig);
			const prompt = (runner as any).buildSystemPrompt();

			expect(prompt).toContain('"yes"');
			expect(prompt).toContain('"no"');
			expect(prompt).toContain("EXACTLY one of the following");
		});

		it("should include custom system prompt", () => {
			const runner = new MockAgentRunner({
				...validConfig,
				systemPrompt: "You are a test assistant.",
			});
			const prompt = (runner as any).buildSystemPrompt();

			expect(prompt).toContain("You are a test assistant.");
			expect(prompt).toContain('"yes"');
			expect(prompt).toContain('"no"');
		});
	});

	describe("isValidResponse()", () => {
		it("should return true for valid responses", () => {
			const runner = new MockAgentRunner(validConfig);

			expect((runner as any).isValidResponse("yes")).toBe(true);
			expect((runner as any).isValidResponse("no")).toBe(true);
		});

		it("should return false for invalid responses", () => {
			const runner = new MockAgentRunner(validConfig);

			expect((runner as any).isValidResponse("maybe")).toBe(false);
			expect((runner as any).isValidResponse("")).toBe(false);
			expect((runner as any).isValidResponse("YES")).toBe(false);
		});
	});

	describe("Progress Events", () => {
		it("should allow progress callback to be configured", async () => {
			const events: any[] = [];
			const runner = new MockAgentRunner({
				...validConfig,
				onProgress: (event) => events.push(event),
			});

			runner.setMockMessages([
				{
					type: "system",
					session_id: "test-session",
					model: "test",
				} as any,
			]);
			runner.setMockResponse("yes");

			// Note: MockAgentRunner doesn't emit progress events,
			// but the real SimpleClaudeRunner does
			await expect(runner.query("Test")).resolves.toBeDefined();
		});

		it("should not throw if no progress callback", async () => {
			const runner = new MockAgentRunner(validConfig);
			runner.setMockMessages([]);
			runner.setMockResponse("yes");

			await expect(runner.query("Test")).resolves.toBeDefined();
		});
	});
});
