/**
 * Jira-visible tool/reasoning activity (runtime side).
 *
 * Extraction tests use the normalized shapes ClaudeRunner forwards and
 * CodexEventMapper emits (tool_use / tool_result / the typed reasoning
 * summary). Service tests drive the real message handler, context lock and
 * journal with a scripted fake runner: they prove what is (and is never)
 * published, its bounds and its persistence order, NOT that a real model
 * emits these messages. Every secret below is an invented marker.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	IAgentRunner,
	ILogger,
	RepositoryConfig,
	SDKMessage,
} from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ActivityCorrelation,
	extractActivityEvents,
	GAP_TEXT,
	MAX_ACTIVITY_ENTRIES,
	MAX_ACTIVITY_TEXT_BYTES,
	MAX_ACTIVITY_WINDOW_BYTES,
	MAX_EVENTS_PER_MESSAGE,
	REASONING_SUMMARY_SUBTYPE,
	restoreActivity,
	toolLabel,
} from "../src/jira-agent/JiraActivity.js";
import { JiraAgentJournal } from "../src/jira-agent/JiraAgentJournal.js";
import {
	JiraAgentTaskService,
	type JiraSendRequest,
} from "../src/jira-agent/JiraAgentTaskService.js";
import { standardJiraRouting } from "./jira-routing-fixture.js";

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => logger,
} as unknown as ILogger;

const SECRET = "SYNTHETIC-SECRET-7f3a";
const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
	({
		type: "assistant",
		session_id: "sess-1",
		message: { content },
		...extra,
	}) as unknown as SDKMessage;
const toolUse = (id: string, name: string, input: unknown = {}) => ({
	type: "tool_use",
	id,
	name,
	input,
});
const toolResult = (id: string, isError = false) =>
	({
		type: "user",
		session_id: "sess-1",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: id,
					content: `${SECRET}-output`,
					is_error: isError,
				},
			],
		},
	}) as unknown as SDKMessage;
const summary = (parts: unknown) =>
	({
		type: "system",
		subtype: REASONING_SUMMARY_SUBTYPE,
		summary: parts,
		session_id: "sess-1",
	}) as unknown as SDKMessage;
const drafts = (messages: SDKMessage[]) => {
	const c = new ActivityCorrelation("runner");
	return messages.flatMap((m) => c.apply(extractActivityEvents(m).events));
};

describe("what activity may contain", () => {
	it("uses fixed labels: no input, tool name or output reaches a start or finish", () => {
		const inputs: [string, unknown][] = [
			[
				"Bash",
				{ command: `curl -u alice:${SECRET} https://x`, description: SECRET },
			],
			["Grep", { pattern: SECRET }],
			["Glob", { pattern: SECRET }],
			["WebSearch", { query: SECRET }],
			["WebFetch", { url: `https://${SECRET}.example/?k=${SECRET}` }],
			["Task", { description: SECRET, prompt: SECRET }],
			["Read", { file_path: `/ws/${SECRET}/a.ts` }],
			["Edit", { file_path: "a.ts", old_string: SECRET, new_string: SECRET }],
			[`mcp__linear__${SECRET}`, { apiKey: SECRET }],
			[`Custom${SECRET}`, { x: SECRET }],
		];
		const messages = inputs.flatMap(([name, input], i) => [
			assistant([toolUse(`t${i}`, name, input)]),
			toolResult(`t${i}`, i % 2 === 1),
		]);
		const out = drafts(messages);
		expect(out).toHaveLength(inputs.length * 2);
		expect(JSON.stringify(out)).not.toContain(SECRET);
		expect(JSON.stringify(out)).not.toContain("alice");
		expect(
			out.filter((d) => d.kind === "tool_started").map((d) => d.text),
		).toEqual([
			"Command",
			"Code search",
			"File search",
			"Web search",
			"Web page fetch",
			"Subagent",
			"File read",
			"File edit",
			"Integration tool",
			"Tool",
		]);
		expect(toolLabel("constructor")).toBe("Tool");
		expect(toolLabel(undefined)).toBe("Tool");
	});

	it("never shows Claude thinking, redacted thinking or signatures", () => {
		const out = drafts([
			assistant([
				{
					type: "thinking",
					thinking: `${SECRET}-raw-thought`,
					signature: `${SECRET}-sig`,
				},
				{ type: "redacted_thinking", data: `${SECRET}-redacted` },
				{ type: "text", text: "visible answer text" },
			]),
			// A thinking delta or other system message is not a summary either.
			{
				type: "stream_event",
				event: { delta: { thinking: SECRET } },
			} as unknown as SDKMessage,
			{
				type: "system",
				subtype: "status",
				summary: [SECRET],
			} as unknown as SDKMessage,
		]);
		expect(out).toEqual([]);
	});

	it("shows only the provider's typed summary, bounded in UTF-8 bytes", () => {
		const cjk = "推".repeat(2000);
		const out = drafts([summary(["Checked the failing test.", 42, "  ", cjk])]);
		expect(out.map((d) => d.kind)).toEqual(["reasoning", "reasoning"]);
		expect(out[0]?.text).toBe("Checked the failing test.");
		expect(Buffer.byteLength(out[1]!.text, "utf8")).toBeLessThanOrEqual(
			MAX_ACTIVITY_TEXT_BYTES,
		);
		expect(drafts([summary("not an array")])).toEqual([]);
	});

	it("drops malformed or oversized tool ids and caps work per message", () => {
		const huge = "x".repeat(1_000_000);
		const one = extractActivityEvents(
			assistant([
				toolUse(huge, "Bash"),
				toolUse("ok bad", "Bash"),
				toolUse("ok", "Bash"),
			]),
		);
		expect(one.events).toEqual([{ kind: "start", id: "ok", label: "Command" }]);
		expect(one.overflow).toBe(2);
		const bulk = extractActivityEvents(
			assistant(
				Array.from({ length: 1000 }, (_, i) => toolUse(`t${i}`, "Read")),
			),
		);
		expect(bulk.events).toHaveLength(MAX_EVENTS_PER_MESSAGE);
		expect(bulk.overflow).toBe(1000 - MAX_EVENTS_PER_MESSAGE);
	});

	it("correlates once: duplicate starts/finishes, foreign and interleaved ids", () => {
		const out = drafts([
			assistant([toolUse("a", "Bash"), toolUse("b", "Read")]),
			assistant([toolUse("a", "Bash")]),
			toolResult("b"),
			toolResult("ghost"),
			toolResult("a", true),
			toolResult("a"),
			// A repeated normalized pair (e.g. a re-sent completion) is the same step.
			assistant([toolUse("a", "Bash")]),
			toolResult("a"),
		]);
		expect(out.map((d) => [d.kind, d.toolId, d.outcome])).toEqual([
			["tool_started", "a", undefined],
			["tool_started", "b", undefined],
			["tool_finished", "b", "succeeded"],
			["tool_finished", "a", "failed"],
		]);
	});

	it("re-bounds restored entries", () => {
		const restored = restoreActivity([
			{ seq: 1, at: "x", kind: "reasoning", text: "ok" },
			{ seq: 2, at: "x", kind: "reasoning", text: "推".repeat(1000) },
			{
				seq: 3,
				at: "x",
				kind: "tool_started",
				toolId: "y".repeat(500),
				text: "Command",
			},
			{ seq: 4, at: "x", kind: "other", text: "?" },
			...Array.from({ length: 200 }, (_, i) => ({
				seq: 10 + i,
				at: "x",
				kind: "reasoning",
				text: "推".repeat(300),
			})),
		]);
		expect(restored.length).toBeLessThanOrEqual(MAX_ACTIVITY_ENTRIES);
		expect(Buffer.byteLength(JSON.stringify(restored))).toBeLessThanOrEqual(
			MAX_ACTIVITY_WINDOW_BYTES,
		);
		expect(restored.at(-1)?.seq).toBe(209);
		expect(restoreActivity("junk")).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Service: durable, staged, bounded, withheld, fenced

const CTX = "11111111-1111-4111-8111-111111111111";
const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const binding = {
	teamId: "33333333-3333-4333-8333-333333333333",
	installationLinkId: "44444444-4444-4444-8444-444444444444",
	accountLinkId: "55555555-5555-4555-8555-555555555555",
};
const issue = {
	id: "10001",
	key: "QA-1",
	summary: "Fix",
	description: "",
	labels: [] as string[],
	projectKey: "QA",
};
const create = (): JiraSendRequest => ({
	version: 2,
	kind: "create",
	taskId: TASK,
	contextId: CTX,
	messageId: "msg-1",
	binding,
	issue,
	authorizedRepositoryIds: ["repo-a"],
	text: "Investigate.",
});
const followup = (): JiraSendRequest => ({
	...create(),
	kind: "followup",
	messageId: "msg-2",
	text: "And the other case.",
});
const ref = (authorizedRepositoryIds = ["repo-a"]) => ({
	version: 2 as const,
	taskId: TASK,
	contextId: CTX,
	binding,
	authorizedRepositoryIds,
});

class FakeRunner implements IAgentRunner {
	readonly supportsStreamingInput = false;
	prompts: string[] = [];
	private resolve: ((v: unknown) => void) | null = null;
	constructor(readonly onMessage: (m: SDKMessage) => void) {}
	start(prompt: string) {
		this.prompts.push(prompt);
		return new Promise<any>((r) => {
			this.resolve = r;
		});
	}
	stop() {
		this.resolve?.({
			sessionId: "sess-1",
			startedAt: new Date(),
			isRunning: false,
		});
	}
	isRunning() {
		return this.resolve !== null;
	}
	getMessages() {
		return [];
	}
	getFormatter() {
		return {} as any;
	}
	finish(text: string) {
		this.onMessage({
			type: "result",
			subtype: "success",
			is_error: false,
			result: text,
			session_id: "sess-1",
		} as unknown as SDKMessage);
		this.stop();
	}
}

let home: string;
let runners: FakeRunner[];
let journal: JiraAgentJournal;
const repo = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/repos/a",
	baseBranch: "main",
	workspaceBaseDir: "/ws",
} as RepositoryConfig;

async function makeService() {
	journal = new JiraAgentJournal(home, logger);
	await journal.load();
	return new JiraAgentTaskService({
		journal,
		logger,
		getRepository: (id) => (id === "repo-a" ? repo : undefined),
		...standardJiraRouting(() => [repo]),
		resolveRunnerType: () => "claude",
		createWorkspace: async (_r, target) => ({
			path: join("/ws", target.identifier),
			isGitWorktree: true,
		}),
		buildRunner: async (input) => {
			const runner = new FakeRunner(input.onMessage);
			runners.push(runner);
			return { runner, runnerType: "claude" };
		},
		cancelWaitMs: 50,
		postResultGraceMs: 10_000,
	});
}
const runner = () => runners[runners.length - 1] as FakeRunner;
const journalFile = () =>
	JSON.parse(
		readFileSync(join(home, "jira-agent", "contexts", `${CTX}.json`), "utf8"),
	);
const started = async () => {
	await vi.waitFor(() => expect(runner()?.prompts.length).toBe(1));
};

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jira-activity-test-"));
	runners = [];
});
afterEach(() => {
	vi.restoreAllMocks();
	rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("task activity", () => {
	it("is durable, ordered with progress, withheld with output and survives completion", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().onMessage(
			assistant([
				{ type: "text", text: "Checking." },
				toolUse("t1", "Read", { file_path: SECRET }),
			]),
		);
		runner().onMessage(toolResult("t1"));
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity).toHaveLength(2),
		);
		const snap = await svc.get(ref());
		expect(snap.activity.map((a) => [a.kind, a.text, a.outcome])).toEqual([
			["tool_started", "File read", undefined],
			["tool_finished", "File read", "succeeded"],
		]);
		const seqs = [...snap.progress, ...snap.activity].map((e) => e.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(JSON.stringify(journalFile())).not.toContain(SECRET);
		runner().finish("Done.");
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).state).toBe("completed"),
		);
		expect((await svc.get(ref())).activity).toHaveLength(2);
		const withheld = await svc.get(ref([]));
		expect(withheld.contentWithheld).toBe(true);
		expect(withheld.activity).toEqual([]);
		const reloaded = await makeService();
		expect((await reloaded.get(ref())).activity).toHaveLength(2);
	});

	it("a reasoning summary is activity only: the final answer stays the result", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().onMessage(summary(["Looked at the parser."]));
		runner().finish("The answer.");
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).state).toBe("completed"),
		);
		const snap = await svc.get(ref());
		expect(snap.result).toBe("The answer.");
		expect(snap.activity.map((a) => a.text)).toEqual(["Looked at the parser."]);
		expect(snap.progress.map((p) => p.text)).not.toContain(
			"Looked at the parser.",
		);
	});

	it("a summary without an answer can't complete the task", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().onMessage(summary(["Thought about it."]));
		runner().stop();
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).state).toBe("failed"),
		);
	});

	it("bounds a single bulk message and a burst of messages, and marks the gap", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().onMessage(
			assistant(
				Array.from({ length: 1000 }, (_, i) => toolUse(`bulk${i}`, "Read")),
			),
		);
		for (let i = 0; i < 400; i++)
			runner().onMessage(assistant([toolUse(`burst${i}`, "Grep")]));
		await vi.waitFor(async () => {
			const activity = (await svc.get(ref())).activity;
			expect(activity.length).toBe(MAX_ACTIVITY_ENTRIES);
		});
		const all = (await svc.get(ref())).activity;
		expect(Buffer.byteLength(JSON.stringify(all))).toBeLessThanOrEqual(
			MAX_ACTIVITY_WINDOW_BYTES,
		);
		// Ordered, monotonic sequence ids even after drops and eviction.
		const seqs = all.map((a) => a.seq);
		expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
		const file = journalFile();
		const kinds = file.tasks[0].activity.map((a: { kind: string }) => a.kind);
		expect(
			kinds.every((k: string) => k === "tool_started" || k === "gap"),
		).toBe(true);
	});

	it("records a gap when a message carried more than it could take", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().onMessage(
			assistant(Array.from({ length: 25 }, (_, i) => toolUse(`t${i}`, "Read"))),
		);
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity.length).toBe(
				MAX_EVENTS_PER_MESSAGE + 1,
			),
		);
		expect((await svc.get(ref())).activity[0]).toMatchObject({
			kind: "gap",
			text: GAP_TEXT,
		});
	});

	it("a failed start write publishes nothing, then retries in order (no orphan finish)", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		const save = journal.save.bind(journal);
		let failNext = true;
		vi.spyOn(journal, "save").mockImplementation(async (record) => {
			if (failNext) {
				failNext = false;
				throw new Error("disk full (synthetic)");
			}
			return save(record);
		});
		runner().onMessage(assistant([toolUse("s1", "Bash")]));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect((await svc.get(ref())).activity).toEqual([]);
		runner().onMessage(toolResult("s1"));
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity.map((a) => a.kind)).toEqual([
				"tool_started",
				"tool_finished",
			]),
		);
	});

	it("a failed finish write keeps the correlation so the retry still pairs", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().onMessage(assistant([toolUse("f1", "Bash")]));
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity).toHaveLength(1),
		);
		const save = journal.save.bind(journal);
		let failNext = true;
		vi.spyOn(journal, "save").mockImplementation(async (record) => {
			if (failNext) {
				failNext = false;
				throw new Error("disk full (synthetic)");
			}
			return save(record);
		});
		runner().onMessage(toolResult("f1", true));
		await vi.waitFor(
			async () =>
				expect((await svc.get(ref())).activity.map((a) => a.outcome)).toEqual([
					undefined,
					"failed",
				]),
			{ timeout: 3000 },
		);
	});

	it("bounds pending text in bytes while the journal is blocked", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		let unblock!: () => void;
		const blocked = new Promise<void>((r) => {
			unblock = r;
		});
		const save = journal.save.bind(journal);
		vi.spyOn(journal, "save").mockImplementation(async (record) => {
			await blocked;
			return save(record);
		});
		runner().onMessage(
			assistant([{ type: "text", text: "x".repeat(1_000_000) }]),
		);
		runner().onMessage(summary(["推".repeat(4096)]));
		const pending = (
			svc as unknown as {
				lives: Map<string, { output: { pending: unknown[] } }>;
			}
		).lives.get(TASK)!.output.pending;
		const bytes = Buffer.byteLength(JSON.stringify(pending), "utf8");
		expect(bytes).toBeLessThan(2048 + MAX_ACTIVITY_TEXT_BYTES + 1024);
		unblock();
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity).toHaveLength(1),
		);
	});

	for (const kind of ["tool finish", "progress"] as const)
		it(`a failed ${kind} write right before the final answer is kept with the terminal state`, async () => {
			const svc = await makeService();
			await svc.send(create());
			await started();
			runner().onMessage(assistant([toolUse("e1", "Bash")]));
			await vi.waitFor(async () =>
				expect((await svc.get(ref())).activity).toHaveLength(1),
			);
			const save = journal.save.bind(journal);
			let failNext = true;
			vi.spyOn(journal, "save").mockImplementation(async (record) => {
				if (failNext) {
					failNext = false;
					throw new Error("disk full (synthetic)");
				}
				return save(record);
			});
			if (kind === "tool finish") runner().onMessage(toolResult("e1"));
			else
				runner().onMessage(assistant([{ type: "text", text: "Almost done." }]));
			runner().finish("Final answer.");
			await vi.waitFor(async () =>
				expect((await svc.get(ref())).state).toBe("completed"),
			);
			const snap = await svc.get(ref());
			expect(snap.result).toBe("Final answer.");
			if (kind === "tool finish")
				expect(snap.activity.map((a) => a.kind)).toEqual([
					"tool_started",
					"tool_finished",
				]);
			else expect(snap.progress.map((p) => p.text)).toContain("Almost done.");
			expect(failNext).toBe(false);
		});

	it("ignores callbacks from a runner that is no longer current", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		const first = runner();
		await svc.send(followup());
		first.finish("First answer.");
		await vi.waitFor(() => expect(runners).toHaveLength(2));
		await vi.waitFor(() => expect(runner().prompts.length).toBe(1));
		first.onMessage(assistant([toolUse("stale", "Bash")]));
		runner().onMessage(assistant([toolUse("fresh", "Read")]));
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity.map((a) => a.toolId)).toEqual([
				"fresh",
			]),
		);
	});

	it("records nothing after a cancel fence", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		const r = runner();
		await svc.cancel(ref());
		r.onMessage(assistant([toolUse("late", "Bash")]));
		await new Promise((resolve) => setTimeout(resolve, 30));
		const snap = await svc.get(ref());
		expect(snap.state).toBe("canceled");
		expect(snap.activity).toEqual([]);
	});

	it("loads journals written before activity existed", async () => {
		const svc = await makeService();
		await svc.send(create());
		await started();
		runner().finish("Done.");
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).state).toBe("completed"),
		);
		const file = journalFile();
		delete file.tasks[0].activity;
		writeFileSync(
			join(home, "jira-agent", "contexts", `${CTX}.json`),
			JSON.stringify(file),
		);
		const reloaded = await makeService();
		const snap = await reloaded.get(ref());
		expect(snap.state).toBe("completed");
		expect(snap.activity).toEqual([]);
	});
});
