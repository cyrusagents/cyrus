/**
 * EdgeWorker-level regressions for per-prompter credentials (CYPACK-1502).
 *
 * These exercise the EdgeWorker methods that sit between the webhook and the
 * runner — not just the pure helpers — for the review findings:
 *   - removing the LAST mapped user (config reload) must turn that user's
 *     pinned sessions into refusals on resume, never host sessions;
 *   - a follow-up on a legacy (unpinned) session is judged by the CURRENT
 *     sender, not the original session creator;
 *   - an unknown sender fails closed under `followUpByOtherUser: reject`;
 *   - an unmapped human triggering a child of a mapped user's issue must not
 *     borrow the parent's credentials.
 */
import { LinearClient } from "@linear/sdk";
import type {
	AgentSessionCreatedWebhook,
	AgentSessionPromptedWebhook,
	CyrusAgentSession,
} from "cyrus-core";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { PrompterCredentialError } from "../src/PrompterCredentialService.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

vi.mock("fs/promises");
vi.mock("@linear/sdk");
vi.mock("cyrus-linear-event-transport");
vi.mock("../src/AgentSessionManager.js");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(function () {
			return {
				loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
				saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
			};
		}),
	};
});

const WS = "test-workspace";
const ADA = "lin-ada";
const BOB = "lin-bob";
const APP_USER = "cyrus-app-user";

const repository: RepositoryConfig = {
	id: "test-repo",
	name: "Test Repo",
	repositoryPath: "/test/repo",
	workspaceBaseDir: "/test/workspaces",
	baseBranch: "main",
	linearWorkspaceId: WS,
	isActive: true,
};

function createdWebhook(creatorId: string): AgentSessionCreatedWebhook {
	return {
		type: "AgentSessionEvent",
		action: "created",
		organizationId: WS,
		appUserId: APP_USER,
		agentSession: {
			id: "sess-1",
			appUserId: APP_USER,
			creatorId,
			creator: { id: creatorId, name: `User ${creatorId}`, email: "" },
			issue: { id: "issue-1", identifier: "TEST-1", title: "t" },
		},
	} as unknown as AgentSessionCreatedWebhook;
}

function promptedWebhook(
	creatorId: string,
	activityUserId: string | undefined,
): AgentSessionPromptedWebhook {
	return {
		...createdWebhook(creatorId),
		action: "prompted",
		agentActivity: {
			id: "act-1",
			userId: activityUserId,
			content: { type: "prompt", body: "go" },
		},
	} as unknown as AgentSessionPromptedWebhook;
}

function session(prompter?: CyrusAgentSession["prompter"]): CyrusAgentSession {
	return { id: "sess-1", prompter } as unknown as CyrusAgentSession;
}

describe("EdgeWorker per-prompter credentials", () => {
	let edgeWorker: EdgeWorker;
	let refusals: string[];
	let thoughts: string[];
	let mockAgentSessionManager: any;

	function makeWorker(overrides: Partial<EdgeWorkerConfig> = {}) {
		const config: EdgeWorkerConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [repository],
			linearWorkspaces: { [WS]: { linearToken: "test-token" } },
			linearUsers: {
				[ADA]: {
					displayName: "Ada",
					claude: { oauthToken: { env: "EW_TEST_ADA_CLAUDE" } },
					github: { token: { env: "EW_TEST_ADA_GH" }, login: "ada" },
				},
			},
			...overrides,
		};
		const worker = new EdgeWorker(config);
		refusals = [];
		thoughts = [];
		vi.spyOn(worker as any, "postPrompterResponse").mockImplementation(
			async (_sid: string, _ws: string, body: string) => {
				refusals.push(body);
			},
		);
		vi.spyOn(
			(worker as any).activityPoster,
			"postThoughtActivity",
		).mockImplementation(async (_sid: string, _ws: string, body: string) => {
			thoughts.push(body);
		});
		return worker;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		process.env.EW_TEST_ADA_CLAUDE = "sk-ant-oat01-ada-placeholder";
		process.env.EW_TEST_ADA_GH = "github_pat_ada_placeholder";

		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			getSessionsByIssueId: vi.fn().mockReturnValue([]),
			getSession: vi.fn().mockReturnValue(undefined),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			on: vi.fn(),
		};
		vi.mocked(AgentSessionManager).mockImplementation(function () {
			return mockAgentSessionManager;
		});
		vi.mocked(SharedApplicationServer).mockImplementation(function () {
			return {
				start: vi.fn().mockResolvedValue(undefined),
				stop: vi.fn().mockResolvedValue(undefined),
				getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
				getWebhookUrl: vi.fn().mockReturnValue("http://localhost/webhook"),
				registerOAuthCallbackHandler: vi.fn(),
			} as any;
		});
		vi.mocked(LinearEventTransport).mockImplementation(function () {
			return {
				register: vi.fn(),
				on: vi.fn(),
				removeAllListeners: vi.fn(),
			} as any;
		});
		vi.mocked(LinearClient).mockImplementation(function () {
			return { users: { me: vi.fn().mockResolvedValue({ id: "me" }) } } as any;
		});
		edgeWorker = makeWorker();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.EW_TEST_ADA_CLAUDE;
		delete process.env.EW_TEST_ADA_GH;
	});

	const resolveForRunner = (s: CyrusAgentSession) =>
		(edgeWorker as any).resolvePrompterCredentialsForRunner(
			s,
			s.id,
			WS,
			"linear",
		) as Promise<unknown>;

	it.each([
		"claude",
		"codex",
		"cursor",
		"gemini",
		"opencode",
	] as const)("resolves personal Claude auth only when the actual resumed runner is %s", async (runnerType) => {
		const worker = edgeWorker as any;
		const pinned = session({
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter",
		});
		pinned[`${runnerType}SessionId` as keyof CyrusAgentSession] =
			"resumed-provider-session" as never;
		vi.spyOn(worker.skillsPluginResolver, "resolve").mockResolvedValue([]);
		vi.spyOn(
			worker.skillsPluginResolver,
			"discoverSkillNames",
		).mockResolvedValue([]);
		vi.spyOn(worker, "resolveSkillRepoPaths").mockReturnValue([]);
		vi.spyOn(worker, "isWarmSessionsEnabled").mockReturnValue(false);
		// Deliberately request a different runner: resume must determine which
		// model credential is consumed, not the current issue's changed label.
		vi.spyOn(
			worker.runnerSelectionService,
			"determineRunnerSelection",
		).mockReturnValue({
			runnerType: runnerType === "claude" ? "codex" : "claude",
		});
		vi.spyOn(worker.runnerConfigBuilder, "buildIssueConfig").mockReturnValue({
			runnerType,
			config: {},
		});
		const resolve = vi.spyOn(worker, "resolvePrompterCredentialsForRunner");
		await worker.buildAgentRunnerConfig(
			pinned,
			repository,
			pinned.id,
			"test",
			[],
			[],
			[],
			undefined,
			[],
			undefined,
			undefined,
			WS,
		);
		expect(resolve).toHaveBeenCalledWith(
			pinned,
			pinned.id,
			WS,
			"linear",
			runnerType === "claude",
		);
	});

	it("resume after the LAST mapped user is removed refuses instead of using host credentials", async () => {
		const pinned = session({
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter",
		});
		const before = await resolveForRunner(pinned);
		expect((before as { env: Record<string, string> }).env.GH_TOKEN).toBe(
			"github_pat_ada_placeholder",
		);

		// Register the real ConfigManager callback while stubbing unrelated startup IO.
		const worker = edgeWorker as any;
		vi.spyOn(worker.defaultSkillsDeployer, "ensureDeployed").mockResolvedValue(
			undefined,
		);
		vi.spyOn(
			worker.skillsPluginResolver,
			"ensureUserPluginScaffolded",
		).mockResolvedValue(undefined);
		vi.spyOn(worker, "loadPersistedState").mockResolvedValue(undefined);
		vi.spyOn(worker, "initializeComponents").mockResolvedValue(undefined);
		vi.spyOn(worker, "isWarmSessionsEnabled").mockReturnValue(false);
		vi.spyOn(worker.configManager, "startConfigWatcher").mockImplementation(
			() => {},
		);
		vi.spyOn(worker.webhookIpValidator, "isEnabled").mockReturnValue(false);
		await edgeWorker.start();
		const reload = worker.configManager.listeners("configChanged")[0];
		await reload({
			added: [],
			removed: [],
			modified: [],
			newConfig: { ...worker.config, linearUsers: {} },
		});
		expect((edgeWorker as any).prompterCredentialService.isEnabled()).toBe(
			false,
		);

		await expect(resolveForRunner(pinned)).rejects.toBeInstanceOf(
			PrompterCredentialError,
		);
		expect(refusals).toHaveLength(1);
		expect(refusals[0]).toContain(ADA);
		expect(refusals[0]).toContain("no entry in linearUsers");
		expect(refusals[0]).not.toContain("placeholder");
		// The follow-up path is governed by the pin too, even with the map empty.
		const allowed = await (edgeWorker as any).applyPrompterFollowUpPolicy(
			pinned,
			promptedWebhook(ADA, BOB),
			{ id: BOB, name: "Bob" },
			WS,
		);
		expect(allowed).toBe(false); // no streaming into a removed user
		expect(refusals.at(-1)).toContain("no entry in linearUsers");
	});

	it("a recovered prompted session uses the current sender and never the original creator", async () => {
		const result = await (edgeWorker as any).decidePrompterForNewSession(
			promptedWebhook(ADA, BOB),
			WS,
		);
		expect(result).toEqual({ ok: false });
		expect(refusals[0]).toContain(BOB);
	});

	it("a missing sender cannot inherit a known parent's credentials", async () => {
		(edgeWorker as any).globalSessionRegistry.setParentSession(
			"sess-1",
			"parent-sess",
		);
		mockAgentSessionManager.getSession.mockReturnValue(
			session({
				linearUserId: ADA,
				credentialUserId: ADA,
				source: "prompter",
			}),
		);
		const result = await (edgeWorker as any).decidePrompterForNewSession(
			promptedWebhook(ADA, undefined),
			WS,
		);
		expect(result).toEqual({ ok: false });
	});

	it("skips host prewarming while mapped credentials exist, including removed-user pins", async () => {
		const worker = edgeWorker as any;
		mockAgentSessionManager.getAllSessions = vi.fn().mockReturnValue([]);
		await worker.warmupRecentSessions();
		expect(mockAgentSessionManager.getAllSessions).not.toHaveBeenCalled();
		const noMapping = makeWorker({ linearUsers: undefined }) as any;
		mockAgentSessionManager.getAllSessions.mockReturnValue([
			{
				...session({
					linearUserId: ADA,
					credentialUserId: ADA,
					source: "prompter",
				}),
				claudeSessionId: "claude-session",
				workspace: { path: "/tmp/workspace" },
			},
		]);
		const buildMcp = vi.spyOn(noMapping.mcpConfigService, "buildMcpConfig");
		await noMapping.warmupRecentSessions();
		expect(buildMcp).not.toHaveBeenCalled();
	});

	it("filters mapped env secrets from every shared chat runner", () => {
		const worker = edgeWorker as any;
		const factory = vi.spyOn(worker, "createRunnerForType").mockReturnValue({});
		const deps = worker.buildChatSessionHandlerDeps({}, () => undefined);
		deps.createRunner({}, "claude");
		expect(factory).toHaveBeenCalledWith(
			"claude",
			expect.objectContaining({
				omitEnv: expect.arrayContaining([
					"EW_TEST_ADA_CLAUDE",
					"EW_TEST_ADA_GH",
				]),
			}),
		);
		for (const runnerType of ["opencode", "codex", "cursor", "gemini"]) {
			deps.createRunner({}, runnerType);
			expect(factory).toHaveBeenLastCalledWith(
				runnerType,
				expect.objectContaining({
					omitEnv: expect.arrayContaining([
						"EW_TEST_ADA_CLAUDE",
						"EW_TEST_ADA_GH",
					]),
				}),
			);
		}
	});

	it("a pin-less session stays untouched when the feature is off", async () => {
		const worker = makeWorker({ linearUsers: undefined });
		const result = await (worker as any).resolvePrompterCredentialsForRunner(
			session(undefined),
			"sess-1",
			WS,
			"linear",
		);
		expect(result).toBeUndefined();
		expect(refusals).toHaveLength(0);
	});

	it("judges a follow-up on a legacy (unpinned) session by the CURRENT sender, not the creator", async () => {
		// Session created by mapped Ada before linearUsers existed (no pin);
		// unmapped Bob sends the next prompt → Bob is evaluated → reject.
		const legacy = session(undefined);
		const allowed = await (edgeWorker as any).applyPrompterFollowUpPolicy(
			legacy,
			promptedWebhook(ADA, BOB),
			{ id: BOB, name: "Bob" },
			WS,
		);
		expect(allowed).toBe(false);
		expect(legacy.prompter).toBeUndefined();
		expect(refusals[0]).toContain("Bob");
		expect(refusals[0]).toContain("cyrus add-user");

		// Mapped Ada sending the next prompt pins the legacy session to Ada.
		const legacy2 = session(undefined);
		const ok = await (edgeWorker as any).applyPrompterFollowUpPolicy(
			legacy2,
			promptedWebhook(BOB, ADA),
			{ id: ADA, name: "Ada" },
			WS,
		);
		expect(ok).toBe(true);
		expect(legacy2.prompter?.credentialUserId).toBe(ADA);
	});

	it("an unknown sender is refused under followUpByOtherUser=reject and never assumed to be the pinned user", async () => {
		const worker = makeWorker({
			prompterCredentialPolicy: { followUpByOtherUser: "reject" },
		});
		const pinned = session({
			linearUserId: ADA,
			credentialUserId: ADA,
			source: "prompter",
		});
		// Payload with no activity user and no fetched comment author.
		const allowed = await (worker as any).applyPrompterFollowUpPolicy(
			pinned,
			promptedWebhook(ADA, undefined),
			null,
			WS,
		);
		expect(allowed).toBe(false);
		expect(refusals[0]).toContain("could not determine who sent");
		// A legacy session + unknown sender falls to the non-human policy (reject).
		const legacy = session(undefined);
		const allowed2 = await (worker as any).applyPrompterFollowUpPolicy(
			legacy,
			promptedWebhook(ADA, undefined),
			null,
			WS,
		);
		expect(allowed2).toBe(false);
		expect(legacy.prompter).toBeUndefined();
	});

	it("an unmapped human triggering a child of a mapped user's issue does not inherit the parent's credentials", async () => {
		// Child session sess-1 is linked to parent session pinned to Ada.
		(edgeWorker as any).globalSessionRegistry.setParentSession(
			"sess-1",
			"parent-sess",
		);
		mockAgentSessionManager.getSession.mockImplementation((id: string) =>
			id === "parent-sess"
				? session({
						linearUserId: ADA,
						credentialUserId: ADA,
						source: "prompter",
					})
				: undefined,
		);
		const human = await (edgeWorker as any).decidePrompterForNewSession(
			createdWebhook(BOB),
			WS,
		);
		expect(human).toEqual({ ok: false });
		expect(refusals[0]).toContain("User lin-bob");

		// Cyrus delegating the sub-issue to itself (non-human) does inherit.
		const nonHuman = await (edgeWorker as any).decidePrompterForNewSession(
			createdWebhook(APP_USER),
			WS,
		);
		expect(nonHuman.ok).toBe(true);
		expect(nonHuman.prompter?.credentialUserId).toBe(ADA);
		expect(nonHuman.prompter?.source).toBe("parent");
	});
});
