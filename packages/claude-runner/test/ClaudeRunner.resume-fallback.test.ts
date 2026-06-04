import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Mock file system operations (mirrors ClaudeRunner.test.ts)
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

vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

describe("ClaudeRunner - cross-session resume fallback", () => {
	let mockQuery: any;

	beforeEach(() => {
		vi.clearAllMocks();
		mockQuery = vi.mocked(query);
	});

	it("isResumeFailure() recognizes transcript-not-found errors", () => {
		const runner = new ClaudeRunner({
			workingDirectory: "/tmp/test",
			cyrusHome: "/tmp/test-cyrus-home",
		} as ClaudeRunnerConfig) as any;

		expect(
			runner.isResumeFailure(
				new Error("No conversation found with session ID"),
			),
		).toBe(true);
		expect(runner.isResumeFailure(new Error("could not resume session"))).toBe(
			true,
		);
		expect(runner.isResumeFailure(new Error("rate limit exceeded"))).toBe(
			false,
		);
	});

	it("retries once without resume when resume fails before any message", async () => {
		const runner = new ClaudeRunner({
			workingDirectory: "/tmp/test",
			cyrusHome: "/tmp/test-cyrus-home",
			resumeSessionId: "stale-session-id",
		} as ClaudeRunnerConfig);

		// queryOptions is mutated in place across retries, so capture the resume
		// value at the moment of each call rather than reading mock.calls later.
		const seenResume: Array<string | undefined> = [];

		// First attempt (with resume) throws a transcript-not-found error before
		// yielding anything; second attempt (cold) succeeds.
		mockQuery
			.mockImplementationOnce((qo: any) => {
				// An async-iterable whose first next() rejects — models the SDK
				// failing to locate the prior transcript when resuming.
				seenResume.push(qo.options.resume);
				return {
					[Symbol.asyncIterator]() {
						return {
							next: () =>
								Promise.reject(
									new Error(
										"No conversation found with session ID stale-session-id",
									),
								),
						};
					},
				};
			})
			.mockImplementationOnce(async function* (qo: any) {
				seenResume.push(qo.options.resume);
				yield {
					type: "assistant",
					message: { content: [{ type: "text", text: "Hi" }] },
					parent_tool_use_id: null,
					session_id: "fresh-session-id",
				} as any;
			});

		const info = await runner.start("hello");

		expect(mockQuery).toHaveBeenCalledTimes(2);
		// First call carried the resume id; the retry dropped it (cold start).
		expect(seenResume).toEqual(["stale-session-id", undefined]);
		// The cold run produced the live session.
		expect(info.sessionId).toBe("fresh-session-id");
	});

	it("does not retry when resume is not set", async () => {
		const runner = new ClaudeRunner({
			workingDirectory: "/tmp/test",
			cyrusHome: "/tmp/test-cyrus-home",
		} as ClaudeRunnerConfig);

		const errorEvents: Error[] = [];
		runner.on("error", (e) => errorEvents.push(e));

		mockQuery.mockImplementationOnce(() => ({
			[Symbol.asyncIterator]() {
				return {
					next: () =>
						Promise.reject(new Error("No conversation found with session ID")),
				};
			},
		}));

		await runner.start("hello");

		expect(mockQuery).toHaveBeenCalledTimes(1);
		expect(errorEvents).toHaveLength(1);
	});
});
