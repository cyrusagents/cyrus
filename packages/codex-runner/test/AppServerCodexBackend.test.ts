import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { AppServerCodexBackend } from "../src/backend/AppServerCodexBackend.js";
import {
	AppServerClient,
	type IAppServerClient,
	type NotificationHandler,
	type ServerRequestHandler,
} from "../src/backend/appServerClient.js";
import type {
	NormalizedCodexEvent,
	ResolvedCodexConfig,
} from "../src/backend/types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** In-memory transport that records requests and lets tests push notifications. */
class FakeClient extends EventEmitter implements IAppServerClient {
	notificationHandler: NotificationHandler | null = null;
	serverRequestHandler: ServerRequestHandler | null = null;
	requests: { method: string; params: unknown }[] = [];
	responses: Record<string, unknown> = {
		initialize: {},
		"thread/start": { thread: { id: "thread-1" } },
		"thread/resume": { thread: { id: "thread-resumed" } },
		"turn/start": { turn: { id: "turn-1" } },
		"turn/steer": { turnId: "turn-1" },
		"turn/interrupt": {},
	};

	setNotificationHandler(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}
	setServerRequestHandler(handler: ServerRequestHandler): void {
		this.serverRequestHandler = handler;
	}
	start(): void {}
	request<T = unknown>(method: string, params: unknown): Promise<T> {
		this.requests.push({ method, params });
		return Promise.resolve((this.responses[method] ?? {}) as T);
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
	push(method: string, params: unknown): void {
		this.notificationHandler?.(method, params);
	}
	lastRequest(method: string): { method: string; params: unknown } | undefined {
		return [...this.requests].reverse().find((r) => r.method === method);
	}
}

const baseConfig: ResolvedCodexConfig = {
	sandbox: {
		kind: "workspace-mode",
		mode: "workspace-write",
		writableRoots: [],
		networkAccess: true,
	},
	approvalPolicy: "never",
	skipGitRepoCheck: true,
	workingDirectory: "/tmp/repo",
	codexHome: "/tmp/.codex",
};

function makeBackend(): { backend: AppServerCodexBackend; client: FakeClient } {
	const client = new FakeClient();
	const backend = new AppServerCodexBackend(() => client);
	return { backend, client };
}

describe("AppServerCodexBackend", () => {
	it("declares steering support", () => {
		const { backend } = makeBackend();
		expect(backend.supportsSteer).toBe(true);
	});

	it("initializes, starts a thread, and emits thread-started", async () => {
		const { backend, client } = makeBackend();
		const events: NormalizedCodexEvent[] = [];
		backend.on("event", (e) => events.push(e));

		const { threadId } = await backend.open({
			...baseConfig,
			codexPath: "/bin/true",
		});

		expect(threadId).toBe("thread-1");
		expect(client.requests[0]?.method).toBe("initialize");
		expect(client.requests[1]?.method).toBe("thread/start");
		expect(events).toContainEqual({
			kind: "thread-started",
			threadId: "thread-1",
		});
	});

	it("passes MCP config overrides through to thread/start config", async () => {
		const { backend, client } = makeBackend();
		await backend.open({
			...baseConfig,
			codexPath: "/bin/true",
			configOverrides: { mcp_servers: { linear: { command: "linear-mcp" } } },
		});
		const cfg = (
			client.lastRequest("thread/start")?.params as {
				config?: Record<string, unknown>;
			}
		).config;
		expect(cfg?.mcp_servers).toEqual({ linear: { command: "linear-mcp" } });
	});

	it("serializes a workspace-mode sandbox to thread/start sandbox + config", async () => {
		const { backend, client } = makeBackend();
		await backend.open({
			...baseConfig,
			codexPath: "/bin/true",
			sandbox: {
				kind: "workspace-mode",
				mode: "workspace-write",
				writableRoots: ["/repo/b", "/repo/c"],
				networkAccess: false,
			},
		});
		const params = client.lastRequest("thread/start")?.params as {
			sandbox?: string;
			config?: { sandbox_workspace_write?: Record<string, unknown> };
		};
		expect(params.sandbox).toBe("workspace-write");
		expect(params.config?.sandbox_workspace_write).toEqual({
			network_access: false,
			writable_roots: ["/repo/b", "/repo/c"],
		});
	});

	it("serializes a policy sandbox to turn/start sandboxPolicy (restricted reads + platform defaults)", async () => {
		const { backend, client } = makeBackend();
		await backend.open({
			...baseConfig,
			codexPath: "/bin/true",
			sandbox: {
				kind: "policy",
				policy: {
					type: "workspaceWrite",
					writableRoots: ["/repo/a"],
					readableRoots: ["/repo/a", "/usr/lib"],
					networkAccess: false,
				},
			},
		});
		// thread/start carries the matching coarse baseline mode...
		expect(
			(client.lastRequest("thread/start")?.params as { sandbox?: string })
				.sandbox,
		).toBe("workspace-write");
		// ...and thread/start does NOT inject sandbox_workspace_write (turn governs).
		expect(
			(
				client.lastRequest("thread/start")?.params as {
					config?: Record<string, unknown>;
				}
			).config?.sandbox_workspace_write,
		).toBeUndefined();

		const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
		await Promise.resolve();
		expect(
			(client.lastRequest("turn/start")?.params as { sandboxPolicy?: unknown })
				.sandboxPolicy,
		).toEqual({
			type: "workspaceWrite",
			writableRoots: ["/repo/a"],
			readOnlyAccess: {
				type: "restricted",
				includePlatformDefaults: true,
				readableRoots: ["/repo/a", "/usr/lib"],
			},
			networkAccess: false,
			excludeSlashTmp: false,
			excludeTmpdirEnvVar: false,
		});
		client.push("turn/completed", {
			turn: { id: "turn-1", status: "completed" },
		});
		await turnDone;
	});

	it("passes outputSchema on turn/start when configured", async () => {
		const { backend, client } = makeBackend();
		const schema = { type: "object", properties: { x: { type: "string" } } };
		await backend.open({
			...baseConfig,
			codexPath: "/bin/true",
			outputSchema: schema,
		});
		const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
		await Promise.resolve();
		expect(
			(client.lastRequest("turn/start")?.params as { outputSchema?: unknown })
				.outputSchema,
		).toEqual(schema);
		client.push("turn/completed", {
			turn: { id: "turn-1", status: "completed" },
		});
		await turnDone;
	});

	it("resumes a thread when resumeSessionId is set", async () => {
		const { backend, client } = makeBackend();
		await backend.open({
			...baseConfig,
			codexPath: "/bin/true",
			resumeSessionId: "thread-resumed",
		});
		expect(client.lastRequest("thread/resume")?.params).toMatchObject({
			threadId: "thread-resumed",
		});
	});

	it("replays a real notification stream into normalized events and resolves the turn", async () => {
		const { backend, client } = makeBackend();
		const events: NormalizedCodexEvent[] = [];
		backend.on("event", (e) => events.push(e));

		await backend.open({ ...baseConfig, codexPath: "/bin/true" });
		const turnDone = backend.runTurn([{ type: "text", text: "do it" }]);
		await Promise.resolve(); // let turn/start settle and activeTurnId set

		const fixture = readFileSync(
			join(__dirname, "fixtures", "app-server-coding-notifications.jsonl"),
			"utf8",
		)
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as { method: string; params: unknown });

		for (const { method, params } of fixture) {
			client.push(method, params);
		}

		await turnDone;

		const kinds = events.map((e) => e.kind);
		expect(kinds).toContain("turn-completed");
		// The real coding stream included a commandExecution item.
		const commandItem = events.find(
			(e) => e.kind === "item-completed" && e.item.type === "command_execution",
		);
		expect(commandItem).toBeDefined();
		// turn-completed carries usage sourced from thread/tokenUsage/updated.
		const completed = events.find((e) => e.kind === "turn-completed");
		expect(
			completed && "usage" in completed && completed.usage.input_tokens,
		).toBeGreaterThan(0);
	});

	it("steers the active turn with the expected turn id", async () => {
		const { backend, client } = makeBackend();
		await backend.open({ ...baseConfig, codexPath: "/bin/true" });
		const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
		await Promise.resolve();

		expect(backend.isTurnActive()).toBe(true);
		await backend.steer([{ type: "text", text: "also do this" }]);

		expect(client.lastRequest("turn/steer")?.params).toMatchObject({
			threadId: "thread-1",
			expectedTurnId: "turn-1",
			input: [{ type: "text", text: "also do this" }],
		});

		client.push("turn/completed", {
			turn: { id: "turn-1", status: "completed" },
		});
		await turnDone;
	});

	it("rejects steering when no turn is active", async () => {
		const { backend } = makeBackend();
		await backend.open({ ...baseConfig, codexPath: "/bin/true" });
		await expect(
			backend.steer([{ type: "text", text: "nope" }]),
		).rejects.toThrow(/no active turn/i);
	});

	it("emits turn-started and gates isTurnActive on the resolved turn id", async () => {
		const { backend, client } = makeBackend();
		const events: NormalizedCodexEvent[] = [];
		backend.on("event", (e) => events.push(e));
		await backend.open({ ...baseConfig, codexPath: "/bin/true" });

		// No turn yet → not steerable.
		expect(backend.isTurnActive()).toBe(false);

		const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
		await Promise.resolve(); // turn/start resolves → activeTurnId set

		expect(backend.isTurnActive()).toBe(true);

		// The runner is signalled to flush buffered follow-ups only once the
		// server confirms the turn is steerable via the turn/started notification.
		expect(events.some((e) => e.kind === "turn-started")).toBe(false);
		client.push("turn/started", { turn: { id: "turn-1" } });
		expect(events.some((e) => e.kind === "turn-started")).toBe(true);

		client.push("turn/completed", {
			turn: { id: "turn-1", status: "completed" },
		});
		await turnDone;
		expect(backend.isTurnActive()).toBe(false);
	});

	it("keeps concurrent backend instances fully isolated", async () => {
		// Two backends running at once must not share thread/turn state. Each gets
		// its own client (own threadId); steering one must target only that one.
		const clientA = new FakeClient();
		clientA.responses["thread/start"] = { thread: { id: "thread-A" } };
		clientA.responses["turn/start"] = { turn: { id: "turn-A" } };
		const clientB = new FakeClient();
		clientB.responses["thread/start"] = { thread: { id: "thread-B" } };
		clientB.responses["turn/start"] = { turn: { id: "turn-B" } };

		const backendA = new AppServerCodexBackend(() => clientA);
		const backendB = new AppServerCodexBackend(() => clientB);
		const eventsA: NormalizedCodexEvent[] = [];
		const eventsB: NormalizedCodexEvent[] = [];
		backendA.on("event", (e) => eventsA.push(e));
		backendB.on("event", (e) => eventsB.push(e));

		await Promise.all([
			backendA.open({ ...baseConfig, codexPath: "/bin/true" }),
			backendB.open({ ...baseConfig, codexPath: "/bin/true" }),
		]);

		const turnA = backendA.runTurn([{ type: "text", text: "A" }]);
		const turnB = backendB.runTurn([{ type: "text", text: "B" }]);
		await Promise.resolve();

		// Steer each; assert each request lands only on its own client+thread.
		await backendA.steer([{ type: "text", text: "steer-A" }]);
		await backendB.steer([{ type: "text", text: "steer-B" }]);

		expect(clientA.lastRequest("turn/steer")?.params).toMatchObject({
			threadId: "thread-A",
			expectedTurnId: "turn-A",
			input: [{ type: "text", text: "steer-A" }],
		});
		expect(clientB.lastRequest("turn/steer")?.params).toMatchObject({
			threadId: "thread-B",
			expectedTurnId: "turn-B",
			input: [{ type: "text", text: "steer-B" }],
		});
		// No B request ever hit client A and vice versa.
		expect(clientA.requests.some((r) => r.method === "turn/steer")).toBe(true);
		expect(
			clientA.requests.filter((r) => r.method === "turn/steer"),
		).toHaveLength(1);

		// Completing A must not resolve B.
		clientA.push("turn/completed", {
			turn: { id: "turn-A", status: "completed" },
		});
		await turnA;
		expect(backendA.isTurnActive()).toBe(false);
		expect(backendB.isTurnActive()).toBe(true);

		clientB.push("turn/completed", {
			turn: { id: "turn-B", status: "completed" },
		});
		await turnB;
		expect(backendB.isTurnActive()).toBe(false);
	});

	it("emits turn-failed when the turn completes with failed status", async () => {
		const { backend, client } = makeBackend();
		const events: NormalizedCodexEvent[] = [];
		backend.on("event", (e) => events.push(e));
		await backend.open({ ...baseConfig, codexPath: "/bin/true" });
		const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
		await Promise.resolve();

		client.push("turn/completed", {
			turn: { id: "turn-1", status: "failed", error: { message: "boom" } },
		});
		await turnDone;

		expect(events).toContainEqual({ kind: "turn-failed", message: "boom" });
		expect(backend.isTurnActive()).toBe(false);
	});

	it("fails the in-flight turn if the process exits early", async () => {
		const { backend, client } = makeBackend();
		const events: NormalizedCodexEvent[] = [];
		backend.on("event", (e) => events.push(e));
		await backend.open({ ...baseConfig, codexPath: "/bin/true" });
		const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
		await Promise.resolve();

		client.emit("exit", 1, null);
		await turnDone;

		expect(events.some((e) => e.kind === "turn-failed")).toBe(true);
	});

	it("fails the turn when the app-server goes idle (watchdog)", async () => {
		vi.useFakeTimers();
		try {
			const client = new FakeClient();
			const backend = new AppServerCodexBackend(() => client, {
				turnIdleTimeoutMs: 1000,
			});
			const events: NormalizedCodexEvent[] = [];
			backend.on("event", (e) => events.push(e));
			await backend.open({ ...baseConfig, codexPath: "/bin/true" });
			const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
			await Promise.resolve();

			vi.advanceTimersByTime(1001);
			await turnDone;

			expect(
				events.some(
					(e) => e.kind === "turn-failed" && /no activity/.test(e.message),
				),
			).toBe(true);
			expect(backend.isTurnActive()).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("notifications reset the idle watchdog", async () => {
		vi.useFakeTimers();
		try {
			const client = new FakeClient();
			const backend = new AppServerCodexBackend(() => client, {
				turnIdleTimeoutMs: 1000,
			});
			const events: NormalizedCodexEvent[] = [];
			backend.on("event", (e) => events.push(e));
			await backend.open({ ...baseConfig, codexPath: "/bin/true" });
			const turnDone = backend.runTurn([{ type: "text", text: "go" }]);
			await Promise.resolve();

			// Activity at 800ms resets the 1000ms watchdog...
			vi.advanceTimersByTime(800);
			client.push("item/started", {
				item: { type: "reasoning", id: "r1" },
			});
			// ...so 800ms more is still under the budget (no failure yet).
			vi.advanceTimersByTime(800);
			expect(events.some((e) => e.kind === "turn-failed")).toBe(false);

			// Complete the turn cleanly so the test resolves.
			client.push("turn/completed", {
				turn: { id: "turn-1", status: "completed" },
			});
			await turnDone;
			expect(events.some((e) => e.kind === "turn-completed")).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("AppServerClient request timeout", () => {
	it("rejects a request when no response arrives within the timeout", async () => {
		// `sleep` ignores stdin and produces no stdout, so the request never
		// resolves and must be rejected by the timeout.
		const client = new AppServerClient({
			binaryPath: "/bin/sleep",
			args: ["5"],
			requestTimeoutMs: 50,
		});
		client.start();
		try {
			await expect(client.request("initialize", {})).rejects.toThrow(
				/timed out/i,
			);
		} finally {
			await client.close();
		}
	});
});
