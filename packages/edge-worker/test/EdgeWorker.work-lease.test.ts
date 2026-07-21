/**
 * F1 in-process end-to-end test — BRI-3257 work-lease handoff.
 *
 * Uses real HandoffMarkerParser and WorkLeaseClient (no mocks for these).
 * Infrastructure around EdgeWorker is mocked to isolate the handoff logic.
 *
 * Test groups:
 *  A. performHandoffCheck — paginated fetch, real parser + client
 *     Success: page1→page2(marker)→adopt→get, returns sha override
 *     Legacy: no marker → original overrides returned unchanged
 *  B. createCyrusAgentSession ordering proof
 *     performHandoffCheck runs before move-started, workspace, session
 *  C. Failure proofs — zero mutations on every failure path
 */

import * as http from "node:http";
import type {
	Comment,
	Connection,
	IIssueTrackerService,
	PaginationOptions,
	RepositoryConfig,
} from "cyrus-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// ── Module-level infrastructure mocks ────────────────────────────────────────
// Mirror the pattern in EdgeWorker.parent-branch.test.ts

vi.mock("fs/promises", () => ({
	readFile: vi.fn().mockResolvedValue("{}"),
	writeFile: vi.fn().mockResolvedValue(undefined),
	mkdir: vi.fn().mockResolvedValue(undefined),
	rename: vi.fn().mockResolvedValue(undefined),
	readdir: vi.fn().mockResolvedValue([]),
}));

vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("file-type");
vi.mock("chokidar", () => ({
	watch: vi.fn().mockReturnValue({
		on: vi.fn().mockReturnThis(),
		close: vi.fn().mockResolvedValue(undefined),
	}),
}));

vi.mock("../src/SharedApplicationServer.js", () => ({
	SharedApplicationServer: vi.fn().mockImplementation(() => ({
		initializeFastify: vi.fn(),
		getFastifyInstance: vi
			.fn()
			.mockReturnValue({ get: vi.fn(), post: vi.fn() }),
		start: vi.fn().mockResolvedValue(undefined),
		stop: vi.fn().mockResolvedValue(undefined),
		getWebhookUrl: vi.fn().mockReturnValue("http://localhost:3456/webhook"),
	})),
}));

vi.mock("../src/AgentSessionManager.js", () => ({
	AgentSessionManager: vi.fn().mockImplementation(() => ({
		createCyrusAgentSession: vi.fn(),
		getSession: vi.fn().mockReturnValue({
			id: "session-f1-001",
			issueId: "issue-uuid-9999",
			workspace: { path: "/tmp/ws-f1", isGitWorktree: false },
		}),
		setActivitySink: vi.fn(),
		getAllAgentRunners: vi.fn().mockReturnValue([]),
		getAllSessions: vi.fn().mockReturnValue([]),
		getActiveSessionsByIssueId: vi.fn().mockReturnValue([]),
		removeSession: vi.fn(),
		on: vi.fn(),
		emit: vi.fn(),
		getActiveMultiRepoSessionForRepository: vi.fn().mockReturnValue(null),
		getActiveSessionsByBranchName: vi.fn().mockReturnValue([]),
	})),
}));

vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn().mockReturnValue(false),
		isAgentSessionPromptedWebhook: vi.fn().mockReturnValue(false),
		isIssueAssignedWebhook: vi.fn().mockReturnValue(false),
		isIssueCommentMentionWebhook: vi.fn().mockReturnValue(false),
		isIssueNewCommentWebhook: vi.fn().mockReturnValue(false),
		isIssueUnassignedWebhook: vi.fn().mockReturnValue(false),
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});

// ── Constants ─────────────────────────────────────────────────────────────────

const ISSUE_IDENTIFIER = "BRI-9999";
const ISSUE_ID = "issue-uuid-9999";
const TEAM_ID = "team-uuid-001";
const GITHUB_URL = "https://github.com/Brilliantio/cyrus-agent";
const PRIMARY_REPO_ID = "repo-uuid-primary";
const LINEAR_WORKSPACE_ID = "ws-uuid-test";
const PRINCIPAL_ID = "cyrus-principal-f1-test";
const BEARER_TOKEN = "f1-test-bearer-secret";

const FUTURE_TS = new Date(Date.now() + 3_600_000).toISOString();
const PAST_5M_TS = new Date(Date.now() - 300_000).toISOString();
const PAST_10M_TS = new Date(Date.now() - 600_000).toISOString();

// ── Helpers ───────────────────────────────────────────────────────────────────

function validHandoffPayload(
	startingSha = "b98afde0792b413d",
): Record<string, unknown> {
	return {
		lease_id: "lease-f1-test-001",
		lease_version: "1",
		issue_id: ISSUE_IDENTIFIER,
		owner: "bridge-agent-principal",
		lane: "bridge",
		canonical_repo: "Brilliantio/cyrus-agent",
		worktree: "/tmp/worktrees/BRI-9999",
		branch: "cyrus2/bri-9999-work",
		starting_sha: startingSha,
		scope: ["read:code", "write:code"],
		policy_hash: "sha256:f1policy",
		handoff_target: "cyrus",
		acquired_at: PAST_10M_TS,
		heartbeat_at: PAST_5M_TS,
		expires_at: FUTURE_TS,
		ended_at: null,
	};
}

function buildMarkerBody(payload: Record<string, unknown>): string {
	return `Context\n<!-- CYRUS-MACHINE-HANDOFF\n${JSON.stringify(payload, null, 2)}\n-->`;
}

function fakeComment(id: string, body: string): Comment {
	return {
		id,
		body,
		createdAt: new Date(),
		updatedAt: new Date(),
		user: Promise.resolve(undefined as any),
		parent: Promise.resolve(undefined as any),
		issue: Promise.resolve(undefined as any),
		children: () => Promise.resolve({ nodes: [] }),
	};
}

function buildPrimaryRepo(): RepositoryConfig {
	return {
		id: PRIMARY_REPO_ID,
		name: "cyrus-agent",
		repositoryPath: "/tmp/repos/cyrus-agent",
		workspaceBaseDir: "/tmp/workspaces",
		baseBranch: "main",
		linearWorkspaceId: LINEAR_WORKSPACE_ID,
		isActive: true,
		githubUrl: GITHUB_URL,
		allowedTools: [],
	};
}

// ── Fake paginated issue tracker ──────────────────────────────────────────────

const PAGE2_CURSOR = "cursor-page-2-abc";

function buildPaginatedTracker(
	callLog: string[],
	markerPayload: Record<string, unknown> | null,
): IIssueTrackerService {
	const page1Comments = [
		fakeComment("c-p1-a", "Normal comment."),
		fakeComment("c-p1-b", "Another normal comment."),
	];

	const page2Comments: Comment[] = markerPayload
		? [fakeComment("c-p2-marker", buildMarkerBody(markerPayload))]
		: [fakeComment("c-p2-plain", "No marker here.")];

	const mockIssue: any = {
		id: ISSUE_ID,
		identifier: ISSUE_IDENTIFIER,
		title: "F1 handoff test issue",
		description: "Test issue for BRI-3257 work-lease adoption",
		url: `https://linear.app/brilliantio/issue/${ISSUE_IDENTIFIER}`,
		branchName: "cyrus2/bri-9999-work",
		assigneeId: null,
		stateId: "state-backlog",
		teamId: TEAM_ID,
		labelIds: [],
		priority: 2,
		createdAt: new Date(),
		updatedAt: new Date(),
		archivedAt: null,
		state: Promise.resolve({
			id: "state-backlog",
			name: "Backlog",
			type: "backlog",
		}),
		assignee: Promise.resolve(undefined),
		team: Promise.resolve({ id: TEAM_ID, name: "Brilliantio", key: "BRI" }),
		parent: Promise.resolve(undefined),
		project: Promise.resolve(undefined),
		labels: () => Promise.resolve({ nodes: [] }),
		comments: () => Promise.resolve({ nodes: [] }),
		attachments: () => Promise.resolve({ nodes: [] }),
		children: () => Promise.resolve({ nodes: [] }),
		inverseRelations: () => Promise.resolve({ nodes: [] }),
		update: () => Promise.resolve({ success: true }),
	};

	const workflowStates = [
		{
			id: "state-backlog",
			name: "Backlog",
			type: "backlog",
			description: "",
			color: "#aaa",
			position: 0,
		},
		{
			id: "state-inprogress",
			name: "In Progress",
			type: "started",
			description: "",
			color: "#00f",
			position: 1,
		},
		{
			id: "state-done",
			name: "Done",
			type: "completed",
			description: "",
			color: "#0f0",
			position: 2,
		},
	];

	return {
		fetchIssue: async (_id: string) => mockIssue,

		fetchComments: async (
			_issueId: string,
			options?: PaginationOptions,
		): Promise<Connection<Comment>> => {
			const after = options?.after;
			if (!after) {
				callLog.push("fetchComments:page1");
				return {
					nodes: page1Comments,
					pageInfo: {
						hasNextPage: true,
						hasPreviousPage: false,
						startCursor: "c-p1-a",
						endCursor: PAGE2_CURSOR,
					},
				};
			}
			if (after === PAGE2_CURSOR) {
				callLog.push("fetchComments:page2");
				return {
					nodes: page2Comments,
					pageInfo: {
						hasNextPage: false,
						hasPreviousPage: true,
						startCursor: page2Comments[0]?.id,
						endCursor: page2Comments[0]?.id,
					},
				};
			}
			throw new Error(`Unexpected cursor in test: ${after}`);
		},

		fetchWorkflowStates: async (_teamId: string) => {
			callLog.push("fetchWorkflowStates");
			return { nodes: workflowStates };
		},

		updateIssue: async (_id: string, updates: any) => {
			callLog.push(`updateIssue:${updates.stateId ?? "unknown"}`);
			return mockIssue;
		},

		// Required stubs (not exercised by the handoff path)
		fetchIssueChildren: async () => mockIssue,
		fetchIssueAttachments: async () => [],
		fetchComment: async () => page1Comments[0]!,
		fetchCommentWithAttachments: async () =>
			({ id: "c-p1-a", body: "", attachments: [] }) as any,
		createComment: async () => page1Comments[0]!,
		fetchTeams: async () => ({ nodes: [] }),
		fetchTeam: async () => ({ id: TEAM_ID }) as any,
		fetchLabels: async () => ({ nodes: [] }),
		fetchLabel: async () => ({
			id: "l1",
			name: "test",
			description: "",
			color: "#fff",
		}),
		getIssueLabels: async () => [],
		fetchWorkflowState: async () => workflowStates[0]!,
		fetchUser: async () => ({ id: "u1", name: "Test" }) as any,
		fetchCurrentUser: async () => ({ id: "u1", name: "Test" }) as any,
		createAgentSessionOnIssue: async () =>
			({ agentSessionId: "as-001", success: true }) as any,
		createAgentSessionOnComment: async () =>
			({ agentSessionId: "as-001", success: true }) as any,
		fetchAgentSession: async () => ({ id: "as-001" }) as any,
		emitStopSignalEvent: async () => {},
		createAgentActivity: async () =>
			({ success: true, agentActivity: null }) as any,
		requestFileUpload: async () =>
			({ uploadUrl: "", assetUrl: "", headers: {} }) as any,
		getPlatformType: () => "linear" as const,
		getPlatformMetadata: () => ({}),
		createEventTransport: () => {
			throw new Error("not used");
		},
	} as IIssueTrackerService;
}

// ── Local authority HTTP server ────────────────────────────────────────────────

type AuthHandler = (
	action: string,
	body: Record<string, unknown>,
	respond: (status: number, payload: Record<string, unknown>) => void,
) => void;

async function startAuthServer(handler: AuthHandler): Promise<{
	baseUrl: string;
	close: () => Promise<void>;
}> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk: Buffer) => {
			raw += chunk.toString();
		});
		req.on("end", () => {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(raw);
			} catch {
				res.writeHead(400);
				res.end(JSON.stringify({ ok: false }));
				return;
			}
			const respond = (status: number, payload: Record<string, unknown>) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};
			handler(body.action as string, body, respond);
		});
	});

	await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
	const { port } = server.address() as http.AddressInfo;
	return {
		baseUrl: `http://127.0.0.1:${port}`,
		close: () => new Promise((r, j) => server.close((e) => (e ? j(e) : r()))),
	};
}

// ── Build minimal EdgeWorker ──────────────────────────────────────────────────

function buildWorker(
	fakeTracker: IIssueTrackerService,
	callLog: string[],
): EdgeWorker {
	const primaryRepo = buildPrimaryRepo();

	const config: EdgeWorkerConfig = {
		platform: "cli", // avoids real LinearIssueTrackerService construction
		cyrusHome: TEST_CYRUS_HOME,
		claudeDefaultModel: "claude-sonnet-4-6",
		repositories: [primaryRepo],
		linearWorkspaces: {
			[LINEAR_WORKSPACE_ID]: { linearToken: "test-linear-token-f1" },
		},
		handlers: {
			createWorkspace: async (_issue, _repos, _opts) => {
				callLog.push("createWorkspace");
				return {
					path: "/tmp/ws-f1",
					isGitWorktree: false,
					resolvedBaseBranches: {},
				};
			},
		},
	};

	const worker = new EdgeWorker(config);

	// Inject fake tracker into the SAME map so ActivityPoster also sees it.
	// Use .set() (not map replacement) so the reference in ActivityPoster stays valid.
	(worker as any).issueTrackers.set(LINEAR_WORKSPACE_ID, fakeTracker);

	return worker;
}

// ── Test lifecycle ─────────────────────────────────────────────────────────────

let closeAuthServer: (() => Promise<void>) | null = null;

afterEach(async () => {
	if (closeAuthServer) {
		await closeAuthServer();
		closeAuthServer = null;
	}
	vi.clearAllMocks();
	delete process.env.CYRUS_WORK_LEASE_URL;
	delete process.env.CYRUS_WORK_LEASE_TOKEN;
	delete process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID;
	delete process.env.CYRUS_WORK_LEASE_TTL_SECONDS;
});

// ══════════════════════════════════════════════════════════════════════════════
// A. performHandoffCheck — success path
// ══════════════════════════════════════════════════════════════════════════════

describe("performHandoffCheck — success: page1 → page2(marker) → adopt → get", () => {
	it("fetches both comment pages, adopts, verifies, and returns sha override", async () => {
		const startingSha = "b98afde0792b413d";
		const callLog: string[] = [];
		const adoptedAt = new Date().toISOString();

		const { baseUrl, close } = await startAuthServer(
			(action, _body, respond) => {
				if (action === "adopt") {
					callLog.push("authority:adopt");
					respond(200, {
						ok: true,
						lease_id: "lease-f1-test-001",
						owner: PRINCIPAL_ID,
						adopted_from: "bridge-agent-principal",
						adopted_at: adoptedAt,
						expires_at: FUTURE_TS,
					});
				} else if (action === "get") {
					callLog.push("authority:get");
					respond(200, {
						ok: true,
						lease_id: "lease-f1-test-001",
						owner: PRINCIPAL_ID,
						adopted_from: "bridge-agent-principal",
						adopted_at: adoptedAt,
						expires_at: FUTURE_TS,
					});
				}
			},
		);
		closeAuthServer = close;

		process.env.CYRUS_WORK_LEASE_URL = baseUrl;
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(
			callLog,
			validHandoffPayload(startingSha),
		);
		const worker = buildWorker(fakeTracker, callLog);

		const result = await (worker as any).performHandoffCheck(
			ISSUE_ID,
			ISSUE_IDENTIFIER,
			LINEAR_WORKSPACE_ID,
			buildPrimaryRepo(),
			undefined,
		);

		// Verified sha override returned
		expect(result).toBeInstanceOf(Map);
		expect(result.get(PRIMARY_REPO_ID)).toBe(startingSha);

		// Exact sequence: both pages fetched, then adopt, then get
		expect(callLog).toEqual([
			"fetchComments:page1",
			"fetchComments:page2",
			"authority:adopt",
			"authority:get",
		]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// A. performHandoffCheck — legacy path (no marker)
// ══════════════════════════════════════════════════════════════════════════════

describe("performHandoffCheck — legacy path: no marker", () => {
	it("returns original overrides unmodified and makes no authority calls", async () => {
		const callLog: string[] = [];
		const fakeTracker = buildPaginatedTracker(callLog, null);
		const worker = buildWorker(fakeTracker, callLog);

		const initialOverrides = new Map([["other-repo", "main"]]);
		const result = await (worker as any).performHandoffCheck(
			ISSUE_ID,
			ISSUE_IDENTIFIER,
			LINEAR_WORKSPACE_ID,
			buildPrimaryRepo(),
			initialOverrides,
		);

		expect(result).toBe(initialOverrides); // same reference, unmodified
		expect(callLog).toEqual(["fetchComments:page1", "fetchComments:page2"]);
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// B. createCyrusAgentSession — ordering proof
// performHandoffCheck must run before move-started, workspace, and session
// ══════════════════════════════════════════════════════════════════════════════

describe("createCyrusAgentSession — ordering: handoff check → move-started → workspace → session", () => {
	it("calls performHandoffCheck before state transition, workspace creation, and session creation", async () => {
		const callLog: string[] = [];
		const adoptedAt = new Date().toISOString();

		const { baseUrl, close } = await startAuthServer(
			(action, _body, respond) => {
				if (action === "adopt") {
					callLog.push("authority:adopt");
					respond(200, {
						ok: true,
						lease_id: "lease-f1-test-001",
						owner: PRINCIPAL_ID,
						adopted_from: "bridge-agent-principal",
						adopted_at: adoptedAt,
						expires_at: FUTURE_TS,
					});
				} else if (action === "get") {
					callLog.push("authority:get");
					respond(200, {
						ok: true,
						lease_id: "lease-f1-test-001",
						owner: PRINCIPAL_ID,
						adopted_from: "bridge-agent-principal",
						adopted_at: adoptedAt,
						expires_at: FUTURE_TS,
					});
				}
			},
		);
		closeAuthServer = close;

		process.env.CYRUS_WORK_LEASE_URL = baseUrl;
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(callLog, validHandoffPayload());
		const worker = buildWorker(fakeTracker, callLog);

		// Spy on the internal AgentSessionManager to record session creation
		const asm = (worker as any).agentSessionManager;
		const origCreate = asm.createCyrusAgentSession;
		asm.createCyrusAgentSession = vi.fn((...args: any[]) => {
			callLog.push("session:create");
			return origCreate?.(...args);
		});

		await (worker as any).createCyrusAgentSession(
			"session-f1-ordering-001",
			{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
			buildPrimaryRepo(),
			asm,
			LINEAR_WORKSPACE_ID,
			undefined,
			undefined,
		);

		// Verify key ordering using first-occurrence indices
		const idx = (key: string) => callLog.indexOf(key);

		// Both comment pages fetched (handoff check) before authority calls
		expect(idx("fetchComments:page1")).toBeGreaterThanOrEqual(0);
		expect(idx("fetchComments:page2")).toBeGreaterThanOrEqual(0);
		expect(idx("fetchComments:page1")).toBeLessThan(idx("authority:adopt"));
		expect(idx("authority:adopt")).toBeLessThan(idx("authority:get"));

		// Handoff check fully complete before any state mutation
		expect(idx("authority:get")).toBeLessThan(idx("fetchWorkflowStates"));
		expect(idx("fetchWorkflowStates")).toBeLessThan(
			idx("updateIssue:state-inprogress"),
		);

		// State mutation before workspace creation
		expect(idx("updateIssue:state-inprogress")).toBeLessThan(
			idx("createWorkspace"),
		);

		// Workspace creation before session creation
		expect(idx("createWorkspace")).toBeLessThan(idx("session:create"));
	});
});

// ══════════════════════════════════════════════════════════════════════════════
// C. Failure proofs — zero mutations on every failure path
// ══════════════════════════════════════════════════════════════════════════════

describe("failure proof — missing env vars when marker present", () => {
	it("throws before any state mutation or workspace creation", async () => {
		const callLog: string[] = [];

		// Env vars NOT set
		const fakeTracker = buildPaginatedTracker(callLog, validHandoffPayload());
		const worker = buildWorker(fakeTracker, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-env",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/env vars are missing/i);

		// Comment fetches happened (parsing is fine) but no mutations
		expect(callLog).toContain("fetchComments:page1");
		expect(callLog).toContain("fetchComments:page2");
		expect(callLog).not.toContain("fetchWorkflowStates");
		expect(callLog).not.toContain("createWorkspace");
		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — malformed marker (no closing -->)", () => {
	it("throws before any mutation when the marker has no closing delimiter", async () => {
		const callLog: string[] = [];

		const malformedFetchComments = async (
			_issueId: string,
			options?: PaginationOptions,
		): Promise<Connection<Comment>> => {
			const after = options?.after;
			if (!after) {
				callLog.push("fetchComments:page1");
				return {
					nodes: [fakeComment("c1", "Normal comment")],
					pageInfo: {
						hasNextPage: true,
						hasPreviousPage: false,
						startCursor: "c1",
						endCursor: "cursor-p2",
					},
				};
			}
			callLog.push("fetchComments:page2");
			return {
				nodes: [
					fakeComment("c2", "<!-- CYRUS-MACHINE-HANDOFF\n{not json here"),
				],
				pageInfo: { hasNextPage: false, hasPreviousPage: true },
			};
		};

		const fakeTracker = {
			...buildPaginatedTracker(callLog, null),
			fetchComments: malformedFetchComments,
		};

		process.env.CYRUS_WORK_LEASE_URL = "http://127.0.0.1:19999";
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const worker = buildWorker(fakeTracker as any, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-malformed",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ii]nvalid handoff marker/);

		expect(callLog).not.toContain("fetchWorkflowStates");
		expect(callLog).not.toContain("createWorkspace");
		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — duplicate marker (two comments)", () => {
	it("throws before any mutation when two comments contain the marker", async () => {
		const callLog: string[] = [];
		const body = buildMarkerBody(validHandoffPayload());

		const duplicateFetchComments = async (
			_issueId: string,
			options?: PaginationOptions,
		): Promise<Connection<Comment>> => {
			callLog.push(`fetchComments:${options?.after ? "page2" : "page1"}`);
			return {
				nodes: [fakeComment("c1", body), fakeComment("c2", body)],
				pageInfo: { hasNextPage: false, hasPreviousPage: false },
			};
		};

		const fakeTracker = {
			...buildPaginatedTracker(callLog, null),
			fetchComments: duplicateFetchComments,
		};

		process.env.CYRUS_WORK_LEASE_URL = "http://127.0.0.1:19999";
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const worker = buildWorker(fakeTracker as any, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-dup",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ii]nvalid handoff marker/);

		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — authority returns HTTP 409 (already adopted)", () => {
	it("throws before move-started when authority rejects the adopt", async () => {
		const callLog: string[] = [];

		const { baseUrl, close } = await startAuthServer(
			(action, _body, respond) => {
				if (action === "adopt") {
					callLog.push("authority:adopt-rejected");
					respond(409, { ok: false, error: "already_adopted" });
				}
			},
		);
		closeAuthServer = close;

		process.env.CYRUS_WORK_LEASE_URL = baseUrl;
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(callLog, validHandoffPayload());
		const worker = buildWorker(fakeTracker, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-409",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ll]ease adoption failed/);

		expect(callLog).not.toContain("fetchWorkflowStates");
		expect(callLog).not.toContain("createWorkspace");
		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — cursor cycle (pagination loop)", () => {
	it("throws before any mutation when the cursor repeats", async () => {
		const callLog: string[] = [];

		const cycleFetchComments = async (
			_issueId: string,
			options?: PaginationOptions,
		): Promise<Connection<Comment>> => {
			const after = options?.after;
			const page = !after ? 1 : 2;
			callLog.push(`fetchComments:page${page}`);
			return {
				nodes: [fakeComment(`c-p${page}`, `Comment page ${page}`)],
				pageInfo: {
					hasNextPage: true,
					hasPreviousPage: false,
					startCursor: `c-p${page}`,
					endCursor: "SAME-CURSOR-FOREVER",
				},
			};
		};

		const fakeTracker = {
			...buildPaginatedTracker(callLog, null),
			fetchComments: cycleFetchComments,
		};

		const worker = buildWorker(fakeTracker as any, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-cycle",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/cursor cycle/i);

		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — wrong owner in adopt response", () => {
	it("throws before move-started when authority returns wrong principal", async () => {
		const callLog: string[] = [];
		const adoptedAt = new Date().toISOString();

		const { baseUrl, close } = await startAuthServer(
			(action, _body, respond) => {
				if (action === "adopt") {
					callLog.push("authority:adopt");
					respond(200, {
						ok: true,
						lease_id: "lease-f1-test-001",
						owner: "wrong-principal",
						adopted_from: "bridge-agent-principal",
						adopted_at: adoptedAt,
						expires_at: FUTURE_TS,
					});
				}
			},
		);
		closeAuthServer = close;

		process.env.CYRUS_WORK_LEASE_URL = baseUrl;
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(callLog, validHandoffPayload());
		const worker = buildWorker(fakeTracker, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-owner",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ll]ease adoption failed/);

		expect(callLog).not.toContain("fetchWorkflowStates");
		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — expired lease in handoff marker", () => {
	it("throws before any mutation when marker expires_at is in the past", async () => {
		const callLog: string[] = [];
		const expiredPayload = {
			...validHandoffPayload(),
			acquired_at: new Date(Date.now() - 7_200_000).toISOString(),
			heartbeat_at: new Date(Date.now() - 3_600_000).toISOString(),
			expires_at: new Date(Date.now() - 1_000).toISOString(),
		};

		process.env.CYRUS_WORK_LEASE_URL = "http://127.0.0.1:19999";
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(callLog, expiredPayload);
		const worker = buildWorker(fakeTracker, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-expired",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ii]nvalid handoff marker/);

		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — repo mismatch in handoff marker", () => {
	it("throws before any mutation when canonical_repo does not match primary repo", async () => {
		const callLog: string[] = [];
		const mismatchPayload = {
			...validHandoffPayload(),
			canonical_repo: "OtherOrg/other-repo",
		};

		process.env.CYRUS_WORK_LEASE_URL = "http://127.0.0.1:19999";
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(callLog, mismatchPayload);
		const worker = buildWorker(fakeTracker, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-repo",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ii]nvalid handoff marker/);

		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});

describe("failure proof — issue_id mismatch in handoff marker", () => {
	it("throws before any mutation when marker issue_id does not match the current issue", async () => {
		const callLog: string[] = [];
		const mismatchPayload = {
			...validHandoffPayload(),
			issue_id: "BRI-DIFFERENT",
		};

		process.env.CYRUS_WORK_LEASE_URL = "http://127.0.0.1:19999";
		process.env.CYRUS_WORK_LEASE_TOKEN = BEARER_TOKEN;
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = PRINCIPAL_ID;

		const fakeTracker = buildPaginatedTracker(callLog, mismatchPayload);
		const worker = buildWorker(fakeTracker, callLog);
		const asm = (worker as any).agentSessionManager;

		await expect(
			(worker as any).createCyrusAgentSession(
				"session-fail-issueid",
				{ id: ISSUE_ID, identifier: ISSUE_IDENTIFIER },
				buildPrimaryRepo(),
				asm,
				LINEAR_WORKSPACE_ID,
			),
		).rejects.toThrow(/[Ii]nvalid handoff marker/);

		expect(asm.createCyrusAgentSession).not.toHaveBeenCalled();
	});
});
