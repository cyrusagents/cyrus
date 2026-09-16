import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	type AgentMessage,
	type CyrusAgentSession,
	createLogger,
	type IAgentRunner,
} from "cyrus-core";
import Fastify from "fastify";
import { afterEach, describe, expect, it } from "vitest";
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
