/**
 * Jira-visible tool/reasoning activity (runtime side).
 *
 * Pure label tests use the exact normalized shapes ClaudeRunner forwards and
 * CodexEventMapper emits (tool_use / tool_result / thinking). Service tests
 * use a scripted fake runner: they prove activity is bounded, durable,
 * withheld with output and never written after a fence, NOT that a real model
 * produces these messages.
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
	activityFromMessage,
	MAX_ACTIVITY_ENTRIES,
	redact,
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

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) =>
	({
		type: "assistant",
		session_id: "sess-1",
		message: { content },
		...extra,
	}) as unknown as SDKMessage;
const toolResult = (id: string, isError = false, content = "OUTPUT-SECRET") =>
	({
		type: "user",
		session_id: "sess-1",
		message: {
			role: "user",
			content: [
				{ type: "tool_result", tool_use_id: id, content, is_error: isError },
			],
		},
	}) as unknown as SDKMessage;

describe("activity labels", () => {
	it("pairs a Claude tool start with its finish and never copies output", () => {
		const labels = new Map<string, string>();
		const started = activityFromMessage(
			assistant([
				{ type: "text", text: "Let me check." },
				{
					type: "tool_use",
					id: "t1",
					name: "Bash",
					input: { command: "npm test\nrm -rf /", description: "Run tests" },
				},
			]),
			labels,
			"/ws/jira-x",
		);
		expect(started).toEqual([
			{ kind: "tool_started", toolId: "t1", text: "Command: Run tests" },
		]);
		const finished = activityFromMessage(toolResult("t1", true), labels, null);
		expect(finished).toEqual([
			{
				kind: "tool_finished",
				toolId: "t1",
				text: "Command: Run tests",
				outcome: "failed",
			},
		]);
		expect(JSON.stringify(finished)).not.toContain("OUTPUT-SECRET");
		// A finish is reported once; an unknown id is ignored.
		expect(activityFromMessage(toolResult("t1"), labels, null)).toEqual([]);
		expect(activityFromMessage(toolResult("nope"), labels, null)).toEqual([]);
	});

	it("labels Codex-mapped commands (first line, credentials masked)", () => {
		const labels = new Map<string, string>();
		const [entry] = activityFromMessage(
			assistant([
				{
					type: "tool_use",
					id: "item_1",
					name: "Bash",
					input: {
						command:
							'curl -H "Authorization: Bearer abc123" https://x --token=hunter2 && echo\nsecond line',
					},
				},
			]),
			labels,
			null,
		);
		expect(entry?.text).toBe(
			'Command: curl -H "Authorization: *** *** https://x --token=*** && echo',
		);
		expect(entry?.text).not.toContain("abc123");
		expect(entry?.text).not.toContain("hunter2");
		expect(entry?.text).not.toContain("second line");
	});

	it("keeps paths workspace-relative and never shows MCP arguments", () => {
		expect(
			toolLabel("Read", { file_path: "/ws/jira-x/src/a.ts" }, "/ws/jira-x"),
		).toBe("Read: src/a.ts");
		expect(
			toolLabel("Read", { file_path: "/Users/me/.ssh/id_rsa" }, "/ws/jira-x"),
		).toBe("Read: id_rsa");
		expect(
			toolLabel(
				"mcp__linear__save_issue",
				{ apiKey: "SECRET", body: "x" },
				null,
			),
		).toBe("Tool linear/save_issue");
		expect(
			toolLabel("WebFetch", { url: "https://example.com/a?k=SECRET" }, null),
		).toBe("Fetch: example.com");
		expect(
			toolLabel("Edit", { file_path: "a.ts", old_string: "SECRET" }, null),
		).toBe("Edit: a.ts");
		expect(toolLabel("X".repeat(500), {}, null).length).toBeLessThanOrEqual(
			200,
		);
		expect(redact("export API_KEY=abcdef")).toBe("export API_KEY=***");
	});

	it("shows thinking summaries truncated, drops redacted thinking and subagent steps", () => {
		const labels = new Map<string, string>();
		const drafts = activityFromMessage(
			assistant([
				{ type: "thinking", thinking: "x".repeat(5000), signature: "sig" },
				{ type: "redacted_thinking", data: "opaque" },
			]),
			labels,
			null,
		);
		expect(drafts).toHaveLength(1);
		expect(drafts[0]?.kind).toBe("reasoning");
		expect(drafts[0]?.text.length).toBeLessThanOrEqual(1024);
		expect(JSON.stringify(drafts)).not.toContain("opaque");
		expect(
			activityFromMessage(
				assistant([{ type: "tool_use", id: "s1", name: "Read", input: {} }], {
					parent_tool_use_id: "task-1",
				}),
				labels,
				null,
			),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Service: durable, bounded, withheld, fenced

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
const repo = {
	id: "repo-a",
	name: "Repo A",
	repositoryPath: "/repos/a",
	baseBranch: "main",
	workspaceBaseDir: "/ws",
} as RepositoryConfig;

async function makeService() {
	const journal = new JiraAgentJournal(home, logger);
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

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "jira-activity-test-"));
	runners = [];
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
});

describe("task activity", () => {
	it("is durable, ordered with progress, withheld with output and survives completion", async () => {
		const svc = await makeService();
		await svc.send(create());
		await vi.waitFor(() => expect(runner()?.prompts.length).toBe(1));
		runner().onMessage(
			assistant([
				{ type: "text", text: "Checking." },
				{
					type: "tool_use",
					id: "t1",
					name: "Read",
					input: { file_path: `/ws/jira-${CTX}/a.ts` },
				},
			]),
		);
		runner().onMessage(toolResult("t1"));
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).activity).toHaveLength(2),
		);
		const snap = await svc.get(ref());
		expect(snap.activity.map((a) => [a.kind, a.text, a.outcome])).toEqual([
			["tool_started", "Read: a.ts", undefined],
			["tool_finished", "Read: a.ts", "succeeded"],
		]);
		// One sequence orders progress and activity together.
		const seqs = [...snap.progress, ...snap.activity].map((e) => e.seq);
		expect(new Set(seqs).size).toBe(seqs.length);
		expect(journalFile().tasks[0].activity).toHaveLength(2);
		runner().finish("Done.");
		await vi.waitFor(async () =>
			expect((await svc.get(ref())).state).toBe("completed"),
		);
		expect((await svc.get(ref())).activity).toHaveLength(2);
		// Output and activity are withheld together.
		const withheld = await svc.get(ref([]));
		expect(withheld.contentWithheld).toBe(true);
		expect(withheld.activity).toEqual([]);
		// A restarted runtime reads it back from the journal.
		const reloaded = await makeService();
		expect((await reloaded.get(ref())).activity).toHaveLength(2);
	});

	it("is bounded to the newest entries", async () => {
		const svc = await makeService();
		await svc.send(create());
		await vi.waitFor(() => expect(runner()?.prompts.length).toBe(1));
		for (let i = 0; i < MAX_ACTIVITY_ENTRIES + 15; i++)
			runner().onMessage(
				assistant([
					{
						type: "tool_use",
						id: `t${i}`,
						name: "Grep",
						input: { pattern: `p${i}` },
					},
				]),
			);
		await vi.waitFor(async () => {
			const activity = (await svc.get(ref())).activity;
			expect(activity).toHaveLength(MAX_ACTIVITY_ENTRIES);
			expect(activity.at(-1)?.text).toBe(
				`Search code: p${MAX_ACTIVITY_ENTRIES + 14}`,
			);
		});
	});

	it("records nothing after a cancel fence", async () => {
		const svc = await makeService();
		await svc.send(create());
		await vi.waitFor(() => expect(runner()?.prompts.length).toBe(1));
		const r = runner();
		await svc.cancel(ref());
		r.onMessage(
			assistant([
				{
					type: "tool_use",
					id: "late",
					name: "Bash",
					input: { command: "ls" },
				},
			]),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		const snap = await svc.get(ref());
		expect(snap.state).toBe("canceled");
		expect(snap.activity).toEqual([]);
	});

	it("loads journals written before activity existed", async () => {
		const svc = await makeService();
		await svc.send(create());
		await vi.waitFor(() => expect(runner()?.prompts.length).toBe(1));
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
