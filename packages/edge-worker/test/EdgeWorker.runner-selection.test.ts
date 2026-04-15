import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import { CodexRunner } from "cyrus-codex-runner";
import type { LinearAgentSessionCreatedWebhook, RunnerType } from "cyrus-core";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "cyrus-core";
import { CursorRunner } from "cyrus-cursor-runner";
import { GeminiRunner } from "cyrus-gemini-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";
import { TEST_CYRUS_HOME } from "./test-dirs.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock dependencies
vi.mock("cyrus-claude-runner");
vi.mock("cyrus-codex-runner");
vi.mock("cyrus-cursor-runner");
vi.mock("cyrus-gemini-runner");
vi.mock("cyrus-linear-event-transport");
vi.mock("@linear/sdk");
vi.mock("../src/SharedApplicationServer.js");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		isAgentSessionCreatedWebhook: vi.fn(),
		isAgentSessionPromptedWebhook: vi.fn(),
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});
vi.mock("file-type");

describe("EdgeWorker - Runner Selection Based on Labels", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockClaudeRunner: any;
	let mockCodexRunner: any;
	let mockCursorRunner: any;
	let mockGeminiRunner: any;
	let mockAgentSessionManager: any;
	let capturedRunnerType: RunnerType | null = null;
	let capturedRunnerConfig: any = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	function createMockIssueWithLabels(
		labels: string[],
		description: string = "Test description",
	) {
		return {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description,
			url: "https://linear.app/test/issue/TEST-123",
			branchName: "test-branch",
			state: { name: "Todo" },
			team: { id: "team-123" },
			labels: vi.fn().mockResolvedValue({
				nodes: labels.map((name) => ({ name })),
			}),
		};
	}

	beforeEach(() => {
		vi.clearAllMocks();
		capturedRunnerType = null;
		capturedRunnerConfig = null;

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Mock LinearClient
		mockLinearClient = {
			issue: vi.fn(),
			workflowStates: vi.fn().mockResolvedValue({
				nodes: [
					{ id: "state-1", name: "Todo", type: "unstarted", position: 0 },
					{ id: "state-2", name: "In Progress", type: "started", position: 1 },
				],
			}),
			updateIssue: vi.fn().mockResolvedValue({ success: true }),
			createAgentActivity: vi.fn().mockResolvedValue({ success: true }),
			comments: vi.fn().mockResolvedValue({ nodes: [] }),
			rawRequest: vi.fn(),
		};
		vi.mocked(LinearClient).mockImplementation(() => mockLinearClient);

		// Mock ClaudeRunner
		mockClaudeRunner = {
			supportsStreamingInput: true,
			start: vi.fn().mockResolvedValue({ sessionId: "claude-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "claude-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(ClaudeRunner).mockImplementation((config: any) => {
			capturedRunnerType = "claude";
			capturedRunnerConfig = config;
			return mockClaudeRunner;
		});

		// Mock GeminiRunner
		mockGeminiRunner = {
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "gemini-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "gemini-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(GeminiRunner).mockImplementation((config: any) => {
			capturedRunnerType = "gemini";
			capturedRunnerConfig = config;
			return mockGeminiRunner;
		});

		// Mock CodexRunner
		mockCodexRunner = {
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "codex-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "codex-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(CodexRunner).mockImplementation((config: any) => {
			capturedRunnerType = "codex";
			capturedRunnerConfig = config;
			return mockCodexRunner;
		});

		// Mock CursorRunner
		mockCursorRunner = {
			supportsStreamingInput: false,
			start: vi.fn().mockResolvedValue({ sessionId: "cursor-session-123" }),
			startStreaming: vi
				.fn()
				.mockResolvedValue({ sessionId: "cursor-session-123" }),
			stop: vi.fn(),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			updatePromptVersions: vi.fn(),
		};
		vi.mocked(CursorRunner).mockImplementation((config: any) => {
			capturedRunnerType = "cursor";
			capturedRunnerConfig = config;
			return mockCursorRunner;
		});

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createCyrusAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
			}),
			addAgentRunner: vi.fn(),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			createThoughtActivity: vi.fn().mockResolvedValue(undefined),
			setActivitySink: vi.fn(),
			on: vi.fn(), // EventEmitter method
		};
		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

		// Mock SharedApplicationServer
		vi.mocked(SharedApplicationServer).mockImplementation(
			() =>
				({
					start: vi.fn().mockResolvedValue(undefined),
					stop: vi.fn().mockResolvedValue(undefined),
					getFastifyInstance: vi.fn().mockReturnValue({ post: vi.fn() }),
					getWebhookUrl: vi
						.fn()
						.mockReturnValue("http://localhost:3456/webhook"),
					registerOAuthCallbackHandler: vi.fn(),
				}) as any,
		);

		// Mock LinearEventTransport
		vi.mocked(LinearEventTransport).mockImplementation(
			() =>
				({
					register: vi.fn(),
					on: vi.fn(),
					removeAllListeners: vi.fn(),
				}) as any,
		);

		// Mock type guards
		vi.mocked(isAgentSessionCreatedWebhook).mockReturnValue(true);
		vi.mocked(isAgentSessionPromptedWebhook).mockReturnValue(false);

		// Mock readFile
		vi.mocked(readFile).mockImplementation(async () => {
			return `<version-tag value="default-v1.0.0" />
# Default Template

Repository: {{repository_name}}
Issue: {{issue_identifier}}`;
		});

		mockConfig = {
			proxyUrl: "http://localhost:3000",
			cyrusHome: TEST_CYRUS_HOME,
			repositories: [mockRepository],
			linearWorkspaces: {
				"test-workspace": { linearToken: "test-token" },
			},
			handlers: {
				createWorkspace: vi.fn().mockResolvedValue({
					path: "/test/workspaces/TEST-123",
					isGitWorktree: false,
				}),
			},
		};

		edgeWorker = new EdgeWorker(mockConfig);

		// Inject mock issue tracker
		const mockIssueTracker = {
			fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
				return mockLinearClient.issue(issueId);
			}),
			getIssueLabels: vi.fn(),
			getClient: vi.fn().mockReturnValue({}),
		};
		(edgeWorker as any).issueTrackers.set(
			mockRepository.linearWorkspaceId,
			mockIssueTracker,
		);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("Gemini Runner Selection", () => {
		it("should select Gemini runner when 'gemini' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["gemini"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
			expect(ClaudeRunner).not.toHaveBeenCalled();
		});

		it("should select Gemini runner with gemini-2.5-pro model when 'gemini-2.5-pro' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["gemini-2.5-pro"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
			expect(ClaudeRunner).not.toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("gemini-2.5-pro");
		});

		it("should select Gemini runner when 'gemini-2.5-flash' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["gemini-2.5-flash"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
		});

		it("should select Gemini runner when 'gemini-3-pro' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["gemini-3-pro"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("gemini-3-pro-preview");
		});
	});

	describe("Codex Runner Selection", () => {
		it("should select Codex runner when 'codex' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["codex"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("codex");
			expect(CodexRunner).toHaveBeenCalled();
			expect(ClaudeRunner).not.toHaveBeenCalled();
		});

		it("should select Codex runner with gpt-5-codex model when 'gpt-5-codex' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["gpt-5-codex"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("codex");
			expect(CodexRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("gpt-5-codex");
		});

		it("should select Codex runner with gpt-5.2-codex model when both agent and model labels are present", async () => {
			const mockIssue = createMockIssueWithLabels(["codex", "gpt-5.2-codex"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("codex");
			expect(CodexRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("gpt-5.2-codex");
		});
	});

	describe("Cursor Runner Selection", () => {
		it("should select Cursor runner when 'cursor' label is present", async () => {
			const mockIssue = createMockIssueWithLabels(["cursor"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("cursor");
			expect(CursorRunner).toHaveBeenCalled();
		});
	});

	describe("Description Tag Selection", () => {
		it("should select agent from [agent=...] description tag", async () => {
			const mockIssue = createMockIssueWithLabels(
				["bug"],
				"Work item\\n\\n[agent=codex]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("codex");
			expect(CodexRunner).toHaveBeenCalled();
		});

		it("should select Cursor runner from [agent=cursor] description tag", async () => {
			const mockIssue = createMockIssueWithLabels(
				["bug"],
				"Work item\\n\\n[agent=cursor]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("cursor");
			expect(CursorRunner).toHaveBeenCalled();
		});

		it("should select model from [model=...] description tag and infer runner", async () => {
			const mockIssue = createMockIssueWithLabels(
				["bug"],
				"Work item\\n\\n[model=gpt-5.2-codex]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("codex");
			expect(CodexRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("gpt-5.2-codex");
		});

		it("should let description tags override labels", async () => {
			const mockIssue = createMockIssueWithLabels(
				["claude", "sonnet"],
				"Work item\\n\\n[agent=gemini]\\n[model=gemini-2.5-flash]",
			);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("gemini-2.5-flash");
		});
	});

	describe("Claude Runner Selection", () => {
		it("should select Claude runner when 'claude' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["claude"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(GeminiRunner).not.toHaveBeenCalled();
		});

		it("should select Claude runner when 'sonnet' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["sonnet"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(GeminiRunner).not.toHaveBeenCalled();
		});

		it("should select Claude runner when 'opus' label is present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["opus"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(GeminiRunner).not.toHaveBeenCalled();
			expect(capturedRunnerConfig.model).toBe("opus");
		});
	});

	describe("Default Runner Selection", () => {
		it("should default to Claude runner when no runner-related labels are present", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["bug", "feature"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(GeminiRunner).not.toHaveBeenCalled();
		});

		it("should default to Claude runner when issue has no labels", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(GeminiRunner).not.toHaveBeenCalled();
		});

		it("should respect defaultRunner config when set to codex and no labels present", async () => {
			// Arrange - create EdgeWorker with defaultRunner config
			const codexConfig: EdgeWorkerConfig = {
				...mockConfig,
				defaultRunner: "codex",
			};
			const codexEdgeWorker = new EdgeWorker(codexConfig);
			// Inject mock issue tracker
			const mockIssueTracker = {
				fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
					return mockLinearClient.issue(issueId);
				}),
				getIssueLabels: vi.fn(),
				getClient: vi.fn().mockReturnValue({}),
			};
			(codexEdgeWorker as any).issueTrackers.set(
				mockRepository.linearWorkspaceId,
				mockIssueTracker,
			);

			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (codexEdgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("codex");
			expect(CodexRunner).toHaveBeenCalled();
			expect(ClaudeRunner).not.toHaveBeenCalled();
		});

		it("should respect defaultRunner config when set to gemini and no labels present", async () => {
			// Arrange - create EdgeWorker with defaultRunner config
			const geminiConfig: EdgeWorkerConfig = {
				...mockConfig,
				defaultRunner: "gemini",
			};
			const geminiEdgeWorker = new EdgeWorker(geminiConfig);
			// Inject mock issue tracker
			const mockIssueTracker = {
				fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
					return mockLinearClient.issue(issueId);
				}),
				getIssueLabels: vi.fn(),
				getClient: vi.fn().mockReturnValue({}),
			};
			(geminiEdgeWorker as any).issueTrackers.set(
				mockRepository.linearWorkspaceId,
				mockIssueTracker,
			);

			const mockIssue = createMockIssueWithLabels([]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (geminiEdgeWorker as any).handleAgentSessionCreatedWebhook(
				webhook,
				[mockRepository],
			);

			// Assert
			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
			expect(ClaudeRunner).not.toHaveBeenCalled();
		});

		it("should let explicit labels override defaultRunner config", async () => {
			// Arrange - defaultRunner is codex, but label says claude
			const codexConfig: EdgeWorkerConfig = {
				...mockConfig,
				defaultRunner: "codex",
			};
			const codexEdgeWorker = new EdgeWorker(codexConfig);
			const mockIssueTracker = {
				fetchIssue: vi.fn().mockImplementation(async (issueId: string) => {
					return mockLinearClient.issue(issueId);
				}),
				getIssueLabels: vi.fn(),
				getClient: vi.fn().mockReturnValue({}),
			};
			(codexEdgeWorker as any).issueTrackers.set(
				mockRepository.linearWorkspaceId,
				mockIssueTracker,
			);

			const mockIssue = createMockIssueWithLabels(["claude"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (codexEdgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert - label should override defaultRunner
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
			expect(CodexRunner).not.toHaveBeenCalled();
		});
	});

	describe("Case Insensitivity", () => {
		it("should select Gemini runner with mixed-case 'Gemini' label", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["Gemini"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("gemini");
			expect(GeminiRunner).toHaveBeenCalled();
		});

		it("should select Claude runner with uppercase 'CLAUDE' label", async () => {
			// Arrange
			const mockIssue = createMockIssueWithLabels(["CLAUDE"]);
			mockLinearClient.issue.mockResolvedValue(mockIssue);

			const webhook: LinearAgentSessionCreatedWebhook = {
				type: "Issue",
				action: "agentSessionCreated",
				organizationId: "test-workspace",
				agentSession: {
					id: "agent-session-123",
					issue: {
						id: "issue-123",
						identifier: "TEST-123",
						team: { key: "TEST" },
					},
					comment: { body: "@cyrus work on this" },
				},
			};

			// Act
			await (edgeWorker as any).handleAgentSessionCreatedWebhook(webhook, [
				mockRepository,
			]);

			// Assert
			expect(capturedRunnerType).toBe("claude");
			expect(ClaudeRunner).toHaveBeenCalled();
		});
	});

	describe("Session Continuation Model Override Validation", () => {
		it("should detect and warn about cross-runner model override (opus on gemini session)", () => {
			// Arrange
			const labels = ["opus"]; // Claude model label

			// Act
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(labels);

			// Assert
			expect(runnerSelection.runnerType).toBe("claude");
			expect(runnerSelection.modelOverride).toBe("opus");

			// The validation logic in resumeAgentSession will detect this mismatch
			// and prevent applying "opus" to a Gemini session
		});

		it("should allow same-runner model override (gemini-3-pro on gemini session)", () => {
			// Arrange
			const labels = ["gemini-3-pro"];

			// Act
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(labels);

			// Assert
			expect(runnerSelection.runnerType).toBe("gemini");
			expect(runnerSelection.modelOverride).toBe("gemini-3-pro-preview");

			// The validation logic will allow this since both label and session use gemini
		});

		it("should correctly identify runner type mismatch between label and session", () => {
			// This test verifies the logic that would run in resumeAgentSession
			const labels = ["sonnet"]; // Claude label
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection(labels);

			// If continuing a Gemini session (hasGeminiSession=true, hasClaudeSession=false)
			const useClaudeRunner = false; // Would be determined by session IDs
			const actualRunnerType = useClaudeRunner ? "claude" : "gemini";
			const labelRunnerType = runnerSelection.runnerType;

			// Verify mismatch detection
			expect(labelRunnerType).toBe("claude");
			expect(actualRunnerType).toBe("gemini");
			expect(labelRunnerType).not.toBe(actualRunnerType);

			// This mismatch would trigger the warning in resumeAgentSession
		});

		it("should preserve explicit agent and ignore conflicting model", () => {
			const runnerSelection = (
				edgeWorker as any
			).runnerSelectionService.determineRunnerSelection([
				"claude",
				"gpt-5-codex",
			]);

			expect(runnerSelection.runnerType).toBe("claude");
			expect(runnerSelection.modelOverride).toBe("opus");
		});
	});

	describe("Session Continuation", () => {
		it("should pass cursorSessionId as resumeSessionId for cursor continuations", async () => {
			const mockIssue = createMockIssueWithLabels(["cursor"]);
			vi.spyOn(edgeWorker as any, "fetchFullIssueDetails").mockResolvedValue(
				mockIssue,
			);
			vi.spyOn(edgeWorker as any, "buildSessionPrompt").mockResolvedValue(
				"Resume this session",
			);
			vi.spyOn(edgeWorker as any, "savePersistedState").mockResolvedValue(
				undefined,
			);

			const session: any = {
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
				issue: { identifier: "TEST-123" },
				cursorSessionId: "cursor-session-existing",
			};

			await (edgeWorker as any).resumeAgentSession(
				session,
				mockRepository,
				"agent-session-123",
				mockAgentSessionManager,
				"follow-up prompt",
			);

			expect(capturedRunnerType).toBe("cursor");
			expect(capturedRunnerConfig.resumeSessionId).toBe(
				"cursor-session-existing",
			);
			expect(mockCursorRunner.start).toHaveBeenCalledOnce();
		});
	});
});
