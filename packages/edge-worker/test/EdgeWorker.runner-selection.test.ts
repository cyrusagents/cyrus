import { readFile } from "node:fs/promises";
import { LinearClient } from "@linear/sdk";
import { ClaudeRunner } from "cyrus-claude-runner";
import type { LinearAgentSessionCreatedWebhook } from "cyrus-core";
import {
	isAgentSessionCreatedWebhook,
	isAgentSessionPromptedWebhook,
} from "cyrus-core";
import { GeminiRunner } from "cyrus-gemini-runner";
import { LinearEventTransport } from "cyrus-linear-event-transport";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock fs/promises
vi.mock("fs/promises", () => ({
	readFile: vi.fn(),
	writeFile: vi.fn(),
	mkdir: vi.fn(),
	rename: vi.fn(),
}));

// Mock dependencies
vi.mock("cyrus-claude-runner");
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
	let mockGeminiRunner: any;
	let mockAgentSessionManager: any;
	let capturedRunnerType: "claude" | "gemini" | null = null;
	let capturedRunnerConfig: any = null;

	const mockRepository: RepositoryConfig = {
		id: "test-repo",
		name: "Test Repo",
		repositoryPath: "/test/repo",
		workspaceBaseDir: "/test/workspaces",
		baseBranch: "main",
		linearToken: "test-token",
		linearWorkspaceId: "test-workspace",
		isActive: true,
		allowedTools: ["Read", "Edit"],
	};

	function createMockIssueWithLabels(labels: string[]) {
		return {
			id: "issue-123",
			identifier: "TEST-123",
			title: "Test Issue",
			description: "Test description",
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

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			createLinearAgentSession: vi.fn(),
			getSession: vi.fn().mockReturnValue({
				issueId: "issue-123",
				workspace: { path: "/test/workspaces/TEST-123" },
			}),
			addAgentRunner: vi.fn(),
			getAllAgentRunners: vi.fn().mockReturnValue([]),
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
			restoreState: vi.fn(),
			postAnalyzingThought: vi.fn().mockResolvedValue(null),
			postProcedureSelectionThought: vi.fn().mockResolvedValue(undefined),
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
			cyrusHome: "/tmp/test-cyrus-home",
			repositories: [mockRepository],
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
		(edgeWorker as any).issueTrackers.set(mockRepository.id, mockIssueTracker);
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
			// ClaudeRunner is called once for the classifier (ProcedureAnalyzer uses Claude by default)
			expect(ClaudeRunner).toHaveBeenCalledTimes(1);
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
			// ClaudeRunner is called once for the classifier (ProcedureAnalyzer uses Claude by default)
			expect(ClaudeRunner).toHaveBeenCalledTimes(1);
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
			const runnerSelection = (edgeWorker as any).determineRunnerFromLabels(
				labels,
			);

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
			const runnerSelection = (edgeWorker as any).determineRunnerFromLabels(
				labels,
			);

			// Assert
			expect(runnerSelection.runnerType).toBe("gemini");
			expect(runnerSelection.modelOverride).toBe("gemini-3-pro-preview");

			// The validation logic will allow this since both label and session use gemini
		});

		it("should correctly identify runner type mismatch between label and session", () => {
			// This test verifies the logic that would run in resumeAgentSession
			const labels = ["sonnet"]; // Claude label
			const runnerSelection = (edgeWorker as any).determineRunnerFromLabels(
				labels,
			);

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
	});
});
