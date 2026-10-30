/**
 * Jira remote-agent bridge — regressions for the runtime code review
 * (RUNTIME-CODE-REVIEW R1–R8 and CONTRACT v3).
 *
 * CONTROLLED TESTS: a scripted fake runner (sometimes wrapped in the REAL
 * concurrency gate) stands in for a model. They prove the task service's
 * fencing, persistence and admission rules, not a live model run.
 */
import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	AgentSessionInfo,
	IAgentRunner,
	ILogger,
	RepositoryConfig,
	SDKMessage,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraAgentJournal } from "../src/jira-agent/JiraAgentJournal.js";
import {
	JiraAgentTaskService,
	type JiraSendRequest,
	REPOSITORY_GONE_MESSAGE,
	TOMBSTONE_MESSAGE,
} from "../src/jira-agent/JiraAgentTaskService.js";
import { capRunnerStarts, SessionSemaphore } from "../src/RunnerConcurrency.js";

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => logger,
} as unknown as ILogger;

const CTX = "11111111-1111-4111-8111-111111111111";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const binding = {
	teamId: "33333333-3333-4333-8333-333333333333",
	installationLinkId: "44444444-4444-4444-8444-444444444444",
	accountLinkId: "55555555-5555-4555-8555-555555555555",
	repositoryId: "repo-a",
};
const otherBinding = {
	...binding,
	accountLinkId: "66666666-6666-4666-8666-666666666666",
};
const issue = { id: "10001", key: "QA-1", summary: "S", description: "D" };
const ref = (taskId = TASK_A, b = binding) => ({
	version: 1 as const,
	taskId,
	contextId: CTX,
	binding: b,
});
const create = (over: Partial<JiraSendRequest> = {}): JiraSendRequest => ({
	version: 1,
	kind: "create",
	taskId: TASK_A,
	contextId: CTX,
	messageId: "m1",
	binding,
	issue,
	text: "Do it.",
	...over,
});
const followup = (messageId: string, text = "More.") =>
	create({ kind: "followup", messageId, text });

class FakeRunner implements IAgentRunner {
	readonly supportsStreamingInput: boolean;
	prompts: string[] = [];
	injected: string[] = [];
	stopCalls = 0;
	private open = false;
	private resolveExec: ((v: AgentSessionInfo) => void) | null = null;
	constructor(
		readonly onMessage: (m: SDKMessage) => void,
		readonly streaming: boolean,
		readonly settleOnStop = true,
	) {
		this.supportsStreamingInput = streaming;
	}
	private begin(prompt: string) {
		this.prompts.push(prompt);
		return new Promise<AgentSessionInfo>((resolve) => {
			this.resolveExec = resolve;
		});
	}
	start(prompt: string) {
		return this.begin(prompt);
	}
	startStreaming = (prompt?: string) => {
		this.open = true;
		return this.begin(prompt ?? "");
	};
	addStreamMessage(content: string) {
		this.injected.push(content);
	}
	completeStream() {
		this.open = false;
		this.settle();
	}
	isStreaming() {
		return this.open;
	}
	stop() {
		this.stopCalls++;
		this.open = false;
		if (this.settleOnStop) this.settle();
	}
	settle() {
		const r = this.resolveExec;
		this.resolveExec = null;
		r?.({ sessionId: "sess-1", startedAt: new Date(), isRunning: false });
	}
	isRunning() {
		return this.resolveExec !== null;
	}
	getMessages() {
		return [];
	}
	getFormatter() {
		return {} as never;
	}
	say(text: string) {
		this.onMessage({
			type: "assistant",
			session_id: "sess-1",
			message: { content: [{ type: "text", text }] },
		} as unknown as SDKMessage);
	}
	result(text: string) {
		this.onMessage({
			type: "result",
			subtype: "success",
			result: text,
			session_id: "sess-1",
		} as unknown as SDKMessage);
	}
}

const repo = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/repos/a",
	baseBranch: "main",
	workspaceBaseDir: "/ws",
} as RepositoryConfig;

let home: string;
let runners: FakeRunner[];
let repos: Map<string, RepositoryConfig>;
let runnerType: string;
let streaming: boolean;
let settleOnStop: boolean;
let wrap: (r: FakeRunner) => IAgentRunner;
let journal: JiraAgentJournal;

async function makeService(
	over: Partial<ConstructorParameters<typeof JiraAgentTaskService>[0]> = {},
) {
	journal = new JiraAgentJournal(home, logger);
	await journal.load();
	return new JiraAgentTaskService({
		journal,
		logger,
		getRepository: (id) => repos.get(id),
		resolveRunnerType: () => runnerType,
		createWorkspace: async (_r, target) => ({
			path: join("/ws", target.identifier),
			isGitWorktree: true,
		}),
		buildRunner: async (input) => {
			const runner = new FakeRunner(input.onMessage, streaming, settleOnStop);
			runners.push(runner);
			return { runner: wrap(runner), runnerType: "claude" };
		},
		cancelWaitMs: 200,
		postResultGraceMs: 10_000,
		finalizeAttempts: 2,
		...over,
	});
}

const last = () => runners[runners.length - 1] as FakeRunner;
const started = (n: number) =>
	vi.waitFor(() => {
		expect(runners).toHaveLength(n);
		expect(last().prompts.length).toBeGreaterThan(0);
	});
const contextsDir = () => join(home, "jira-agent", "contexts");
const journalFile = () =>
	JSON.parse(readFileSync(join(contextsDir(), `${CTX}.json`), "utf8"));

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jira-review-"));
	runners = [];
	repos = new Map([["repo-a", repo]]);
	runnerType = "claude";
	streaming = true;
	settleOnStop = true;
	wrap = (r) => r;
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("Claude-only admission (R3/R7)", () => {
	it("refuses a non-Claude runner before admission and persists nothing", async () => {
		runnerType = "codex";
		const svc = await makeService();
		await expect(svc.send(create())).rejects.toMatchObject({
			code: "unsupported_runner",
			status: 400,
		});
		expect(runners).toHaveLength(0);
		expect(() => journalFile()).toThrow();
	});
});

describe("cancel while queued for a concurrency slot (R2, real gate)", () => {
	it("never starts the runner and settles canceled when the slot frees", async () => {
		const semaphore = new SessionSemaphore(1);
		await semaphore.acquire(); // another session holds the only slot
		wrap = (r) => capRunnerStarts(r, semaphore);
		const svc = await makeService();
		await svc.send(create());
		await vi.waitFor(() => expect(runners).toHaveLength(1));
		await vi.waitFor(() => expect(semaphore.waiting).toBe(1));
		const snap = await svc.cancel(ref());
		expect(snap).toMatchObject({ state: "canceled", settled: true });
		semaphore.release();
		await new Promise((r) => setTimeout(r, 20));
		expect(last().prompts).toEqual([]);
		expect(semaphore.active).toBe(0);
	});
});

describe("stop is requested even if persistence fails (R4)", () => {
	it("cancel: stop called, answers journal_error, never claims canceled", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		const runner = last();
		const save = vi.spyOn(journal, "save");
		save.mockRejectedValue(new Error("disk full"));
		await expect(svc.cancel(ref())).rejects.toMatchObject({
			code: "journal_error",
			status: 500,
		});
		expect(runner.stopCalls).toBe(1);
		const snap = await svc.get(ref());
		expect(snap.state).not.toBe("canceled");
		expect(snap.settled).toBe(false);
		expect(journalFile().tasks[0].settled).toBe(false);
		// Storage recovers: the fenced execution finalizes as canceled.
		save.mockRestore();
		await expect(svc.cancel(ref())).resolves.toMatchObject({
			state: "canceled",
			settled: true,
		});
	});

	it("deadline: stop called even when its write fails; never falsely complete", async () => {
		settleOnStop = false; // the execution does not end on stop
		const svc = await makeService({ deadlineMs: 300 });
		await svc.send(create());
		await started(1);
		const save = vi.spyOn(journal, "save");
		save.mockRejectedValue(new Error("disk full"));
		await vi.waitFor(() => expect(last().stopCalls).toBe(1), { timeout: 2000 });
		const snap = await svc.get(ref());
		expect(snap.state).toBe("working");
		expect(snap.settled).toBe(false);
		// Late output after the fence changes nothing.
		last().result("late");
		last().settle();
		await vi.waitFor(() => expect(svc.liveCount()).toBe(0));
		expect((await svc.get(ref())).settled).toBe(false);
		save.mockRestore();
	});
});

describe("unreadable journal (R5)", () => {
	for (const [name, content] of [
		["corrupt JSON", "{not json"],
		["wrong shape", JSON.stringify({ version: 1, contextId: CTX, tasks: 3 })],
	] as const) {
		it(`quarantines a context with ${name}; nothing runs`, async () => {
			mkdirSync(contextsDir(), { recursive: true });
			writeFileSync(join(contextsDir(), `${CTX}.json`), content);
			const svc = await makeService();
			for (const op of [
				() => svc.send(create()),
				() => svc.get(ref()),
				() => svc.cancel(ref()),
			]) {
				await expect(op()).rejects.toMatchObject({
					code: "context_unavailable",
					status: 503,
				});
			}
			expect(runners).toHaveLength(0);
			expect(readFileSync(join(contextsDir(), `${CTX}.json`), "utf8")).toBe(
				content,
			);
		});
	}
});

describe("pre-admission cancel tombstone", () => {
	it("a delayed create after cancel never starts, across a restart", async () => {
		const svc = await makeService();
		await expect(svc.cancel(ref())).resolves.toMatchObject({
			state: "canceled",
			settled: true,
			admitted: false,
			error: TOMBSTONE_MESSAGE,
		});
		const svc2 = await makeService(); // reload from disk
		await expect(svc2.send(create())).rejects.toMatchObject({
			code: "task_canceled",
			status: 409,
		});
		await expect(svc2.send(followup("m2"))).rejects.toMatchObject({
			code: "task_canceled",
		});
		expect(runners).toHaveLength(0);
		// The tombstone does not block other work in the context.
		await svc2.send(create({ taskId: TASK_B, messageId: "m3" }));
		await started(1);
	});

	it("a tombstone for an existing context must match its binding", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		await expect(svc.cancel(ref(TASK_B, otherBinding))).rejects.toMatchObject({
			code: "context_mismatch",
		});
	});
});

describe("commit before publish (R8)", () => {
	it("a follow-up whose write fails is refused and never delivered", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		const save = vi.spyOn(journal, "save");
		save.mockRejectedValueOnce(new Error("disk full"));
		await expect(svc.send(followup("m2"))).rejects.toMatchObject({
			code: "journal_error",
		});
		expect((await svc.get(ref())).pendingFollowups).toBe(0);
		last().result("done");
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).state).toBe("completed"),
		);
		expect(last().injected).toEqual([]);
		expect(runners).toHaveLength(1);
	});

	it("get never shows a terminal state before it is durable", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		let release!: () => void;
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const original = journal.save.bind(journal);
		vi.spyOn(journal, "save").mockImplementation(async (record) => {
			if (record.tasks[0]?.state === "completed") await gate;
			return original(record);
		});
		last().result("all done");
		await new Promise((r) => setTimeout(r, 20));
		const during = await svc.get(ref());
		expect(during.state).toBe("working");
		expect(during.result).toBeNull();
		release();
		await vi.waitFor(async () =>
			expect(await svc.get(ref())).toMatchObject({
				state: "completed",
				result: "all done",
			}),
		);
	});

	it("an unpersistable terminal state stays unsettled and keeps the context reserved", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		const save = vi.spyOn(journal, "save");
		save.mockImplementation(async (record) => {
			if (record.tasks[0]?.settled) throw new Error("disk full");
		});
		last().result("done");
		await vi.waitFor(() => expect(svc.liveCount()).toBe(0));
		expect(await svc.get(ref())).toMatchObject({
			state: "working",
			settled: false,
		});
		await expect(
			svc.send(create({ taskId: TASK_B, messageId: "m9" })),
		).rejects.toMatchObject({ code: "context_busy" });
		save.mockRestore();
		await expect(svc.cancel(ref())).resolves.toMatchObject({
			state: "canceled",
			settled: true,
		});
	});
});

describe("bound repository revalidated before every runner start", () => {
	it("a repository removed between turns fails the task instead of running", async () => {
		streaming = false;
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		await svc.send(followup("m2"));
		repos.delete("repo-a");
		last().result("turn 1");
		last().settle();
		await vi.waitFor(async () =>
			expect(await svc.get(ref())).toMatchObject({
				state: "failed",
				settled: true,
				error: REPOSITORY_GONE_MESSAGE,
			}),
		);
		expect(runners).toHaveLength(1);
	});
});

describe("retired tasks keep their idempotency", () => {
	it("replaying a long-evicted create never re-executes", async () => {
		const svc = await makeService();
		const ids: string[] = [];
		for (let i = 0; i < 52; i++) {
			const taskId = `aaaaaaaa-aaaa-4aaa-8aaa-${i.toString(16).padStart(12, "0")}`;
			ids.push(taskId);
			await svc.send(create({ taskId, messageId: `m${i}` }));
			await started(i + 1);
			last().result(`r${i}`);
			await vi.waitFor(async () =>
				expect((await svc.get(ref(taskId))).settled).toBe(true),
			);
		}
		expect(journalFile().tasks.length).toBe(50);
		expect(Object.keys(journalFile().retired)).toContain(ids[0]);
		const before = runners.length;
		await expect(
			svc.send(create({ taskId: ids[0], messageId: "m0" })),
		).rejects.toMatchObject({ code: "task_terminal" });
		await expect(
			svc.send(create({ taskId: ids[0], messageId: "other" })),
		).rejects.toMatchObject({ code: "conflict" });
		expect(runners.length).toBe(before);
	}, 30_000);
});
