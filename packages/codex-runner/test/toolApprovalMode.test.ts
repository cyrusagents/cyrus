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

function setup() {
	const client = new FakeClient();
	const manager = new AppServerProcessManager(() => client, {
		idleCloseMs: 0,
	});
	return { client, manager };
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
		const { client, manager } = setup();
		const started = new AppServerCodexBackend(manager);
		await started.open(autoConfig);
		await started.close();
		const resumed = new AppServerCodexBackend(manager);
		await resumed.open({ ...autoConfig, resumeSessionId: "thread-1" });

		for (const method of ["thread/start", "thread/resume"]) {
			const params = client.requests.find((r) => r.method === method)?.params;
			expect(params).toMatchObject({
				approvalPolicy: "on-request",
				approvalsReviewer: "auto_review",
				sandbox: "workspace-write",
			});
		}
	});

	it("does not send approvalsReviewer in allowlist mode", async () => {
		const { client, manager } = setup();
		await new AppServerCodexBackend(manager).open(baseConfig);
		const params = client.requests.find(
			(r) => r.method === "thread/start",
		)?.params;
		expect(params.approvalPolicy).toBe("never");
		expect(params).not.toHaveProperty("approvalsReviewer");
	});
});

describe("app-server server-request routing", () => {
	it("keeps the legacy accept response for allowlist threads", async () => {
		const { client, manager } = setup();
		await new AppServerCodexBackend(manager).open(baseConfig);
		await expect(
			client.serverRequest("item/commandExecution/requestApproval", {
				threadId: "thread-1",
			}),
		).resolves.toEqual({ decision: "accept" });
	});

	it.each([
		["item/commandExecution/requestApproval", { decision: "decline" }],
		["item/fileChange/requestApproval", { decision: "decline" }],
		["item/permissions/requestApproval", { permissions: {}, scope: "turn" }],
		["mcpServer/elicitation/request", { action: "decline" }],
		["item/tool/requestUserInput", { answers: {} }],
	])("denies %s for auto threads with a schema-valid response", async (method, expected) => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, manager } = setup();
		await new AppServerCodexBackend(manager).open(autoConfig);
		await expect(
			client.serverRequest(method, { threadId: "thread-1" }),
		).resolves.toEqual(expected);
	});

	it("denies legacy v1 approvals routed by conversationId", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, manager } = setup();
		await new AppServerCodexBackend(manager).open(autoConfig);
		await expect(
			client.serverRequest("execCommandApproval", {
				conversationId: "thread-1",
			}),
		).resolves.toEqual({ decision: "denied" });
	});

	it("routes per thread when auto and allowlist threads share a process", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, manager } = setup();
		await new AppServerCodexBackend(manager).open(baseConfig); // thread-1
		await new AppServerCodexBackend(manager).open(autoConfig); // thread-2
		const method = "item/fileChange/requestApproval";
		await expect(
			client.serverRequest(method, { threadId: "thread-1" }),
		).resolves.toEqual({ decision: "accept" });
		await expect(
			client.serverRequest(method, { threadId: "thread-2" }),
		).resolves.toEqual({ decision: "decline" });
		// Unattributable approval requests are denied once an auto thread exists.
		await expect(client.serverRequest(method, {})).resolves.toEqual({
			decision: "decline",
		});
	});

	it("still denies approvals for an auto thread after it closes", async () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, manager } = setup();
		const keepAlive = new AppServerCodexBackend(manager);
		await keepAlive.open(baseConfig); // thread-1 keeps the process alive
		const auto = new AppServerCodexBackend(manager);
		await auto.open(autoConfig); // thread-2
		await auto.close();
		await expect(
			client.serverRequest("item/commandExecution/requestApproval", {
				threadId: "thread-2",
			}),
		).resolves.toEqual({ decision: "decline" });
	});

	it("falls back securely on a Codex that ignores approvalsReviewer", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { client, manager } = setup();
		client.legacy = true;
		await new AppServerCodexBackend(manager).open(autoConfig);
		expect(warn).toHaveBeenCalledWith(
			expect.stringContaining("did not confirm approvalsReviewer=auto_review"),
		);
		await expect(
			client.serverRequest("item/commandExecution/requestApproval", {
				threadId: "thread-1",
			}),
		).resolves.toEqual({ decision: "decline" });
	});
});
