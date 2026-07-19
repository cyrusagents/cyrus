import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	SessionOrchestrator,
	type SessionOrchestratorDeps,
	type StartGitHubSessionRequest,
	type StartSessionRequest,
} from "../src/SessionOrchestrator.js";

// Shared mutable state for the runner mocks (hoisted so vi.mock factories see it).
const h = vi.hoisted(() => ({
	created: [] as any[],
	behavior: { current: null as any },
}));

vi.mock("node:fs/promises", () => ({
	mkdir: vi.fn(async () => undefined),
}));
vi.mock("cyrus-claude-runner", () => ({
	ClaudeRunner: vi.fn(function (this: any, config: any) {
		Object.assign(this, h.behavior.current, { config, kind: "claude" });
		h.created.push(this);
	}),
}));
vi.mock("cyrus-cursor-runner", () => ({
	CursorRunner: vi.fn(function (this: any, config: any) {
		Object.assign(this, h.behavior.current, { config, kind: "cursor" });
		h.created.push(this);
	}),
}));

function makeLogger(): any {
	const logger: any = {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
	logger.withContext = vi.fn(() => logger);
	return logger;
}

const REPO = {
	id: "repo-1",
	name: "Repo One",
	repositoryPath: "/repo",
	linearWorkspaceId: "ws-1",
} as any;

function makeSessionData(session: any) {
	return {
		session,
		fullIssue: {
			id: "issue-1",
			identifier: "ISS-1",
			description: "desc",
		},
		workspace: { path: "/repo/wt/ISS-1", resolvedBaseBranches: {} },
		attachmentResult: { manifest: "MANIFEST", attachmentsDir: null },
		attachmentsDir: "/attach",
		allowedDirectories: ["/repo"],
		allowedTools: ["Read"],
		disallowedTools: [],
		labels: [],
	};
}

function makeDeps(overrides: Partial<SessionOrchestratorDeps> = {}): {
	deps: SessionOrchestratorDeps;
	buildIssueConfig: any;
	warmPool: any;
	runnerType: { current: "claude" | "cursor" };
} {
	const runnerType = { current: "claude" as "claude" | "cursor" };
	const buildIssueConfig = vi.fn((input: any) => ({
		config: { model: "m", _input: input } as any,
		runnerType: runnerType.current,
	}));
	const warmPool = {
		isEnabled: vi.fn(() => false),
		acquireWarm: vi.fn(() => undefined),
		release: vi.fn(),
	};

	const session = {
		id: "sess-1",
		issueContext: { issueId: "issue-1", issueIdentifier: "ISS-1" },
		workspace: { path: "/repo/wt/ISS-1" },
		agentRunner: undefined,
	};

	const deps: SessionOrchestratorDeps = {
		logger: makeLogger(),
		cyrusHome: "/home/u/.cyrus",
		agentSessionManager: {
			addAgentRunner: vi.fn(),
			handleClaudeMessage: vi.fn(async () => {}),
			failSession: vi.fn(async () => {}),
			markSessionActive: vi.fn(async () => {}),
			getSession: vi.fn(() => undefined),
			getActiveSessionsByBranchName: vi.fn(() => []),
			createCyrusAgentSession: vi.fn(),
			setActivitySink: vi.fn(),
		} as any,
		warmPool: warmPool as any,
		runnerConfigBuilder: { buildIssueConfig } as any,
		skillsPluginResolver: {
			resolve: vi.fn(async () => []),
			discoverSkillNames: vi.fn(async () => []),
		} as any,
		gitService: {
			getGitMetadataDirectoriesForWorkspace: vi.fn(() => []),
		} as any,
		promptAssembler: {
			assemble: vi.fn(async () => ({
				userPrompt: "USER_PROMPT",
				systemPrompt: "SYS",
				metadata: { components: [], promptType: "builder" },
			})),
		} as any,
		getConfig: vi.fn(() => ({}) as any),
		getClaudeSessionStore: vi.fn(() => null),
		getWarmSessionRegistry: vi.fn(() => ({
			markIdle: vi.fn(),
			remove: vi.fn(),
			setMaxIdleSessions: vi.fn(),
			getMaxIdleSessions: vi.fn(() => 0),
			idleCount: 0,
		})),
		getSandboxSettings: vi.fn(() => undefined),
		getEgressCaCertPath: vi.fn(() => undefined),
		createCyrusAgentSession: vi.fn(async () => makeSessionData(session) as any),
		buildSessionPrompt: vi.fn(async () => "RESUME_PROMPT"),
		maybeSummarizeColdResume: vi.fn(async () => undefined),
		determineSystemPromptFromLabels: vi.fn(async () => undefined),
		buildAllowedTools: vi.fn(() => ["Read"]),
		buildDisallowedTools: vi.fn(() => []),
		buildSkillSessionContext: vi.fn(() => ({
			repositoryId: "repo-1",
			repoPaths: ["/repo"],
		})),
		resolveSkillRepoPaths: vi.fn(() => ["/repo"]),
		fetchFullIssueDetails: vi.fn(async () => ({
			id: "issue-1",
			identifier: "ISS-1",
			description: "desc",
		})) as any,
		fetchIssueLabels: vi.fn(async () => []),
		createAskUserQuestionCallback: vi.fn(() => async () => ({}) as any),
		savePersistedState: vi.fn(async () => {}),
		postInstantAcknowledgment: vi.fn(async () => {}),
		postSystemPromptSelectionThought: vi.fn(async () => {}),
		emitSessionStarted: vi.fn(),
		resumeSessionDelegate: vi.fn(async () => {}),
		getRepositoryForSession: vi.fn(() => REPO),
		getIssueTracker: vi.fn(() => undefined),
		postParentResumeAcknowledgment: vi.fn(async () => {}),
		postActivityDirect: vi.fn(async () => null),
		getGitHubAppTokenProvider: vi.fn(() => null),
		getAllRepositories: vi.fn(() => [REPO]),
		gitHubCommentService: {
			postIssueComment: vi.fn(async () => ({}) as any),
			postReviewCommentReply: vi.fn(async () => ({}) as any),
			addReaction: vi.fn(async () => ({}) as any),
		} as any,
		setSessionRepository: vi.fn(),
		getActivitySinkForRepo: vi.fn(() => undefined),
		buildGithubAllowedTools: vi.fn(() => ["Read"]),
		emitGitHubSessionStarted: vi.fn(),
		...overrides,
	};
	return { deps, buildIssueConfig, warmPool, runnerType };
}

const START_REQ = (_session: any): StartSessionRequest => ({
	agentSession: {
		id: "sess-1",
		issue: { id: "issue-1", identifier: "ISS-1" },
	} as any,
	repositories: [REPO],
	linearWorkspaceId: "ws-1",
});

function makeGitHubEvent(overrides: any = {}): any {
	return {
		eventType: "issue_comment",
		deliveryId: "delivery-1",
		payload: {
			action: "created",
			issue: {
				number: 42,
				pull_request: {
					url: "https://api.github.com/repos/org/repo/pulls/42",
				},
			},
			comment: {
				id: 555,
				body: "@cyrusagent do the thing",
				user: { login: "commenter" },
				html_url: "https://github.com/org/repo/pull/42#issuecomment-555",
			},
			repository: {
				full_name: "org/repo",
				name: "repo",
				owner: { login: "org" },
			},
		},
		...overrides,
	};
}

function makeGithubReq(overrides: any = {}): StartGitHubSessionRequest {
	return {
		event: makeGitHubEvent(),
		repository: REPO,
		workspace: { path: "/repo/wt/pr-42", isGitWorktree: true },
		branchRef: "feature-branch",
		baseBranchRef: "main",
		prNumber: 42,
		sessionKey: "github:org/repo#42",
		prTitle: "Fix the bug",
		taskInstructions: "do the thing",
		systemPrompt: "SYS_PROMPT",
		...overrides,
	};
}

describe("SessionOrchestrator", () => {
	beforeEach(() => {
		h.created.length = 0;
		h.behavior.current = {
			supportsStreamingInput: true,
			startStreaming: vi.fn(async () => ({ sessionId: "runner-sess" })),
			start: vi.fn(async () => ({ sessionId: "runner-sess" })),
			updatePromptVersions: vi.fn(),
		};
	});

	describe("startSession", () => {
		it("assembles the prompt, builds config, creates the runner and starts streaming", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);

			await orch.startSession(START_REQ(null));

			expect(deps.postInstantAcknowledgment).toHaveBeenCalledWith(
				"sess-1",
				"ws-1",
			);
			expect(deps.createCyrusAgentSession).toHaveBeenCalledTimes(1);
			expect(deps.promptAssembler.assemble).toHaveBeenCalledTimes(1);
			expect(h.created).toHaveLength(1);
			expect(h.created[0].kind).toBe("claude");
			expect(deps.agentSessionManager.addAgentRunner).toHaveBeenCalledWith(
				"sess-1",
				h.created[0],
			);
			expect(deps.savePersistedState).toHaveBeenCalled();
			expect(deps.emitSessionStarted).toHaveBeenCalledWith(
				"issue-1",
				expect.objectContaining({ id: "issue-1" }),
				"repo-1",
			);
			expect(h.created[0].startStreaming).toHaveBeenCalledWith("USER_PROMPT");
		});

		it("omits the Linear agent-session marker from delegation prompts", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);

			await orch.startSession({
				...START_REQ(null),
				commentBody: "This thread is for an agent session with cyrusagent.",
			});

			const assemblyInput = vi.mocked(deps.promptAssembler.assemble).mock
				.calls[0]?.[0];
			expect(assemblyInput?.userComment).toBe("");
			expect(assemblyInput?.isMentionTriggered).toBe(false);
		});

		it("falls back to non-streaming start when the runner does not support streaming", async () => {
			h.behavior.current.supportsStreamingInput = false;
			h.behavior.current.startStreaming = undefined;
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);

			await orch.startSession(START_REQ(null));

			expect(h.created[0].start).toHaveBeenCalledWith("USER_PROMPT");
		});

		it("does not fail startSession when the instant acknowledgment rejects", async () => {
			const { deps } = makeDeps();
			// Ack is fire-and-forget: a rejection must not abort session creation.
			vi.mocked(deps.postInstantAcknowledgment).mockRejectedValueOnce(
				new Error("linear down"),
			);
			const orch = new SessionOrchestrator(deps);

			await expect(orch.startSession(START_REQ(null))).resolves.toBeUndefined();

			// The session was still created and streaming still started.
			expect(deps.createCyrusAgentSession).toHaveBeenCalledTimes(1);
			expect(h.created[0].startStreaming).toHaveBeenCalledWith("USER_PROMPT");
			// It should not have been awaited: labels are never re-fetched here.
			expect(deps.fetchIssueLabels).not.toHaveBeenCalled();
		});

		it("consumes labels from the created session data instead of re-fetching", async () => {
			const { deps } = makeDeps();
			const sessionData = makeSessionData({
				id: "sess-1",
				issueContext: { issueId: "issue-1", issueIdentifier: "ISS-1" },
				workspace: { path: "/repo/wt/ISS-1" },
				agentRunner: undefined,
			});
			// createCyrusAgentSession returns labels fetched during session creation.
			vi.mocked(deps.createCyrusAgentSession).mockImplementationOnce(
				async () =>
					({
						...sessionData,
						labels: ["bug", "backend"],
					}) as any,
			);
			const orch = new SessionOrchestrator(deps);

			await orch.startSession(START_REQ(null));

			// No second round-trip for labels.
			expect(deps.fetchIssueLabels).not.toHaveBeenCalled();
			const assemblyInput = vi.mocked(deps.promptAssembler.assemble).mock
				.calls[0]?.[0];
			expect(assemblyInput?.labels).toEqual(["bug", "backend"]);
		});
	});

	describe("resumeSession", () => {
		it("passes resumeSessionId=undefined when the session has no prior runner session (needsNewSession)", async () => {
			const { deps, buildIssueConfig } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const session: any = {
				id: "sess-1",
				issueContext: { issueId: "issue-1" },
				workspace: { path: "/repo/wt/ISS-1" },
			};

			await orch.resumeSession(
				session,
				REPO,
				"sess-1",
				deps.agentSessionManager,
				"follow-up",
				"",
				false,
				[],
				"ws-1",
			);

			expect(buildIssueConfig.mock.calls[0][0].resumeSessionId).toBeUndefined();
		});

		it("passes the existing claude session id as resumeSessionId (resume branch)", async () => {
			const { deps, buildIssueConfig } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const session: any = {
				id: "sess-1",
				issueContext: { issueId: "issue-1" },
				workspace: { path: "/repo/wt/ISS-1" },
				claudeSessionId: "claude-existing",
			};

			await orch.resumeSession(
				session,
				REPO,
				"sess-1",
				deps.agentSessionManager,
				"follow-up",
				"",
				false,
				[],
				"ws-1",
			);

			expect(buildIssueConfig.mock.calls[0][0].resumeSessionId).toBe(
				"claude-existing",
			);
			expect(deps.agentSessionManager.addAgentRunner).toHaveBeenCalled();
			expect(h.created[0].startStreaming).toHaveBeenCalledWith("RESUME_PROMPT");
		});
	});

	describe("session keep-alive resolution", () => {
		const startWithConfig = async (config: Record<string, unknown>) => {
			const { deps, buildIssueConfig } = makeDeps({
				getConfig: vi.fn(() => config as any),
			} as any);
			const orch = new SessionOrchestrator(deps);
			await orch.startSession(START_REQ(null));
			return buildIssueConfig.mock.calls[0][0].sessionKeepAliveMs;
		};

		it("keeps sessions alive for 50 minutes by default", async () => {
			// Under the 1h prompt-cache TTL, so a follow-up appends to a still-warm
			// conversation instead of paying to re-write it.
			expect(await startWithConfig({})).toBe(50 * 60_000);
		});

		it("honors a configured window", async () => {
			expect(await startWithConfig({ claudeSessionKeepAliveMinutes: 5 })).toBe(
				5 * 60_000,
			);
		});

		it("treats 0 as opting out (session shuts down when its turn ends)", async () => {
			expect(
				await startWithConfig({ claudeSessionKeepAliveMinutes: 0 }),
			).toBeUndefined();
		});

		it("forwards the shared warm-session registry to the runner config", async () => {
			const registry = { markIdle: vi.fn(), remove: vi.fn() };
			const { deps, buildIssueConfig } = makeDeps({
				getConfig: vi.fn(() => ({}) as any),
				getWarmSessionRegistry: vi.fn(() => registry),
			} as any);
			const orch = new SessionOrchestrator(deps);
			await orch.startSession(START_REQ(null));
			expect(buildIssueConfig.mock.calls[0][0].warmSessionRegistry).toBe(
				registry,
			);
		});
	});

	describe("resumeSession serialization", () => {
		const tick = () => new Promise((r) => setTimeout(r, 0));

		function deferred<T>() {
			let resolve!: (value: T) => void;
			const promise = new Promise<T>((res) => {
				resolve = res;
			});
			return { promise, resolve };
		}

		const ISSUE = { id: "issue-1", identifier: "ISS-1", description: "desc" };

		const resume = (orch: SessionOrchestrator, session: any, deps: any) =>
			orch.resumeSession(
				session,
				REPO,
				session.id,
				deps.agentSessionManager,
				"follow-up",
				"",
				false,
				[],
				"ws-1",
			);

		it("does not start a second resume for a session until the first finishes", async () => {
			const gate = deferred<any>();
			let fetches = 0;
			const fetchFullIssueDetails = vi.fn(async () => {
				fetches++;
				return fetches === 1 ? gate.promise : ISSUE;
			});
			const { deps } = makeDeps({ fetchFullIssueDetails } as any);
			const orch = new SessionOrchestrator(deps);
			const session: any = {
				id: "sess-1",
				issueContext: { issueId: "issue-1" },
				workspace: { path: "/repo/wt/ISS-1" },
				claudeSessionId: "claude-existing",
			};

			const p1 = resume(orch, session, deps);
			const p2 = resume(orch, session, deps);
			await tick();

			// The second resume is still queued behind the first.
			expect(fetchFullIssueDetails).toHaveBeenCalledTimes(1);

			gate.resolve(ISSUE);
			await Promise.all([p1, p2]);
			expect(fetchFullIssueDetails).toHaveBeenCalledTimes(2);
		});

		it("lets the queued resume append to the first resume's runner instead of spawning a second", async () => {
			// Mirror the real AgentSessionManager: registering a runner attaches it
			// to the session, so a later resume can see it is already running.
			const session: any = {
				id: "sess-1",
				issueContext: { issueId: "issue-1" },
				workspace: { path: "/repo/wt/ISS-1" },
				claudeSessionId: "claude-existing",
			};
			const addStreamMessage = vi.fn();
			h.behavior.current = {
				...h.behavior.current,
				isRunning: vi.fn(() => true),
				addStreamMessage,
			};
			const gate = deferred<any>();
			let fetches = 0;
			const fetchFullIssueDetails = vi.fn(async () => {
				fetches++;
				return fetches === 1 ? gate.promise : ISSUE;
			});
			const { deps } = makeDeps({ fetchFullIssueDetails } as any);
			(deps.agentSessionManager.addAgentRunner as any).mockImplementation(
				(_id: string, runner: any) => {
					session.agentRunner = runner;
				},
			);
			const orch = new SessionOrchestrator(deps);

			const p1 = resume(orch, session, deps);
			const p2 = resume(orch, session, deps);
			gate.resolve(ISSUE);
			await Promise.all([p1, p2]);

			// Without serialization both resumes would have built their own runner,
			// each re-writing the whole conversation to the prompt cache.
			expect(h.created).toHaveLength(1);
			expect(addStreamMessage).toHaveBeenCalledTimes(1);
			expect(addStreamMessage).toHaveBeenCalledWith("follow-up");
		});

		it("does not serialize resumes for different sessions", async () => {
			const gate = deferred<any>();
			const fetchFullIssueDetails = vi.fn(async () => gate.promise);
			const { deps } = makeDeps({ fetchFullIssueDetails } as any);
			const orch = new SessionOrchestrator(deps);
			const mk = (id: string) => ({
				id,
				issueContext: { issueId: "issue-1" },
				workspace: { path: "/repo/wt/ISS-1" },
				claudeSessionId: "claude-existing",
			});

			const p1 = resume(orch, mk("sess-1"), deps);
			const p2 = resume(orch, mk("sess-2"), deps);
			await tick();

			expect(fetchFullIssueDetails).toHaveBeenCalledTimes(2);
			gate.resolve(ISSUE);
			await Promise.all([p1, p2]);
		});

		it("runs a queued resume after the previous one rejects", async () => {
			let fetches = 0;
			const fetchFullIssueDetails = vi.fn(async () => {
				fetches++;
				if (fetches === 1) throw new Error("fetch blew up");
				return ISSUE;
			});
			const { deps } = makeDeps({ fetchFullIssueDetails } as any);
			const orch = new SessionOrchestrator(deps);
			const session: any = {
				id: "sess-1",
				issueContext: { issueId: "issue-1" },
				workspace: { path: "/repo/wt/ISS-1" },
				claudeSessionId: "claude-existing",
			};

			const p1 = resume(orch, session, deps);
			const p2 = resume(orch, session, deps);

			await expect(p1).rejects.toThrow("fetch blew up");
			await expect(p2).resolves.toBeUndefined();
			expect(h.created).toHaveLength(1);
		});
	});

	describe("handlePromptWithStreamingCheck", () => {
		it("appends to the active stream and returns true (no resume)", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const addStreamMessage = vi.fn();
			const session: any = {
				id: "sess-1",
				agentRunner: {
					isRunning: () => true,
					supportsStreamingInput: true,
					addStreamMessage,
				},
			};

			const result = await orch.handlePromptWithStreamingCheck(
				session,
				REPO,
				"sess-1",
				deps.agentSessionManager,
				"hello",
				"ATT",
				false,
				[],
				"prompted",
				"ws-1",
			);

			expect(result).toBe(true);
			expect(addStreamMessage).toHaveBeenCalledWith("hello\n\nATT");
			expect(deps.resumeSessionDelegate).not.toHaveBeenCalled();
			// An idle-warm session sits at Complete; appending puts it back to work.
			expect(deps.agentSessionManager.markSessionActive).toHaveBeenCalledWith(
				"sess-1",
			);
		});

		it("still appends when marking the session active fails", async () => {
			const { deps } = makeDeps();
			(deps.agentSessionManager.markSessionActive as any).mockRejectedValueOnce(
				new Error("tracker down"),
			);
			const orch = new SessionOrchestrator(deps);
			const addStreamMessage = vi.fn();
			const session: any = {
				id: "sess-1",
				agentRunner: {
					isRunning: () => true,
					supportsStreamingInput: true,
					addStreamMessage,
				},
			};

			// A status-update failure must not be mistaken for a rejected message
			// and send an already-appended prompt down the resume path.
			await expect(
				orch.handlePromptWithStreamingCheck(
					session,
					REPO,
					"sess-1",
					deps.agentSessionManager,
					"hello",
					"",
					false,
					[],
					"prompted",
					"ws-1",
				),
			).rejects.toThrow("tracker down");
			expect(addStreamMessage).toHaveBeenCalledTimes(1);
			expect(deps.resumeSessionDelegate).not.toHaveBeenCalled();
		});

		it("resumes and returns false when no runner is streaming", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const session: any = { id: "sess-1", agentRunner: undefined };

			const result = await orch.handlePromptWithStreamingCheck(
				session,
				REPO,
				"sess-1",
				deps.agentSessionManager,
				"hello",
				"",
				false,
				[],
				"prompted",
				"ws-1",
			);

			expect(result).toBe(false);
			expect(deps.resumeSessionDelegate).toHaveBeenCalledTimes(1);
			// promptBody is the 5th positional arg to the resume delegate.
			expect((deps.resumeSessionDelegate as any).mock.calls[0][4]).toBe(
				"hello",
			);
		});

		it("falls through to resume when addStreamMessage throws", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const session: any = {
				id: "sess-1",
				agentRunner: {
					isRunning: () => true,
					supportsStreamingInput: true,
					addStreamMessage: vi.fn(() => {
						throw new Error("turn ended");
					}),
				},
			};

			const result = await orch.handlePromptWithStreamingCheck(
				session,
				REPO,
				"sess-1",
				deps.agentSessionManager,
				"hello",
				"",
				false,
				[],
				"prompted",
				"ws-1",
			);

			expect(result).toBe(false);
			expect(deps.resumeSessionDelegate).toHaveBeenCalledTimes(1);
		});
	});

	describe("handleSessionError", () => {
		it("surfaces a genuine crash, reclaims the warm slot and persists", async () => {
			const { deps, warmPool } = makeDeps();
			const orch = new SessionOrchestrator(deps);

			await orch.handleSessionError(
				new Error("Claude Code process exited with code 1"),
				"sess-1",
				"repo-1",
			);

			expect(deps.agentSessionManager.failSession).toHaveBeenCalledTimes(1);
			expect(warmPool.release).toHaveBeenCalledWith("sess-1");
			expect(deps.savePersistedState).toHaveBeenCalled();
		});

		it("is a no-op on AbortError", async () => {
			const { deps, warmPool } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const err = new Error("aborted by user");
			err.name = "AbortError";

			await orch.handleSessionError(err, "sess-1", "repo-1");

			expect(deps.agentSessionManager.failSession).not.toHaveBeenCalled();
			expect(warmPool.release).not.toHaveBeenCalled();
			expect(deps.savePersistedState).not.toHaveBeenCalled();
		});

		it("is a no-op on graceful SIGTERM (exit code 143)", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);

			await orch.handleSessionError(
				new Error("Claude Code process exited with code 143"),
				"sess-1",
			);

			expect(deps.agentSessionManager.failSession).not.toHaveBeenCalled();
		});

		it("only logs when no session id is available", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);

			await orch.handleSessionError(new Error("background boom"));

			expect(deps.agentSessionManager.failSession).not.toHaveBeenCalled();
			expect(deps.savePersistedState).not.toHaveBeenCalled();
		});
	});

	describe("buildAgentRunnerConfig warm attach", () => {
		it("attaches the warm slot to a claude runner config", async () => {
			const { deps, warmPool, runnerType } = makeDeps();
			runnerType.current = "claude";
			const warm = { id: "warm-1" };
			warmPool.acquireWarm.mockReturnValue(warm);
			const orch = new SessionOrchestrator(deps);

			const { config } = await orch.buildAgentRunnerConfig(
				{ id: "sess-1", workspace: { path: "/repo/wt" } } as any,
				REPO,
				"sess-1",
				"SYS",
				["Read"],
				["/repo"],
				[],
			);

			expect(warmPool.acquireWarm).toHaveBeenCalledWith("sess-1");
			expect((config as any).warmSession).toBe(warm);
		});

		it("does NOT attach a warm slot to a cursor runner config", async () => {
			const { deps, warmPool, runnerType } = makeDeps();
			runnerType.current = "cursor";
			warmPool.acquireWarm.mockReturnValue({ id: "warm-1" });
			const orch = new SessionOrchestrator(deps);

			const { config } = await orch.buildAgentRunnerConfig(
				{ id: "sess-1", workspace: { path: "/repo/wt" } } as any,
				REPO,
				"sess-1",
				"SYS",
				["Read"],
				["/repo"],
				[],
			);

			expect((config as any).warmSession).toBeUndefined();
		});
	});

	describe("resolveGitHubToken", () => {
		it("prefers the forwarded installationToken over the App provider and env var", async () => {
			const { deps } = makeDeps();
			const orch = new SessionOrchestrator(deps);
			const event = makeGitHubEvent({ installationToken: "forwarded-token" });

			await expect(orch.resolveGitHubToken(event)).resolves.toBe(
				"forwarded-token",
			);
		});

		it("falls back to the App token provider when no installationToken is forwarded", async () => {
			const getToken = vi.fn(async () => "app-minted-token");
			const { deps } = makeDeps({
				getGitHubAppTokenProvider: vi.fn(() => ({ getToken }) as any),
			});
			const orch = new SessionOrchestrator(deps);

			await expect(orch.resolveGitHubToken(makeGitHubEvent())).resolves.toBe(
				"app-minted-token",
			);
		});

		it("falls back to GITHUB_TOKEN when there is no installationToken or App provider", async () => {
			const prev = process.env.GITHUB_TOKEN;
			process.env.GITHUB_TOKEN = "pat-token";
			try {
				const { deps } = makeDeps();
				const orch = new SessionOrchestrator(deps);

				await expect(orch.resolveGitHubToken(makeGitHubEvent())).resolves.toBe(
					"pat-token",
				);
			} finally {
				process.env.GITHUB_TOKEN = prev;
			}
		});

		it("falls back to GITHUB_TOKEN when the App provider throws", async () => {
			const prev = process.env.GITHUB_TOKEN;
			process.env.GITHUB_TOKEN = "pat-token";
			try {
				const { deps } = makeDeps({
					getGitHubAppTokenProvider: vi.fn(
						() =>
							({
								getToken: vi.fn(async () => {
									throw new Error("mint failed");
								}),
							}) as any,
					),
				});
				const orch = new SessionOrchestrator(deps);

				await expect(orch.resolveGitHubToken(makeGitHubEvent())).resolves.toBe(
					"pat-token",
				);
			} finally {
				process.env.GITHUB_TOKEN = prev;
			}
		});
	});

	describe("createGitHubWorkspace", () => {
		it("creates a worktree via gitService with all configured repos as cross-repo siblings", async () => {
			const createGitWorktree = vi.fn(async () => ({
				path: "/repo/wt/pr-42",
				isGitWorktree: true,
			}));
			const REPO_2 = { ...REPO, id: "repo-2" };
			const { deps } = makeDeps({
				gitService: {
					getGitMetadataDirectoriesForWorkspace: vi.fn(() => []),
					createGitWorktree,
				} as any,
				getAllRepositories: vi.fn(() => [REPO, REPO_2]),
			});
			const orch = new SessionOrchestrator(deps);

			const result = await orch.createGitHubWorkspace(
				REPO,
				"feature-branch",
				42,
			);

			expect(result).toEqual({ path: "/repo/wt/pr-42", isGitWorktree: true });
			expect(createGitWorktree).toHaveBeenCalledTimes(1);
			const [syntheticIssue, repos, options] = createGitWorktree.mock
				.calls[0] as [any, any, any];
			expect(syntheticIssue.identifier).toBe("PR-42");
			expect(syntheticIssue.branchName).toBe("feature-branch");
			expect(repos).toEqual([REPO]);
			expect(options.crossRepoSiblingRepositories).toEqual([REPO, REPO_2]);
		});

		it("returns null and logs when worktree creation throws", async () => {
			const { deps } = makeDeps({
				gitService: {
					getGitMetadataDirectoriesForWorkspace: vi.fn(() => []),
					createGitWorktree: vi.fn(async () => {
						throw new Error("worktree boom");
					}),
				} as any,
			});
			const orch = new SessionOrchestrator(deps);

			const result = await orch.createGitHubWorkspace(
				REPO,
				"feature-branch",
				42,
			);

			expect(result).toBeNull();
			expect(deps.logger.error).toHaveBeenCalled();
		});
	});

	describe("startGitHubSession", () => {
		function makeAgentSessionManagerForGithub(session: any) {
			return {
				addAgentRunner: vi.fn(),
				getActiveSessionsByBranchName: vi.fn(() => []),
				createCyrusAgentSession: vi.fn(),
				setActivitySink: vi.fn(),
				getSession: vi.fn(() => session),
			};
		}

		it("creates the session, starts the runner non-streaming, and posts the reply on completion", async () => {
			const session: any = { id: "github-delivery-1", metadata: undefined };
			const agentSessionManager = makeAgentSessionManagerForGithub(session);
			const activitySink = { post: vi.fn() };
			const postIssueComment = vi.fn(async () => ({}) as any);
			const { deps } = makeDeps({
				agentSessionManager: agentSessionManager as any,
				getActivitySinkForRepo: vi.fn(() => activitySink as any),
				buildGithubAllowedTools: vi.fn(() => ["Read", "Edit"]),
				gitHubCommentService: {
					postIssueComment,
					postReviewCommentReply: vi.fn(async () => ({}) as any),
					addReaction: vi.fn(async () => ({}) as any),
				} as any,
			});
			h.behavior.current.start = vi.fn(async () => ({
				sessionId: "runner-sess",
			}));
			h.behavior.current.getMessages = vi.fn(() => [
				{ type: "assistant", content: [{ type: "text", text: "All done" }] },
			]);
			const orch = new SessionOrchestrator(deps);

			await orch.startGitHubSession(
				makeGithubReq({
					event: makeGitHubEvent({ installationToken: "gh-token" }),
				}),
			);

			expect(agentSessionManager.createCyrusAgentSession).toHaveBeenCalledWith(
				"github-delivery-1",
				"github:org/repo#42",
				expect.objectContaining({
					id: "github:org/repo#42",
					identifier: "repo#42",
					title: "Fix the bug",
					branchName: "feature-branch",
				}),
				{ path: "/repo/wt/pr-42", isGitWorktree: true },
				"github",
				[
					{
						repositoryId: "repo-1",
						branchName: "feature-branch",
						baseBranchName: "main",
					},
				],
			);
			expect(deps.setSessionRepository).toHaveBeenCalledWith(
				"github-delivery-1",
				"repo-1",
			);
			expect(agentSessionManager.setActivitySink).toHaveBeenCalledWith(
				"github-delivery-1",
				activitySink,
			);
			expect(session.metadata.commentId).toBe("555");
			expect(h.created).toHaveLength(1);
			expect(h.created[0].start).toHaveBeenCalledWith("do the thing");
			expect(agentSessionManager.addAgentRunner).toHaveBeenCalledWith(
				"github-delivery-1",
				h.created[0],
			);
			expect(deps.emitGitHubSessionStarted).toHaveBeenCalledWith(
				"github:org/repo#42",
				expect.objectContaining({ id: "github:org/repo#42" }),
				"repo-1",
			);
			expect(postIssueComment).toHaveBeenCalledWith(
				expect.objectContaining({
					token: "gh-token",
					owner: "org",
					repo: "repo",
					issueNumber: 42,
					body: "All done",
				}),
			);
			expect(deps.savePersistedState).toHaveBeenCalled();
		});

		it("does not build a runner when the session cannot be looked up after creation", async () => {
			const agentSessionManager = makeAgentSessionManagerForGithub(undefined);
			const { deps } = makeDeps({
				agentSessionManager: agentSessionManager as any,
			});
			const orch = new SessionOrchestrator(deps);

			await orch.startGitHubSession(makeGithubReq());

			expect(agentSessionManager.addAgentRunner).not.toHaveBeenCalled();
			expect(deps.emitGitHubSessionStarted).not.toHaveBeenCalled();
			expect(deps.logger.error).toHaveBeenCalled();
		});

		it("still saves persisted state and skips the reply when the runner fails to start", async () => {
			const session: any = { id: "github-delivery-1", metadata: undefined };
			const agentSessionManager = makeAgentSessionManagerForGithub(session);
			const postIssueComment = vi.fn(async () => ({}) as any);
			const { deps } = makeDeps({
				agentSessionManager: agentSessionManager as any,
				gitHubCommentService: {
					postIssueComment,
					postReviewCommentReply: vi.fn(async () => ({}) as any),
					addReaction: vi.fn(async () => ({}) as any),
				} as any,
			});
			h.behavior.current.start = vi.fn(async () => {
				throw new Error("runner boom");
			});
			const orch = new SessionOrchestrator(deps);

			await orch.startGitHubSession(
				makeGithubReq({
					event: makeGitHubEvent({ installationToken: "gh-token" }),
				}),
			);

			expect(deps.logger.error).toHaveBeenCalled();
			expect(postIssueComment).not.toHaveBeenCalled();
			expect(deps.savePersistedState).toHaveBeenCalled();
		});
	});
});
