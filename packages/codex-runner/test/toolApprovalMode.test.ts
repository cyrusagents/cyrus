import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppServerCodexBackend } from "../src/backend/AppServerCodexBackend.js";
import type {
	IAppServerClient,
	NotificationHandler,
	ServerRequestHandler,
} from "../src/backend/appServerClient.js";
import { AppServerProcessManager } from "../src/backend/appServerProcess.js";
import type { ResolvedCodexConfig } from "../src/backend/types.js";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";

const codexHome = mkdtempSync(join(tmpdir(), "codex-approval-home-"));

/**
 * Fake transport. thread/start echoes approvalPolicy/approvalsReviewer the way
 * Codex 0.163.0 does (verified against a local `codex app-server`), unless
 * `legacy` is set to model an older server that ignores approvalsReviewer.
 */
class FakeClient extends EventEmitter implements IAppServerClient {
	notificationHandler: NotificationHandler | null = null;
	serverRequestHandler: ServerRequestHandler | null = null;
	requests: { method: string; params: any }[] = [];
	legacy = false;
	private nextThread = 0;
	setNotificationHandler(handler: NotificationHandler): void {
		this.notificationHandler = handler;
	}
	setServerRequestHandler(handler: ServerRequestHandler): void {
		this.serverRequestHandler = handler;
	}
	start(): void {}
	request<T = unknown>(method: string, params: any): Promise<T> {
		this.requests.push({ method, params });
		if (method === "thread/start" || method === "thread/resume") {
			const id =
				method === "thread/resume"
					? params.threadId
					: `thread-${++this.nextThread}`;
			return Promise.resolve({
				thread: { id },
				approvalPolicy: params.approvalPolicy,
				...(this.legacy
					? {}
					: { approvalsReviewer: params.approvalsReviewer ?? "user" }),
			} as T);
		}
		return Promise.resolve({} as T);
	}
	close(): Promise<void> {
		return Promise.resolve();
	}
	serverRequest(method: string, params: unknown): Promise<unknown> {
		return Promise.resolve(this.serverRequestHandler?.(method, params));
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
	codexPath: "/bin/true",
};

const autoConfig: ResolvedCodexConfig = {
	...baseConfig,
	approvalPolicy: "on-request",
	toolApprovalMode: "auto",
	approvalsReviewer: "auto_review",
};

/** One FakeClient per spawned app-server process. */
function setup() {
	const clients: FakeClient[] = [];
	const manager = new AppServerProcessManager(
		() => {
			const client = new FakeClient();
			clients.push(client);
			return client;
		},
		{ idleCloseMs: 0 },
	);
	return { clients, manager };
}

afterEach(() => vi.restoreAllMocks());

describe("CodexConfigBuilder toolApprovalMode", () => {
	it("keeps approvalPolicy never and no reviewer by default", async () => {
		const resolved = await new CodexConfigBuilder({
			workingDirectory: "/ws/repo",
			codexHome,
		}).build();
		expect(resolved.approvalPolicy).toBe("never");
		expect(resolved.approvalsReviewer).toBeUndefined();
		expect(resolved.toolApprovalMode).toBeUndefined();
	});

	it("maps auto to on-request + auto_review inside the sandbox", async () => {
		const resolved = await new CodexConfigBuilder({
			workingDirectory: "/ws/repo",
			codexHome,
			toolApprovalMode: "auto",
			askForApproval: "never",
			sandboxSettings: { allowWrite: ["/ws/repo"], allowRead: ["/ws/repo"] },
		}).build();
		expect(resolved.approvalPolicy).toBe("on-request");
		expect(resolved.approvalsReviewer).toBe("auto_review");
		// The restrictive egress profile is preserved.
		expect(resolved.sandbox.kind).toBe("profile");
	});

	it("never lets auto run with danger-full-access", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const resolved = await new CodexConfigBuilder({
			workingDirectory: "/ws/repo",
			codexHome,
			toolApprovalMode: "auto",
			sandbox: "danger-full-access",
		}).build();
		expect(resolved.sandbox).toMatchObject({
			kind: "workspace-mode",
			mode: "workspace-write",
		});
	});

	it("leaves an explicit danger-full-access untouched in allowlist mode", async () => {
		const resolved = await new CodexConfigBuilder({
			workingDirectory: "/ws/repo",
			codexHome,
			sandbox: "danger-full-access",
		}).build();
		expect(resolved.sandbox).toMatchObject({ mode: "danger-full-access" });
	});
});

describe("AppServerCodexBackend toolApprovalMode transport", () => {
	it("sends approvalsReviewer on thread/start and thread/resume in auto", async () => {
		const { clients, manager } = setup();
		const started = new AppServerCodexBackend(manager);
		await started.open(autoConfig);
		await started.close();
		const resumed = new AppServerCodexBackend(manager);
		await resumed.open({ ...autoConfig, resumeSessionId: "thread-1" });

		for (const method of ["thread/start", "thread/resume"]) {
			const params = clients
				.flatMap((c) => c.requests)
				.find((r) => r.method === method)?.params;
			expect(params).toMatchObject({
				approvalPolicy: "on-request",
				approvalsReviewer: "auto_review",
				sandbox: "workspace-write",
			});
		}
	});

	it("does not send approvalsReviewer in allowlist mode", async () => {
		const { clients, manager } = setup();
		await new AppServerCodexBackend(manager).open(baseConfig);
		const params = clients[0]?.requests.find(
			(r) => r.method === "thread/start",
		)?.params;
		expect(params.approvalPolicy).toBe("never");
		expect(params).not.toHaveProperty("approvalsReviewer");
	});

	it("warns when a Codex server does not confirm auto_review", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const backend = new AppServerCodexBackend(() => {
			const client = new FakeClient();
			client.legacy = true;
			return client;
		});
		await backend.open(autoConfig);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("did not confirm approvalsReviewer=auto_review"),
		);
	});
});

describe("app-server process approval policy", () => {
	it("pools by approval mode: same mode reuses, different mode gets its own process", async () => {
		const { clients, manager } = setup();
		await new AppServerCodexBackend(manager).open(autoConfig);
		await new AppServerCodexBackend(manager).open(autoConfig);
		expect(clients).toHaveLength(1);
		await new AppServerCodexBackend(manager).open(baseConfig);
		await new AppServerCodexBackend(manager).open(baseConfig);
		expect(clients).toHaveLength(2);
	});

	it("keeps the legacy accept response on an allowlist process", async () => {
		const { clients, manager } = setup();
		await new AppServerCodexBackend(manager).open(baseConfig);
		const client = clients[0]!;
		for (const params of [
			{ threadId: "thread-1" },
			{ threadId: "other" },
			{},
		]) {
			await expect(
				client.serverRequest("item/commandExecution/requestApproval", params),
			).resolves.toEqual({ decision: "accept" });
		}
		await expect(
			client.serverRequest("account/chatgptAuthTokens/refresh", {}),
		).resolves.toEqual({ chatgptAuthToken: null });
	});

	it.each([
		["item/commandExecution/requestApproval", { decision: "decline" }],
		["item/fileChange/requestApproval", { decision: "decline" }],
		["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
		["mcpServer/elicitation/request", { action: "decline" }],
		["item/tool/requestUserInput", { answers: {} }],
		["execCommandApproval", { decision: "denied" }],
		["applyPatchApproval", { decision: "denied" }],
	])("auto process denies %s for known and unknown threads", async (method, expected) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { clients, manager } = setup();
		await new AppServerCodexBackend(manager).open(autoConfig);
		const client = clients[0]!;
		for (const params of [
			{ threadId: "thread-1" },
			{ threadId: "unknown" },
			{ conversationId: "thread-1" },
			{},
		]) {
			await expect(client.serverRequest(method, params)).resolves.toEqual(
				expected,
			);
		}
	});

	it("auto process denies approvals that arrive before thread/start returns", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const clients: FakeClient[] = [];
		const early: unknown[] = [];
		const manager = new AppServerProcessManager(
			() => {
				const client = new FakeClient();
				const request = client.request.bind(client);
				client.request = async <T>(method: string, params: any) => {
					if (method === "thread/start") {
						// Server asks before the thread id reaches the client.
						early.push(
							await client.serverRequest(
								"item/commandExecution/requestApproval",
								{ threadId: "thread-1" },
							),
						);
					}
					return request<T>(method, params);
				};
				clients.push(client);
				return client;
			},
			{ idleCloseMs: 0 },
		);
		await new AppServerCodexBackend(manager).open(autoConfig);
		expect(early).toEqual([{ decision: "decline" }]);
	});

	it("auto process still denies after the thread closes", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { clients, manager } = setup();
		const keepAlive = new AppServerCodexBackend(manager);
		await keepAlive.open(autoConfig);
		const closing = new AppServerCodexBackend(manager);
		await closing.open(autoConfig);
		await closing.close();
		await expect(
			clients[0]!.serverRequest("item/fileChange/requestApproval", {
				threadId: "thread-2",
			}),
		).resolves.toEqual({ decision: "decline" });
	});

	it("a thread resumed in allowlist mode runs on an allowlist process again", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { clients, manager } = setup();
		const auto = new AppServerCodexBackend(manager);
		await auto.open(autoConfig);
		await auto.close();
		await new AppServerCodexBackend(manager).open({
			...baseConfig,
			resumeSessionId: "thread-1",
		});
		const allowlistClient = clients.at(-1)!;
		expect(allowlistClient).not.toBe(clients[0]);
		await expect(
			allowlistClient.serverRequest("item/fileChange/requestApproval", {
				threadId: "thread-1",
			}),
		).resolves.toEqual({ decision: "accept" });
	});
});
