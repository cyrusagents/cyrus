import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type {
	IAppServerClient,
	NotificationHandler,
	ServerRequestHandler,
} from "../src/backend/appServerClient.js";
import {
	AppServerProcessManager,
	type AppServerThreadHandler,
} from "../src/backend/appServerProcess.js";
import type { ResolvedCodexConfig } from "../src/backend/types.js";

/** Minimal in-memory app-server client for pool tests. */
class FakeClient extends EventEmitter implements IAppServerClient {
	notificationHandler: NotificationHandler | null = null;
	serverRequestHandler: ServerRequestHandler | null = null;
	startCalls = 0;
	closeCalls = 0;
	setNotificationHandler(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}
	setServerRequestHandler(handler: ServerRequestHandler): void {
		this.serverRequestHandler = handler;
	}
	start(): void {
		this.startCalls += 1;
	}
	request<T = unknown>(): Promise<T> {
		return Promise.resolve({} as T);
	}
	close(): Promise<void> {
		this.closeCalls += 1;
		return Promise.resolve();
	}
	push(method: string, params: unknown): void {
		this.notificationHandler?.(method, params);
	}
}

function configWithEnv(env?: Record<string, string>): ResolvedCodexConfig {
	return {
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
		...(env ? { env } : {}),
	};
}

function recordingFactory() {
	const clients: FakeClient[] = [];
	const factory = () => {
		const c = new FakeClient();
		clients.push(c);
		return c;
	};
	return { clients, factory };
}

describe("AppServerProcessManager pool", () => {
	it("shares one process for identical launch configs", async () => {
		const { clients, factory } = recordingFactory();
		const manager = new AppServerProcessManager(factory, { idleCloseMs: 0 });

		await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));
		await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));

		expect(clients).toHaveLength(1);
		expect(clients[0]?.startCalls).toBe(1);
	});

	it("starts a SEPARATE process for a different launch config (no hard-fail)", async () => {
		const { clients, factory } = recordingFactory();
		const manager = new AppServerProcessManager(factory, { idleCloseMs: 0 });

		// Two concurrent leases whose env differs must each get their own process
		// rather than the second throwing "already running with different options".
		await manager.acquire(configWithEnv({ CODEX_HOME: "/home-a" }));
		await expect(
			manager.acquire(configWithEnv({ CODEX_HOME: "/home-b" })),
		).resolves.toBeDefined();

		expect(clients).toHaveLength(2);
	});

	it("evicts an idle process so the next acquire starts fresh", async () => {
		vi.useFakeTimers();
		try {
			const { clients, factory } = recordingFactory();
			const manager = new AppServerProcessManager(factory, {
				idleCloseMs: 100,
			});

			const lease = await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));
			lease.release();
			await vi.advanceTimersByTimeAsync(150);
			expect(clients[0]?.closeCalls).toBe(1);

			// Same key, but the prior process was disposed → a fresh one is created.
			await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));
			expect(clients).toHaveLength(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("routes notifications to the owning thread by threadId", async () => {
		const { clients, factory } = recordingFactory();
		const manager = new AppServerProcessManager(factory, { idleCloseMs: 0 });
		const lease = await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));

		const a = handlerSpy();
		const b = handlerSpy();
		lease.registerThread("thread-A", a.handler);
		lease.registerThread("thread-B", b.handler);

		clients[0]?.push("item/completed", { threadId: "thread-B", item: {} });

		expect(a.notifications).toHaveLength(0);
		expect(b.notifications).toHaveLength(1);
	});

	it("delivers a threadId-less notification to the sole registered thread", async () => {
		const { clients, factory } = recordingFactory();
		const manager = new AppServerProcessManager(factory, { idleCloseMs: 0 });
		const lease = await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));

		const only = handlerSpy();
		lease.registerThread("thread-1", only.handler);

		clients[0]?.push("turn/started", { turn: { status: "in_progress" } });

		expect(only.notifications).toHaveLength(1);
	});

	it("drops a threadId-less notification when multiple threads are registered", async () => {
		const { clients, factory } = recordingFactory();
		const manager = new AppServerProcessManager(factory, { idleCloseMs: 0 });
		const lease = await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));

		const a = handlerSpy();
		const b = handlerSpy();
		lease.registerThread("thread-A", a.handler);
		lease.registerThread("thread-B", b.handler);

		clients[0]?.push("turn/started", { turn: { status: "in_progress" } });

		expect(a.notifications).toHaveLength(0);
		expect(b.notifications).toHaveLength(0);
	});

	it("accepts only Linear MCP tool elicitation requests by default", async () => {
		const { clients, factory } = recordingFactory();
		const manager = new AppServerProcessManager(factory, { idleCloseMs: 0 });

		await manager.acquire(configWithEnv({ CODEX_HOME: "/h" }));

		const serverRequestHandler = clients[0]?.serverRequestHandler;
		if (!serverRequestHandler) {
			throw new Error("Expected app-server request handler to be registered");
		}

		expect(
			await serverRequestHandler("mcpServer/elicitation/request", {
				serverName: "linear",
				_meta: { codex_approval_kind: "mcp_tool_call" },
			}),
		).toEqual({ action: "accept", content: {} });

		expect(
			await serverRequestHandler("mcpServer/elicitation/request", {
				serverName: "codex_apps",
				_meta: { codex_approval_kind: "mcp_tool_call" },
			}),
		).toEqual({ action: "cancel" });

		expect(
			await serverRequestHandler("mcpServer/elicitation/request", {
				serverName: "linear",
				_meta: { codex_approval_kind: "not_a_tool_call" },
			}),
		).toEqual({ action: "cancel" });
	});
});

function handlerSpy() {
	const notifications: { method: string; params: unknown }[] = [];
	const handler: AppServerThreadHandler = {
		onNotification: (method, params) => notifications.push({ method, params }),
		onProcessGone: () => {},
		onProcessError: () => {},
	};
	return { handler, notifications };
}
