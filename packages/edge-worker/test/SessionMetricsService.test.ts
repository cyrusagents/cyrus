import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionMetricsRecord } from "../src/SessionMetricsService";
import { SessionMetricsService } from "../src/SessionMetricsService";

// Use a temp directory so tests are isolated from each other
const TEST_DIR = join(tmpdir(), `session-metrics-test-${Date.now()}`);

async function readRecords(): Promise<SessionMetricsRecord[]> {
	const content = await readFile(
		join(TEST_DIR, "session-metrics.jsonl"),
		"utf-8",
	);
	return content
		.trim()
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as SessionMetricsRecord);
}

describe("SessionMetricsService", () => {
	let service: SessionMetricsService;

	beforeEach(() => {
		service = new SessionMetricsService(TEST_DIR);
	});

	afterEach(async () => {
		await rm(TEST_DIR, { recursive: true, force: true });
	});

	it("appends a JSON line on record()", async () => {
		const session = {
			id: "session-1",
			createdAt: Date.now() - 30_000,
			issueContext: {
				issueId: "issue-1",
				issueIdentifier: "BRI-100",
				trackerId: "linear",
			},
			repositories: [{ repositoryId: "repo-abc", baseBranchName: "main" }],
			workspace: { path: "/tmp/workspace", isGitWorktree: false },
			metadata: { model: "claude-sonnet-4-6" },
		} as any;

		const resultMessage = {
			subtype: "success",
			result: "All done. PR: https://github.com/Org/repo/pull/42",
			total_cost_usd: 0.05,
			usage: { input_tokens: 100, output_tokens: 200 },
		} as any;

		service.notifySessionStart("session-1", "my-repo");
		await service.record(session, resultMessage, []);

		const records = await readRecords();
		expect(records).toHaveLength(1);

		const rec = records[0]!;
		expect(rec.sessionId).toBe("session-1");
		expect(rec.issueIdentifier).toBe("BRI-100");
		expect(rec.repo).toBe("my-repo");
		expect(rec.model).toBe("claude-sonnet-4-6");
		expect(rec.outcome).toBe("success");
		expect(rec.prUrl).toBe("https://github.com/Org/repo/pull/42");
		expect(rec.completionCommentPosted).toBe(true);
		expect(rec.totalCostUsd).toBe(0.05);
		expect(rec.durationSeconds).toBeGreaterThanOrEqual(29);
	});

	it("maps subtype error_max_turns to outcome timeout", async () => {
		const session = {
			id: "session-2",
			createdAt: Date.now(),
			issueContext: {
				issueId: "i2",
				issueIdentifier: "BRI-200",
				trackerId: "linear",
			},
			repositories: [],
			workspace: { path: "/tmp/ws2", isGitWorktree: false },
		} as any;

		const resultMessage = {
			subtype: "error_max_turns",
			total_cost_usd: 0,
			usage: null,
		} as any;

		await service.record(session, resultMessage, []);

		const records = await readRecords();
		expect(records[0]!.outcome).toBe("timeout");
		expect(records[0]!.completionCommentPosted).toBe(false);
	});

	it("does not record the same session twice (idempotent on duplicate calls)", async () => {
		const session = {
			id: "session-dup",
			createdAt: Date.now(),
			issueContext: {
				issueId: "i3",
				issueIdentifier: "BRI-300",
				trackerId: "linear",
			},
			repositories: [],
			workspace: { path: "/tmp/ws3", isGitWorktree: false },
		} as any;

		const resultMessage = {
			subtype: "success",
			total_cost_usd: 0,
			usage: null,
		} as any;

		await service.record(session, resultMessage, []);
		await service.record(session, resultMessage, []);

		const records = await readRecords();
		expect(records).toHaveLength(1);
	});

	it("extracts PR URL from session entries when not in result text", async () => {
		const session = {
			id: "session-pr",
			createdAt: Date.now(),
			issueContext: {
				issueId: "i4",
				issueIdentifier: "BRI-400",
				trackerId: "linear",
			},
			repositories: [],
			workspace: { path: "/tmp/ws4", isGitWorktree: false },
		} as any;

		const resultMessage = {
			subtype: "success",
			result: "All done",
			total_cost_usd: 0,
			usage: null,
		} as any;

		const entries = [
			{
				type: "assistant",
				content: "Created PR at https://github.com/Org/repo/pull/99",
			},
		] as any;

		await service.record(session, resultMessage, entries);

		const records = await readRecords();
		expect(records[0]!.prUrl).toBe("https://github.com/Org/repo/pull/99");
	});

	it("falls back to repositoryId when notifySessionStart was not called", async () => {
		const session = {
			id: "session-norepo",
			createdAt: Date.now(),
			issueContext: {
				issueId: "i5",
				issueIdentifier: "BRI-500",
				trackerId: "linear",
			},
			repositories: [
				{ repositoryId: "fallback-repo-id", baseBranchName: "main" },
			],
			workspace: { path: "/tmp/ws5", isGitWorktree: false },
		} as any;

		const resultMessage = {
			subtype: "success",
			total_cost_usd: 0,
			usage: null,
		} as any;

		await service.record(session, resultMessage, []);

		const records = await readRecords();
		expect(records[0]!.repo).toBe("fallback-repo-id");
	});

	describe("summarize()", () => {
		it("returns a readable summary after multiple sessions", async () => {
			const makeRecord = (
				id: string,
				repo: string,
				outcome: "success" | "error" | "timeout",
				durationSeconds: number,
				prUrl: string | null = null,
			): SessionMetricsRecord => ({
				sessionId: id,
				issueId: `issue-${id}`,
				issueIdentifier: `BRI-${id}`,
				repo,
				model: "sonnet",
				workflow: "full-development",
				startedAt: new Date().toISOString(),
				endedAt: new Date().toISOString(),
				durationSeconds,
				filesChanged: 3,
				prUrl,
				outcome,
				completionCommentPosted: outcome === "success",
				tokenUsage: null,
				totalCostUsd: 0.02,
			});

			// Write records directly to the file
			const metricsPath = join(TEST_DIR, "session-metrics.jsonl");
			const { appendFile, mkdir } = await import("node:fs/promises");
			await mkdir(TEST_DIR, { recursive: true });
			const records = [
				makeRecord(
					"1",
					"cyrus-agent",
					"success",
					120,
					"https://github.com/Org/repo/pull/1",
				),
				makeRecord("2", "cyrus-agent", "error", 45),
				makeRecord("3", "another-repo", "success", 200),
			];
			for (const r of records) {
				await appendFile(metricsPath, `${JSON.stringify(r)}\n`, "utf-8");
			}

			const summary = await SessionMetricsService.summarize(TEST_DIR);

			expect(summary).toContain("Total sessions:   3");
			expect(summary).toContain("Success:");
			expect(summary).toContain("cyrus-agent");
			expect(summary).toContain("another-repo");
			expect(summary).toContain("PRs created:");
		});

		it("returns no-metrics message when file does not exist", async () => {
			const summary = await SessionMetricsService.summarize(TEST_DIR);
			expect(summary).toContain("No metrics found");
		});
	});
});
