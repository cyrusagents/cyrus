/**
 * Jira remote-agent task bridge (runtime side).
 *
 * CONTROLLED TESTS: the runner here is a scripted fake whose execution
 * promise, results and stop behaviour are driven by the test. They prove the
 * task service's idempotency, single-writer, cancellation, deadline and
 * restart contracts — NOT that a real model run works.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	IAgentRunner,
	ILogger,
	RepositoryConfig,
	SDKMessage,
} from "cyrus-core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	JiraAgentJournal,
	RESTART_MESSAGE,
} from "../src/jira-agent/JiraAgentJournal.js";
import {
	registerJiraAgentRoutes,
	registerUnavailableJiraAgentRoutes,
} from "../src/jira-agent/JiraAgentRoutes.js";
import {
	CANCELED_MESSAGE,
	DEADLINE_MESSAGE,
	JIRA_SCRUBBED_ENV,
	JiraAgentTaskService,
	type JiraRunnerBuildInput,
	type JiraSendRequest,
	scopeJiraAllowedTools,
} from "../src/jira-agent/JiraAgentTaskService.js";

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => logger,
} as unknown as ILogger;

const CTX = "11111111-1111-4111-8111-111111111111";
const CTX2 = "22222222-2222-4222-8222-222222222222";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const binding = {
	teamId: "33333333-3333-4333-8333-333333333333",
	installationLinkId: "44444444-4444-4444-8444-444444444444",
	accountLinkId: "55555555-5555-4555-8555-555555555555",
	repositoryId: "repo-a",
};
const issue = {
	id: "10001",
	key: "QA-1",
	summary: "Fix the fixture",
	description: "Use only the fixture repository.",
};

function create(over: Partial<JiraSendRequest> = {}): JiraSendRequest {
	return {
		version: 1,
		kind: "create",
		taskId: TASK_A,
		contextId: CTX,
		messageId: "msg-1",
		binding,
		issue,
		text: "Investigate the assigned issue.",
		...over,
	};
}

/** Scripted runner. Execution settles only when the test (or stop) says so. */
class FakeRunner implements IAgentRunner {
	readonly supportsStreamingInput: boolean;
	prompts: string[] = [];
	injected: string[] = [];
	stopCalls = 0;
	completeCalls = 0;
	private streamOpen = false;
	private running = false;
	private resolveExec: ((v: any) => void) | null = null;
	private rejectExec: ((e: Error) => void) | null = null;

	constructor(
		readonly onMessage: (m: SDKMessage) => void,
		readonly opts: {
			streaming: boolean;
			settleOnStop: boolean;
			settleOnComplete: boolean;
			sessionId: string;
		},
	) {
		this.supportsStreamingInput = opts.streaming;
	}
	private begin(prompt: string) {
		this.prompts.push(prompt);
		this.running = true;
		return new Promise<any>((resolve, reject) => {
			this.resolveExec = resolve;
			this.rejectExec = reject;
		});
	}
	start(prompt: string) {
		return this.begin(prompt);
	}
	startStreaming = (prompt?: string) => {
		this.streamOpen = true;
		return this.begin(prompt ?? "");
	};
	addStreamMessage(content: string) {
		this.injected.push(content);
	}
	completeStream() {
		this.completeCalls++;
		this.streamOpen = false;
		if (this.opts.settleOnComplete) this.settle();
	}
	isStreaming() {
		return this.streamOpen;
	}
	stop() {
		this.stopCalls++;
		this.streamOpen = false;
		if (this.opts.settleOnStop) this.settle();
	}
	settle() {
		if (!this.resolveExec) return;
		this.running = false;
		const r = this.resolveExec;
		this.resolveExec = null;
		r({
			sessionId: this.opts.sessionId,
			startedAt: new Date(),
			isRunning: false,
		});
	}
	fail(message: string) {
		this.running = false;
		this.rejectExec?.(new Error(message));
		this.resolveExec = null;
	}
	isRunning() {
		return this.running;
	}
	getMessages() {
		return [];
	}
	getFormatter() {
		return {} as any;
	}
	say(text: string) {
		this.onMessage({
			type: "assistant",
			session_id: this.opts.sessionId,
			message: { content: [{ type: "text", text }] },
		} as unknown as SDKMessage);
	}
	result(text: string, isError = false) {
		this.onMessage({
			type: "result",
			subtype: isError ? "error_during_execution" : "success",
			is_error: isError,
			result: text,
			session_id: this.opts.sessionId,
		} as unknown as SDKMessage);
	}
}

let home: string;
let runners: FakeRunner[];
let builds: JiraRunnerBuildInput[];
let runnerOpts: ConstructorParameters<typeof FakeRunner>[1];
let workspaceIsGit: boolean;
let repos: Map<string, RepositoryConfig>;

const repo = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/repos/a",
	baseBranch: "main",
	workspaceBaseDir: "/ws",
} as RepositoryConfig;

async function makeService(
	over: Partial<ConstructorParameters<typeof JiraAgentTaskService>[0]> = {},
) {
	const journal = new JiraAgentJournal(home, logger);
	await journal.load();
	return new JiraAgentTaskService({
		journal,
		logger,
		getRepository: (id) => repos.get(id),
		createWorkspace: async (_repo, target) => ({
			path: join("/ws", target.identifier),
			isGitWorktree: workspaceIsGit,
		}),
		buildRunner: async (input) => {
			builds.push(input);
			const runner = new FakeRunner(input.onMessage, runnerOpts);
			runners.push(runner);
			return { runner, runnerType: "claude" };
		},
		cancelWaitMs: 50,
		postResultGraceMs: 10_000,
		...over,
	});
}

const lastRunner = () => runners[runners.length - 1] as FakeRunner;
/** Wait until `n` runners exist and the latest has actually been started. */
const started = (n: number) =>
	vi.waitFor(() => {
		expect(runners).toHaveLength(n);
		expect(lastRunner().prompts.length).toBeGreaterThan(0);
	});
const journalFile = (ctx = CTX) =>
	JSON.parse(
		readFileSync(join(home, "jira-agent", "contexts", `${ctx}.json`), "utf8"),
	);

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jira-agent-test-"));
	runners = [];
	builds = [];
	workspaceIsGit = true;
	repos = new Map([["repo-a", repo]]);
	runnerOpts = {
		streaming: true,
		settleOnStop: true,
		settleOnComplete: true,
		sessionId: "sess-1",
	};
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("create, progress and completion", () => {
	it("runs in an isolated worktree and completes only after settlement", async () => {
		const svc = await makeService();
		const snap = await svc.send(create());
		expect(snap.state).toBe("submitted");
		expect(snap.settled).toBe(false);
		await started(1);
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.state,
			).toBe("working"),
		);
		const input = builds[0] as JiraRunnerBuildInput;
		expect(input.workspace.path).toBe("/ws/jira-111111111111");
		expect(input.resume).toBeNull();
		expect(input.systemPrompt).toContain("cyrus/jira-qa-1-11111111");
		expect(lastRunner().prompts[0]).toContain(
			"<summary>Fix the fixture</summary>",
		);
		expect(lastRunner().prompts[0]).toContain(
			"Investigate the assigned issue.",
		);

		lastRunner().say("Looking at the fixture.");
		lastRunner().result("Done: fixed it.");
		await vi.waitFor(async () => {
			const s = await svc.get({
				version: 1,
				taskId: TASK_A,
				contextId: CTX,
				binding,
			});
			expect(s.state).toBe("completed");
		});
		const s = await svc.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.settled).toBe(true);
		expect(s.result).toBe("Done: fixed it.");
		expect(s.progress.map((p) => p.text)).toEqual(["Looking at the fixture."]);
		const file = journalFile();
		expect(file.tasks[0].state).toBe("completed");
		expect(file.runnerSessionId).toBe("sess-1");
		expect(svc.liveCount()).toBe(0);
	});

	it("reports a runner error result as failed", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		lastRunner().result("boom", true);
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.state,
			).toBe("failed"),
		);
	});

	it("fails honestly when execution throws without a result", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		lastRunner().fail("process exited");
		await vi.waitFor(async () => {
			const s = await svc.get({
				version: 1,
				taskId: TASK_A,
				contextId: CTX,
				binding,
			});
			expect(s.state).toBe("failed");
			expect(s.error).toBe("process exited");
		});
	});

	it("refuses a workspace that is not a git worktree", async () => {
		workspaceIsGit = false;
		const svc = await makeService();
		await svc.send(create());
		await vi.waitFor(async () => {
			const s = await svc.get({
				version: 1,
				taskId: TASK_A,
				contextId: CTX,
				binding,
			});
			expect(s.state).toBe("failed");
		});
		expect(runners).toHaveLength(0);
	});

	it("rejects an unknown repository without persisting anything", async () => {
		const svc = await makeService();
		await expect(
			svc.send(create({ binding: { ...binding, repositoryId: "nope" } })),
		).rejects.toMatchObject({ code: "unknown_repository" });
		expect(readdirSync(join(home, "jira-agent", "contexts"))).toEqual([]);
	});
});

describe("idempotency and single writer", () => {
	it("same create is idempotent; a different body is a conflict", async () => {
		const svc = await makeService();
		await svc.send(create());
		const again = await svc.send(create());
		expect(again.taskId).toBe(TASK_A);
		await started(1);
		await expect(
			svc.send(create({ text: "something else" })),
		).rejects.toMatchObject({
			code: "conflict",
		});
		expect(builds).toHaveLength(1);
	});

	it("concurrent identical creates admit exactly one execution", async () => {
		const svc = await makeService();
		const results = await Promise.allSettled([
			svc.send(create()),
			svc.send(create()),
			svc.send(create()),
		]);
		expect(results.every((r) => r.status === "fulfilled")).toBe(true);
		await started(1);
		await new Promise((r) => setTimeout(r, 20));
		expect(builds).toHaveLength(1);
	});

	it("a different task id in a busy context is context_busy", async () => {
		const svc = await makeService();
		await svc.send(create());
		await expect(
			svc.send(create({ taskId: TASK_B, messageId: "msg-2" })),
		).rejects.toMatchObject({ code: "context_busy" });
	});

	it("a later task in a settled context resumes the context session", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		lastRunner().result("first");
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.state,
			).toBe("completed"),
		);
		await svc.send(
			create({ taskId: TASK_B, messageId: "msg-2", text: "Now add a test." }),
		);
		await started(2);
		expect(builds[1]?.resume).toEqual({
			runnerType: "claude",
			sessionId: "sess-1",
		});
		// Old task immutable.
		const old = await svc.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(old.result).toBe("first");
	});

	it("enforces the pinned binding and issue", async () => {
		const svc = await makeService();
		await svc.send(create());
		const other = {
			...binding,
			accountLinkId: "66666666-6666-4666-8666-666666666666",
		};
		await expect(
			svc.send(create({ taskId: TASK_B, messageId: "m2", binding: other })),
		).rejects.toMatchObject({ code: "context_mismatch" });
		await expect(
			svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding: other }),
		).rejects.toMatchObject({ code: "context_mismatch" });
		await expect(
			svc.send(
				create({
					kind: "followup",
					messageId: "m3",
					issue: { ...issue, id: "999" },
				}),
			),
		).rejects.toMatchObject({ code: "context_mismatch" });
		// Task id used under another context.
		await expect(
			svc.get({ version: 1, taskId: TASK_A, contextId: CTX2, binding }),
		).rejects.toMatchObject({ code: "task_not_found" });
		await expect(svc.send(create({ contextId: CTX2 }))).rejects.toMatchObject({
			code: "context_mismatch",
		});
	});

	it("rejects non-UUID identifiers before touching the filesystem", async () => {
		const svc = await makeService();
		await expect(
			svc.send(create({ contextId: "../../etc" })),
		).rejects.toMatchObject({ code: "invalid_request" });
	});

	it("a failed journal write rejects the create and admits nothing", async () => {
		const svc = await makeService();
		const journal = (svc as any).journal as JiraAgentJournal;
		const save = vi
			.spyOn(journal, "save")
			.mockRejectedValueOnce(new Error("disk full"));
		await expect(svc.send(create())).rejects.toMatchObject({
			code: "journal_failure",
		});
		expect(runners).toHaveLength(0);
		expect(journal.getContext(CTX)).toBeUndefined();
		save.mockRestore();
		await svc.send(create());
		await started(1);
	});
});

describe("follow-ups", () => {
	it("streaming: queued follow-up is injected at the turn boundary", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		const f = await svc.send(
			create({
				kind: "followup",
				messageId: "f1",
				text: "Include the failing fixture.",
			}),
		);
		expect(f.pendingFollowups).toBe(1);
		// Same follow-up again is idempotent.
		await svc.send(
			create({
				kind: "followup",
				messageId: "f1",
				text: "Include the failing fixture.",
			}),
		);
		const r = lastRunner();
		r.result("first turn");
		expect(r.injected).toHaveLength(1);
		expect(r.injected[0]).toContain("Include the failing fixture.");
		expect(r.completeCalls).toBe(0);
		let s = await svc.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("working");
		r.result("second turn");
		await vi.waitFor(async () => {
			s = await svc.get({
				version: 1,
				taskId: TASK_A,
				contextId: CTX,
				binding,
			});
			expect(s.state).toBe("completed");
		});
		expect(s.result).toBe("second turn");
		expect(runners).toHaveLength(1);
	});

	it("non-streaming: follow-up runs as a resumed next turn before completion", async () => {
		runnerOpts = { ...runnerOpts, streaming: false };
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		await svc.send(
			create({ kind: "followup", messageId: "f1", text: "Also update docs." }),
		);
		lastRunner().result("first");
		lastRunner().settle();
		await started(2);
		expect(builds[1]?.resume).toEqual({
			runnerType: "claude",
			sessionId: "sess-1",
		});
		expect(lastRunner().prompts[0]).toContain("Also update docs.");
		lastRunner().result("second");
		lastRunner().settle();
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.result,
			).toBe("second"),
		);
	});

	it("follow-up to an ended task is task_terminal; queue is bounded", async () => {
		const svc = await makeService({ maxQueuedFollowups: 1 });
		await svc.send(create());
		await started(1);
		await svc.send(create({ kind: "followup", messageId: "f1", text: "one" }));
		await expect(
			svc.send(create({ kind: "followup", messageId: "f2", text: "two" })),
		).rejects.toMatchObject({ code: "context_busy" });
		await svc.cancel({ version: 1, taskId: TASK_A, contextId: CTX, binding });
		await expect(
			svc.send(create({ kind: "followup", messageId: "f3", text: "three" })),
		).rejects.toMatchObject({ code: "task_terminal" });
	});
});

describe("cancellation", () => {
	it("stops the runner, awaits settlement, and reports canceled", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		const s = await svc.cancel({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(lastRunner().stopCalls).toBe(1);
		expect(s.state).toBe("canceled");
		expect(s.settled).toBe(true);
		expect(s.error).toBe(CANCELED_MESSAGE);
	});

	it("late settlement: canceling first, canceled after; late output ignored", async () => {
		runnerOpts = { ...runnerOpts, settleOnStop: false };
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		await svc.send(
			create({ kind: "followup", messageId: "f1", text: "queued" }),
		);
		const s = await svc.cancel({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("canceling");
		expect(s.settled).toBe(false);
		expect(s.pendingFollowups).toBe(0);
		// Context stays reserved while the execution may still run.
		await expect(
			svc.send(create({ taskId: TASK_B, messageId: "m2" })),
		).rejects.toMatchObject({ code: "context_busy" });
		// Late output cannot resurrect or complete the task.
		lastRunner().say("late progress");
		lastRunner().result("late result");
		expect(lastRunner().injected).toEqual([]);
		lastRunner().settle();
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.state,
			).toBe("canceled"),
		);
		const final = await svc.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(final.result).toBeNull();
		expect(final.progress).toEqual([]);
		await svc.send(create({ taskId: TASK_B, messageId: "m2" }));
	});

	it("a stop that never settles stays canceling and keeps the context reserved", async () => {
		runnerOpts = { ...runnerOpts, settleOnStop: false };
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		await svc.cancel({ version: 1, taskId: TASK_A, contextId: CTX, binding });
		await new Promise((r) => setTimeout(r, 80));
		const s = await svc.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("canceling");
		expect(s.settled).toBe(false);
		expect(svc.liveCount()).toBe(1);
	});

	it("cancel during setup never starts the runner", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		const svc = await makeService({
			createWorkspace: async (_r, t) => {
				await gate;
				return { path: `/ws/${t.identifier}`, isGitWorktree: true };
			},
		});
		await svc.send(create());
		const s = await svc.cancel({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("canceling");
		release();
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.state,
			).toBe("canceled"),
		);
		expect(runners).toHaveLength(0);
	});

	it("cancel of a completed task leaves it unchanged", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		lastRunner().result("done");
		await vi.waitFor(async () =>
			expect(
				(await svc.get({ version: 1, taskId: TASK_A, contextId: CTX, binding }))
					.state,
			).toBe("completed"),
		);
		const s = await svc.cancel({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("completed");
		expect(s.result).toBe("done");
	});
});

describe("deadline and restart", () => {
	it("hard deadline stops the runner and fails only after settlement", async () => {
		runnerOpts = { ...runnerOpts, settleOnStop: false };
		const svc = await makeService({ deadlineMs: 30 });
		await svc.send(create());
		await vi.waitFor(() => expect(lastRunner()?.stopCalls).toBe(1));
		let s = await svc.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("canceling");
		expect(s.settled).toBe(false);
		lastRunner().settle();
		await vi.waitFor(async () => {
			s = await svc.get({
				version: 1,
				taskId: TASK_A,
				contextId: CTX,
				binding,
			});
			expect(s.state).toBe("failed");
		});
		expect(s.error).toBe(DEADLINE_MESSAGE);
	});

	it("restart marks in-flight tasks failed and releases the context", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		await vi.waitFor(() =>
			expect(journalFile().tasks[0].state).toBe("working"),
		);
		// Simulate a process restart: a fresh journal + service on the same home.
		const svc2 = await makeService();
		const s = await svc2.get({
			version: 1,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("failed");
		expect(s.settled).toBe(true);
		expect(s.error).toBe(RESTART_MESSAGE);
		expect(journalFile().tasks[0].state).toBe("failed");
		await svc2.send(create({ taskId: TASK_B, messageId: "m2" }));
	});

	it("journal writes are atomic (no temp files left behind)", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started(1);
		lastRunner().result("ok");
		await vi.waitFor(() =>
			expect(journalFile().tasks[0].state).toBe("completed"),
		);
		expect(readdirSync(join(home, "jira-agent", "contexts"))).toEqual([
			`${CTX}.json`,
		]);
	});
});

describe("routes", () => {
	async function app(key: string) {
		const fastify = Fastify();
		const svc = await makeService();
		registerJiraAgentRoutes(fastify, svc, () => key);
		await fastify.ready();
		return fastify;
	}
	const post = (
		f: Awaited<ReturnType<typeof app>>,
		op: string,
		body: unknown,
		auth?: string,
	) =>
		f.inject({
			method: "POST",
			url: `/api/jira-agent/v1/tasks/${op}`,
			payload: body as object,
			headers: auth ? { authorization: auth } : {},
		});

	it("requires the current runtime key; an empty key disables the routes", async () => {
		const empty = await app("");
		expect(
			(await post(empty, "get", { version: 1 }, "Bearer ")).statusCode,
		).toBe(401);
		const f = await app("k1");
		expect((await post(f, "get", { version: 1 })).statusCode).toBe(401);
		expect((await post(f, "get", { version: 1 }, "Bearer k2")).statusCode).toBe(
			401,
		);
		const ok = await post(
			f,
			"get",
			{ version: 1, taskId: TASK_A, contextId: CTX, binding },
			"Bearer k1",
		);
		expect(ok.statusCode).toBe(404);
		expect(ok.json()).toMatchObject({ success: false, code: "task_not_found" });
	});

	it("rejects unsupported versions and invalid bodies", async () => {
		const f = await app("k1");
		const v = await post(f, "send", { ...create(), version: 2 }, "Bearer k1");
		expect(v.statusCode).toBe(400);
		expect(v.json().code).toBe("unsupported_version");
		const bad = await post(
			f,
			"send",
			{ ...create(), extra: "path" },
			"Bearer k1",
		);
		expect(bad.json().code).toBe("invalid_request");
		const badIssue = await post(
			f,
			"send",
			{ ...create(), issue: { ...issue, key: "../x" } },
			"Bearer k1",
		);
		expect(badIssue.json().code).toBe("invalid_request");
	});

	it("accepts a valid create and returns a snapshot", async () => {
		const f = await app("k1");
		const res = await post(f, "send", create(), "Bearer k1");
		expect(res.statusCode).toBe(200);
		expect(res.json()).toMatchObject({
			success: true,
			data: { taskId: TASK_A, contextId: CTX, state: "submitted" },
		});
		const busy = await post(
			f,
			"send",
			create({ taskId: TASK_B, messageId: "x" }),
			"Bearer k1",
		);
		expect(busy.statusCode).toBe(409);
		expect(busy.json().code).toBe("context_busy");
	});
});

describe("journal unavailable", () => {
	it("answers 503 (transient), not 404 (unsupported runtime), and still requires the key", async () => {
		const fastify = Fastify();
		registerUnavailableJiraAgentRoutes(fastify, () => "k1");
		await fastify.ready();
		const inject = (auth?: string) =>
			fastify.inject({
				method: "POST",
				url: "/api/jira-agent/v1/tasks/send",
				payload: create() as object,
				headers: auth ? { authorization: auth } : {},
			});
		expect((await inject()).statusCode).toBe(401);
		const res = await inject("Bearer k1");
		expect(res.statusCode).toBe(503);
		expect(res.json().code).toBe("journal_unavailable");
	});
});

describe("runner environment", () => {
	it("blanks Cyrus-owned integration credentials, keeps model and GitHub credentials", () => {
		expect(JIRA_SCRUBBED_ENV.CYRUS_API_KEY).toBe("");
		expect(JIRA_SCRUBBED_ENV.SLACK_BOT_TOKEN).toBe("");
		expect(JIRA_SCRUBBED_ENV.LINEAR_WEBHOOK_SECRET).toBe("");
		expect(Object.values(JIRA_SCRUBBED_ENV).every((v) => v === "")).toBe(true);
		expect(JIRA_SCRUBBED_ENV).not.toHaveProperty("ANTHROPIC_API_KEY");
		expect(JIRA_SCRUBBED_ENV).not.toHaveProperty("GITHUB_TOKEN");
	});
});

describe("tool scope", () => {
	it("drops MCP, worktree-switching and scheduling tools", () => {
		expect(
			scopeJiraAllowedTools([
				"Read",
				"Edit",
				"Bash(git status)",
				"mcp__linear__get_issue",
				"mcp__slack",
				"EnterWorktree",
				"CronCreate",
				"ScheduleWakeup",
				"RemoteTrigger",
				"PushNotification",
			]),
		).toEqual(["Read", "Edit", "Bash(git status)"]);
	});
});
