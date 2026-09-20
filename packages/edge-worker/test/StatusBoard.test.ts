import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentMessage,
	type CyrusAgentSession,
	type CyrusAgentSessionEntry,
	createLogger,
	type IAgentRunner,
} from "cyrus-core";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import {
	type BoardOptions,
	boardMessageLogs,
	registerStatusBoard,
	StatusBoard,
} from "../src/StatusBoard.js";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function session(id = "session-1", running = false): CyrusAgentSession {
	return {
		id,
		type: "commentThread",
		context: "commentThread",
		status: "active",
		createdAt: 1000,
		updatedAt: 2000,
		workspace: { path: "/private/worktree", isGitWorktree: true },
		issue: {
			id: "issue-1",
			identifier: "TEAM-1",
			title: "Fix the board",
			branchName: "task",
		},
		repositories: [{ repositoryId: "repo-1" }],
		agentRunner: {
			isRunning: () => running,
			getMessages: () => [],
		} as unknown as IAgentRunner,
	} as CyrusAgentSession;
}
function options(sessions: CyrusAgentSession[] = []): BoardOptions {
	return {
		getSessions: () => sessions,
		getEntries: () => [],
		getStatus: () => "busy",
		getRepositoryName: () => "example/repo",
	};
}
function board(sessions: CyrusAgentSession[] = []) {
	const result = new StatusBoard(options(sessions));
	cleanups.push(() => result.close());
	return result;
}
const message = (value: unknown) => value as AgentMessage;

describe("status board snapshots", () => {
	it("keeps workspace routing separate for each task and omits ambiguous routes", () => {
		const nexmoe = session("nexmoe");
		const viora = session("viora");
		viora.repositories = [{ repositoryId: "repo-2" }];
		const ambiguous = session("ambiguous");
		ambiguous.repositories = [...nexmoe.repositories, ...viora.repositories];
		const view = new StatusBoard({
			...options([nexmoe, viora, ambiguous]),
			getLinearWorkspaceSlug: (id) => (id === "repo-1" ? "nexmoe" : "viora"),
		});
		cleanups.push(() => view.close());
		const tasks = view.snapshot().tasks;
		expect(tasks.find((t) => t.id === "nexmoe")?.linearWorkspaceSlug).toBe(
			"nexmoe",
		);
		expect(tasks.find((t) => t.id === "viora")?.linearWorkspaceSlug).toBe(
			"viora",
		);
		expect(
			tasks.find((t) => t.id === "ambiguous")?.linearWorkspaceSlug,
		).toBeUndefined();
	});

	it("exposes recorded reasoning effort and leaves missing effort unknown", () => {
		const known = session("known");
		known.metadata = {
			model: "gpt-6-astra",
			reasoningEffort: "high",
			fastMode: false,
		};
		const view = board([known, session("old")]);
		expect(view.snapshot().tasks.find((t) => t.id === "known")).toMatchObject({
			model: "gpt-6-astra",
			reasoningEffort: "high",
			fastMode: false,
		});
		expect(
			view.snapshot().tasks.find((t) => t.id === "old")?.reasoningEffort,
		).toBe("");
	});

	it("correlates live tool results within a runner session, including empty output", () => {
		const call = (runner: string) =>
			boardMessageLogs(
				message({
					type: "assistant",
					session_id: runner,
					message: {
						content: [
							{ type: "tool_use", id: "tool-1", name: "Bash", input: {} },
						],
					},
				}),
				10,
			)[0];
		const output = boardMessageLogs(
			message({
				type: "user",
				session_id: "runner-a",
				message: {
					content: [
						{ type: "tool_result", tool_use_id: "tool-1", content: "" },
					],
				},
			}),
			20,
		)[0];
		expect(output).toMatchObject({
			text: "",
			kind: "output",
			toolCallId: call("runner-a")?.toolCallId,
		});
		expect(output?.toolCallId).toMatch(/^[a-f0-9]{64}$/);
		expect(output?.toolCallId).not.toBe(call("runner-b")?.toolCallId);
		expect(call("")?.toolCallId).toBeUndefined();
	});
	it("does not reset another runner's start time when a task is archived", () => {
		const ongoing = session("ongoing");
		const removed = session("removed");
		let running = false;
		ongoing.agentRunner!.isRunning = () => running;
		let remove!: (session: CyrusAgentSession) => void;
		const sessions = [ongoing, removed];
		const view = new StatusBoard({
			...options(sessions),
			onSessionRemoved: (listener) => {
				remove = listener;
				return () => {};
			},
		});
		cleanups.push(() => view.close());
		view.snapshot();
		running = true;
		const startedAt = view
			.snapshot()
			.tasks.find((task) => task.id === ongoing.id)?.turnStartedAt;
		remove(removed);
		sessions.pop();
		expect(
			view.snapshot().tasks.find((task) => task.id === ongoing.id)
				?.turnStartedAt,
		).toBe(startedAt);
	});
	it("archives removed tasks without a browser and restores them after restart", async () => {
		const directory = await mkdtemp(join(tmpdir(), "board-history-"));
		cleanups.push(() => rm(directory, { recursive: true, force: true }));
		const manager = new AgentSessionManager();
		const task = session("old-task");
		task.status = "complete" as CyrusAgentSession["status"];
		manager.restoreState(
			{ [task.id]: task },
			{
				[task.id]: [
					{
						type: "assistant",
						content: "Historical output",
						metadata: { timestamp: 1500 },
					},
					{ type: "user", content: "PRIVATE_PROMPT" },
				],
			},
		);
		const settings: BoardOptions = {
			...options(),
			historyPath: join(directory, "board-history.json"),
			getSessions: () => manager.getAllSessions(),
			getEntries: (id) => manager.getSessionEntries(id),
			onSessionRemoved: (listener) => {
				manager.on("sessionRemoving", listener);
				return () => manager.off("sessionRemoving", listener);
			},
		};
		const first = new StatusBoard(settings);
		await first.ready();
		manager.removeSession(task.id);
		expect(first.snapshot().tasks).toEqual([
			expect.objectContaining({
				id: task.id,
				archived: true,
				status: "completed",
			}),
		]);
		await first.close();
		const restarted = new StatusBoard(settings);
		cleanups.push(() => restarted.close());
		await restarted.ready();
		expect(restarted.snapshot().tasks).toHaveLength(1);
		expect(restarted.historyLogs(task.id).map((log) => log.text)).toEqual([
			"Historical output",
		]);
		expect(JSON.stringify(restarted.snapshot())).not.toContain(
			"/private/worktree",
		);
		manager.restoreState({ [task.id]: task }, {});
		expect(restarted.snapshot().tasks).toHaveLength(1);
		expect(restarted.snapshot().tasks[0]?.archived).not.toBe(true);
		manager.cleanup(0);
		expect(restarted.snapshot().tasks[0]?.archived).toBe(true);
	});
	it("keeps saved history when a resumed runner has only the new turn", () => {
		const task = session();
		task.agentRunner!.getMessages = () => [
			message({
				type: "result",
				session_id: "new-turn",
				is_error: true,
				errors: ["New turn failed"],
			}),
		];
		const entries: CyrusAgentSessionEntry[] = [
			{
				type: "assistant",
				content: "Previous investigation",
				codexSessionId: "old-turn",
				metadata: { timestamp: 100 },
			},
			{
				type: "assistant",
				content: "{}",
				codexSessionId: "old-turn",
				metadata: {
					timestamp: 110,
					toolUseId: "tool-1",
					toolName: "Read",
					toolInput: { path: "README.md" },
				},
			},
			{
				type: "user",
				content: "Previous tool output",
				codexSessionId: "old-turn",
				metadata: {
					timestamp: 120,
					toolUseId: "tool-1",
					toolResultError: false,
				},
			},
			{ type: "user", content: "PRIVATE_PROMPT", metadata: { timestamp: 130 } },
			{
				type: "result",
				content: "Previous turn completed",
				codexSessionId: "old-turn",
				metadata: { timestamp: 140, isError: false },
			},
		];
		const view = new StatusBoard({
			...options([task]),
			getEntries: () => entries,
		});
		cleanups.push(() => view.close());
		const result = view.snapshot();
		expect(result.logs.map((log) => log.text)).toEqual([
			"Previous investigation",
			'Read\n{"path":"README.md"}',
			"Previous tool output",
			"Previous turn completed",
			"New turn failed",
		]);
		expect(result.logs.slice(0, 4).map((log) => log.at)).toEqual([
			100, 110, 120, 140,
		]);
		expect(result.tasks[0]?.status).toBe("error");
		expect(result.logs[1]?.toolCallId).toMatch(/^[a-f0-9]{64}$/);
		expect(result.logs[1]?.toolCallId).toBe(result.logs[2]?.toolCallId);
	});
	it("does not duplicate saved output when the runner still contains it", () => {
		const task = session();
		task.agentRunner!.getMessages = () => [
			message({
				type: "assistant",
				session_id: "turn",
				message: { content: [{ type: "text", text: "Already saved" }] },
			}),
		];
		const view = new StatusBoard({
			...options([task]),
			getEntries: () => [
				{
					type: "assistant",
					content: "Already saved",
					codexSessionId: "turn",
					metadata: { timestamp: 110 },
				},
			],
		});
		cleanups.push(() => view.close());
		expect(view.snapshot().logs).toEqual([
			expect.objectContaining({ text: "Already saved", at: 110 }),
		]);
	});
	it("uses each live runner, not a stale session status or the process-wide busy flag", () => {
		const running = session("running", true);
		running.status = "error" as CyrusAgentSession["status"];
		const idle = session("idle", false);
		const result = board([idle, running]).snapshot();
		expect(result.tasks.map((task) => [task.id, task.status])).toEqual([
			["running", "running"],
			["idle", "idle"],
		]);
		expect(JSON.stringify(result)).not.toContain("/private/worktree");
	});
	it("prioritizes live tasks before the retention limit", () => {
		const sessions = Array.from({ length: 70 }, (_, index) =>
			session(String(index)),
		);
		const running = session("live", true);
		running.updatedAt = 0;
		const result = board([...sessions, running]).snapshot();
		expect(result.tasks).toHaveLength(60);
		expect(result.tasks[0]?.id).toBe("live");
	});
	it("keeps visible text, tools and results while excluding prompts and reasoning", () => {
		const assistant = message({
			type: "assistant",
			message: {
				content: [
					{ type: "thinking", thinking: "PRIVATE_REASONING" },
					{ type: "redacted_thinking", data: "PRIVATE_CIPHERTEXT" },
					{ type: "text", text: "Checking the build" },
					{
						type: "tool_use",
						name: "Bash",
						input: { command: "echo ok", token: "PRIVATE_TOKEN" },
					},
				],
			},
		});
		const logs = boardMessageLogs(assistant, 10);
		expect(logs.map((log) => log.kind)).toEqual(["activity", "tool"]);
		expect(JSON.stringify(logs)).not.toMatch(/PRIVATE_/);
		expect(
			boardMessageLogs(
				message({ type: "user", message: { content: "PRIVATE_PROMPT" } }),
				10,
			),
		).toEqual([]);
		expect(
			boardMessageLogs(
				message({ type: "system", prompt: "PRIVATE_SYSTEM" }),
				10,
			),
		).toEqual([]);
		expect(
			boardMessageLogs(
				message({
					type: "user",
					message: {
						content: [
							{ type: "tool_result", content: "build failed", is_error: true },
						],
					},
				}),
				10,
			)[0],
		).toMatchObject({ text: "build failed", level: "error", kind: "output" });
	});
	it("reads in-memory messages, completion and redacted service logs without touching log files", () => {
		const task = session();
		task.agentRunner!.getMessages = () => [
			message({ type: "result", is_error: false, result: "Done" }),
		];
		const view = board([task]);
		createLogger({
			component: "BoardTest",
			context: { sessionId: task.id },
		}).warn("GH_TOKEN=ghp_private123");
		const result = view.snapshot();
		expect(result.tasks[0]?.status).toBe("completed");
		expect(result.logs).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ text: "Done", kind: "lifecycle" }),
				expect.objectContaining({
					sessionId: task.id,
					source: "cyrus",
					text: "[BoardTest] GH_TOKEN=[REDACTED]",
				}),
			]),
		);
	});
});

async function server() {
	const app = Fastify({ trustProxy: true });
	const directory = await mkdtemp(join(tmpdir(), "cyrus-board-test-"));
	await writeFile(
		join(directory, "index.html"),
		'<html lang="en">Board</html>',
	);
	registerStatusBoard(app, options(), pathToFileURL(`${directory}/`));
	app.get("/status", async () => ({ status: "idle" }));
	cleanups.push(() => rm(directory, { recursive: true, force: true }));
	cleanups.push(() => app.close());
	return app;
}

describe("status board routes", () => {
	it("serves the board and snapshot on the existing application server", async () => {
		const app = await server();
		const headers = { host: "127.0.0.1:3456" };
		const page = await app.inject({
			url: "/board",
			headers,
			remoteAddress: "127.0.0.1",
		});
		expect(page.statusCode).toBe(200);
		expect(page.body).toBe('<html lang="en">Board</html>');
		expect(page.headers["content-security-policy"]).toContain(
			"script-src 'self'",
		);
		const snapshot = await app.inject({
			url: "/board/api/snapshot",
			headers,
			remoteAddress: "::1",
		});
		expect(snapshot.json()).toMatchObject({
			app: "cyrus-board",
			tasks: [],
			service: { status: "busy" },
		});
		expect((await app.inject("/status")).json()).toEqual({ status: "idle" });
		expect(
			(
				await app.inject({
					url: "/board/package.json",
					headers,
					remoteAddress: "127.0.0.1",
				})
			).statusCode,
		).toBe(404);
	});
	it.each([
		{
			remoteAddress: "203.0.113.1",
			headers: { host: "localhost:3456", "x-forwarded-for": "127.0.0.1" },
		},
		{ remoteAddress: "127.0.0.1", headers: { host: "public.example" } },
		{
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:3456", "cf-connecting-ip": "203.0.113.1" },
		},
		{
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:3456", origin: "https://other.example" },
		},
		{
			remoteAddress: "127.0.0.1",
			headers: { host: "localhost:3456", forwarded: "for=127.0.0.1" },
		},
	])("blocks remote, tunneled, and cross-origin access: %j", async (request) => {
		const app = await server();
		for (const url of [
			"/board",
			"/board/api/snapshot",
			"/board/api/history/old-task",
			"/board/events",
			"/board/assets/app.js",
		]) {
			expect((await app.inject({ ...request, url })).statusCode).toBe(403);
		}
		expect((await app.inject({ ...request, url: "/status" })).statusCode).toBe(
			200,
		);
	});
	it("streams updated snapshots and closes open SSE responses during shutdown", async () => {
		const app = await server();
		const address = await app.listen({ port: 0, host: "127.0.0.1" });
		const response = await fetch(`${address}/board/events`, {
			signal: AbortSignal.timeout(8000),
		});
		expect(response.status).toBe(200);
		const reader = response.body!.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		const collected = new Set<string>();
		while (collected.size < 2) {
			const part = await reader.read();
			expect(part.done).toBe(false);
			buffer += decoder.decode(part.value);
			const events = buffer.split("\n\n");
			buffer = events.pop() ?? "";
			for (const event of events) {
				const data = event
					.split("\n")
					.find((line) => line.startsWith("data: "));
				if (data) collected.add(JSON.parse(data.slice(6)).collectedAt);
			}
		}
		await app.close();
		expect((await reader.read()).done).toBe(true);
	});
});
