// Regressions for RUNTIME-CODE-REVIEW-2 (R9–R11) at the exact boundaries of
// the review's deterministic probes. Controlled fake runners only; the
// concurrency gate is the real SessionSemaphore/capRunnerStarts.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { JiraAgentJournal } from "../src/jira-agent/JiraAgentJournal.js";
import {
	JiraAgentTaskService,
	NO_RESULT_MESSAGE,
	UNDELIVERED_FOLLOWUP_MESSAGE,
} from "../src/jira-agent/JiraAgentTaskService.js";
import { capRunnerStarts, SessionSemaphore } from "../src/RunnerConcurrency.js";
import { standardJiraRouting } from "./jira-routing-fixture.js";

const logger: any = {
	debug() {},
	info() {},
	warn() {},
	error() {},
	withContext() {
		return this;
	},
};
const contextId = "11111111-1111-4111-8111-111111111111";
const taskId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const binding = {
	teamId: "t",
	installationLinkId: "i",
	accountLinkId: "a",
};
const request: any = {
	version: 2,
	kind: "create",
	taskId,
	contextId,
	binding,
	messageId: "m1",
	issue: {
		id: "1",
		key: "QA-1",
		summary: "test",
		description: "",
		labels: [],
		projectKey: "QA",
	},
	repositoryIds: ["repo"],
	text: "initial",
};
const ref: any = { version: 2, taskId, contextId, binding };
const repo: any = {
	id: "repo",
	name: "repo",
	repositoryPath: "/fixture",
	workspaceBaseDir: "/fixture-ws",
	baseBranch: "main",
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor(test: () => boolean | Promise<boolean>) {
	for (let n = 0; n < 400; n++) {
		if (await test()) return;
		await delay(5);
	}
	throw new Error("timeout");
}
const homes: string[] = [];
afterEach(() => {
	for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});
async function setup(buildRunner: any, getRepository: any = () => repo) {
	const home = mkdtempSync(join(tmpdir(), "jira-review2-"));
	homes.push(home);
	const journal = new JiraAgentJournal(home, logger);
	await journal.load();
	const service = new JiraAgentTaskService({
		journal,
		logger,
		getRepository,
		...standardJiraRouting(() => [repo]),
		resolveRunnerType: () => "claude",
		createWorkspace: async () =>
			({ path: "/fixture-ws/context", isGitWorktree: true }) as any,
		buildRunner,
		postResultGraceMs: 100,
		finalizeAttempts: 2,
	});
	return { journal, service };
}
const base = {
	stop() {},
	isRunning() {
		return false;
	},
	getMessages() {
		return [];
	},
	getFormatter() {
		return {};
	},
};

describe("R9: no completion without an actual final result", () => {
	it("onError then resolved start (ClaudeRunner's contract) fails the task", async () => {
		const { service } = await setup(async (input: any) => ({
			runnerType: "claude",
			runner: {
				...base,
				supportsStreamingInput: false,
				async start() {
					input.onError(new Error("controlled SDK authentication failure"));
					return { sessionId: null, startedAt: new Date(), isRunning: false };
				},
			},
		}));
		await service.send(request);
		await waitFor(() => service.liveCount() === 0);
		const snap = await service.get(ref);
		expect(snap.state).toBe("failed");
		expect(snap.result).toBeNull();
		expect(snap.error).toContain("controlled SDK authentication failure");
	});

	it("a run that resolves without any result fails", async () => {
		const { service } = await setup(async () => ({
			runnerType: "claude",
			runner: {
				...base,
				supportsStreamingInput: false,
				async start() {
					return { sessionId: "s", startedAt: new Date(), isRunning: false };
				},
			},
		}));
		await service.send(request);
		await waitFor(() => service.liveCount() === 0);
		const snap = await service.get(ref);
		expect(snap.state).toBe("failed");
		expect(snap.error).toBe(NO_RESULT_MESSAGE);
	});

	it("an error in a follow-up turn never returns the earlier turn's result", async () => {
		let turn = 0;
		let release: () => void = () => {};
		const { service } = await setup(async (input: any) => ({
			runnerType: "claude",
			runner: {
				...base,
				supportsStreamingInput: false,
				async start() {
					turn++;
					if (turn === 1) {
						await new Promise<void>((r) => {
							release = r;
						});
						input.onMessage({
							type: "result",
							subtype: "success",
							result: "turn one answer",
							session_id: "s",
						});
					} else {
						input.onError(new Error("follow-up turn crashed"));
					}
					return { sessionId: "s", startedAt: new Date(), isRunning: false };
				},
			},
		}));
		await service.send(request);
		await waitFor(() => turn === 1);
		await service.send({
			...request,
			kind: "followup",
			messageId: "m2",
			text: "more",
		});
		release();
		await waitFor(() => service.liveCount() === 0);
		const snap = await service.get(ref);
		expect(turn).toBe(2);
		expect(snap.state).toBe("failed");
		expect(snap.result).toBeNull();
		expect(snap.error).toContain("follow-up turn crashed");
	});
});

describe("R10: failed injection plus failed requeue save", () => {
	it("fails the task explicitly; a duplicate of the follow-up never sees a false completion", async () => {
		let input: any;
		let resolveExecution: any;
		let started = false;
		let injections = 0;
		const { journal, service } = await setup(async (buildInput: any) => {
			input = buildInput;
			return {
				runnerType: "claude",
				runner: {
					...base,
					supportsStreamingInput: true,
					start() {
						throw new Error("unexpected non-stream start");
					},
					startStreaming() {
						started = true;
						return new Promise((r) => {
							resolveExecution = r;
						});
					},
					isStreaming() {
						return true;
					},
					addStreamMessage() {
						injections++;
						throw new Error("controlled stream closed");
					},
					completeStream() {
						resolveExecution?.({
							sessionId: "sess",
							startedAt: new Date(),
							isRunning: false,
						});
					},
					isRunning() {
						return started;
					},
				},
			};
		});
		await service.send(request);
		await waitFor(() => started);
		await service.send({
			...request,
			kind: "followup",
			messageId: "m2",
			text: "accepted followup",
		});
		const save = journal.save.bind(journal);
		let failRollback = true;
		journal.save = async (record) => {
			// The dequeue commit (0 pending) succeeds; only the requeue (1 pending) fails.
			if (failRollback && record.tasks[0]!.pendingFollowups.length === 1) {
				failRollback = false;
				throw new Error("controlled rollback I/O failure");
			}
			await save(record);
		};
		input.onMessage({
			type: "result",
			subtype: "success",
			result: "initial answer",
			session_id: "sess",
		});
		await waitFor(() => service.liveCount() === 0);
		const snap = await service.get(ref);
		expect(injections).toBe(1);
		expect(snap.state).toBe("failed");
		expect(snap.result).toBeNull();
		expect(snap.error).toBe(UNDELIVERED_FOLLOWUP_MESSAGE);
		const retry = await service
			.send({
				...request,
				kind: "followup",
				messageId: "m2",
				text: "accepted followup",
			})
			.catch((e) => e);
		expect((retry as any).state).not.toBe("completed");
	});
});

describe("R11: repository removed while queued for a slot", () => {
	it("never starts the runner after the slot opens (real semaphore)", async () => {
		const slots = new SessionSemaphore(1);
		await slots.acquire();
		let configured = true;
		let starts = 0;
		const { service } = await setup(
			async (input: any) => ({
				runnerType: "claude",
				runner: capRunnerStarts(
					{
						...base,
						supportsStreamingInput: false,
						async start() {
							starts++;
							input.onMessage({
								type: "result",
								subtype: "success",
								result: "ran after removal",
								session_id: "s",
							});
							return {
								sessionId: "s",
								startedAt: new Date(),
								isRunning: false,
							};
						},
					} as any,
					slots,
				),
			}),
			() => (configured ? repo : undefined),
		);
		await service.send(request);
		await waitFor(() => slots.waiting === 1);
		configured = false;
		slots.release();
		await waitFor(() => service.liveCount() === 0);
		const snap = await service.get(ref);
		expect(starts).toBe(0);
		expect(snap.state).toBe("failed");
		expect(snap.error).toMatch(/repository/i);
	});

	it("does not inject a streaming follow-up after the repository is removed", async () => {
		let input: any;
		let resolveExecution: any;
		let started = false;
		let configured = true;
		let injections = 0;
		const { service } = await setup(
			async (buildInput: any) => {
				input = buildInput;
				return {
					runnerType: "claude",
					runner: {
						...base,
						supportsStreamingInput: true,
						start() {
							throw new Error("unexpected");
						},
						startStreaming() {
							started = true;
							return new Promise((r) => {
								resolveExecution = r;
							});
						},
						isStreaming() {
							return true;
						},
						addStreamMessage() {
							injections++;
						},
						completeStream() {
							resolveExecution?.({
								sessionId: "s",
								startedAt: new Date(),
								isRunning: false,
							});
						},
					},
				};
			},
			() => (configured ? repo : undefined),
		);
		await service.send(request);
		await waitFor(() => started);
		await service.send({
			...request,
			kind: "followup",
			messageId: "m2",
			text: "next",
		});
		configured = false;
		input.onMessage({
			type: "result",
			subtype: "success",
			result: "first",
			session_id: "s",
		});
		await waitFor(() => service.liveCount() === 0);
		const snap = await service.get(ref);
		expect(injections).toBe(0);
		expect(snap.state).toBe("failed");
		expect(snap.error).toMatch(/repository/i);
	});
});

describe("ownership records for restart cleanup", () => {
	it("persists the runtime's own worktree processes and exposes them after a restart", async () => {
		const home = mkdtempSync(join(tmpdir(), "jira-owned-"));
		homes.push(home);
		const journal = new JiraAgentJournal(home, logger);
		await journal.load();
		let release: () => void = () => {};
		let input: any;
		const service = new JiraAgentTaskService({
			journal,
			logger,
			getRepository: () => repo,
			...standardJiraRouting(() => [repo]),
			resolveRunnerType: () => "claude",
			createWorkspace: async () =>
				({ path: "/fixture-ws/context", isGitWorktree: true }) as any,
			captureOwnedProcesses: async (path) =>
				path === "/fixture-ws/context"
					? [{ pid: 4242, started: "Fri Oct 30 10:00:00 2026" }]
					: [],
			buildRunner: async (b: any) => {
				input = b;
				return {
					runnerType: "claude",
					runner: {
						...base,
						supportsStreamingInput: false,
						async start() {
							input.onMessage({
								type: "assistant",
								message: { content: [{ type: "text", text: "working" }] },
								session_id: "s",
							});
							await new Promise<void>((r) => {
								release = r;
							});
							return {
								sessionId: "s",
								startedAt: new Date(),
								isRunning: false,
							};
						},
					},
				};
			},
		});
		await service.send(request);
		await waitFor(
			() => (journal.getContext(contextId)?.ownedProcesses.length ?? 0) > 0,
		);
		// Simulate an abrupt exit: a fresh journal loads the same home.
		const restarted = new JiraAgentJournal(home, logger);
		await restarted.load();
		expect(restarted.closedWithOwnedProcesses()).toEqual([
			{
				workspacePath: "/fixture-ws/context",
				processes: [{ pid: 4242, started: "Fri Oct 30 10:00:00 2026" }],
			},
		]);
		release();
		await waitFor(() => service.liveCount() === 0);
	});
});
