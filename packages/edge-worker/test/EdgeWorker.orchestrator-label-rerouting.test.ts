import {
	AgentSessionStatus,
	AgentSessionType,
	LinearClient,
} from "@linear/sdk";
import type { CyrusAgentSession } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSessionManager } from "../src/AgentSessionManager.js";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { EdgeWorkerConfig, RepositoryConfig } from "../src/types.js";

// Mock dependencies
vi.mock("@linear/sdk");
vi.mock("../src/AgentSessionManager.js");
vi.mock("cyrus-core", async (importOriginal) => {
	const actual = (await importOriginal()) as any;
	return {
		...actual,
		PersistenceManager: vi.fn().mockImplementation(() => ({
			loadEdgeWorkerState: vi.fn().mockResolvedValue(null),
			saveEdgeWorkerState: vi.fn().mockResolvedValue(undefined),
		})),
	};
});

describe("EdgeWorker - Orchestrator Label Rerouting", () => {
	let edgeWorker: EdgeWorker;
	let mockConfig: EdgeWorkerConfig;
	let mockLinearClient: any;
	let mockAgentSessionManager: any;

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
		labelPrompts: {
			orchestrator: ["Orchestrator", "orchestrator"],
		},
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Mock console methods
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		// Mock LinearClient - default to issue WITHOUT Orchestrator label
		mockLinearClient = {
			issue: vi.fn().mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "This is a test issue",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [], // No labels by default
				}),
			}),
			// Mock the underlying GraphQL client for token refresh patching
			client: {
				request: vi.fn(),
				setHeader: vi.fn(),
			},
		};
		vi.mocked(LinearClient).mockImplementation(() => mockLinearClient);

		// Mock AgentSessionManager
		mockAgentSessionManager = {
			postRoutingThought: vi.fn().mockResolvedValue(null),
			postProcedureSelectionThought: vi.fn().mockResolvedValue(undefined),
			postAnalyzingThought: vi.fn().mockResolvedValue(undefined),
			on: vi.fn(), // EventEmitter method
		};
		vi.mocked(AgentSessionManager).mockImplementation(
			() => mockAgentSessionManager,
		);

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
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("rerouteProcedureForSession - Orchestrator label enforcement", () => {
		it("should use orchestrator-full procedure when Orchestrator label is present", async () => {
			// Arrange - Mock issue WITH Orchestrator label
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue with Orchestrator",
				description: "This is an orchestrator issue",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "Orchestrator" }], // Has Orchestrator label
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Here are the results from the child agent";

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should use orchestrator-full procedure
			expect(procedureCallArgs[1]).toBe("orchestrator-full");
			// Should classify as orchestrator
			expect(procedureCallArgs[2]).toBe("orchestrator");

			// Verify the console log indicates Orchestrator label override
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining(
					"Using orchestrator-full procedure due to Orchestrator label (skipping AI routing)",
				),
			);

			// Verify session metadata was initialized with orchestrator-full procedure
			expect(session.metadata.procedure).toBeDefined();
			expect(session.metadata.procedure.procedureName).toBe(
				"orchestrator-full",
			);
		});

		it("should use AI routing when Orchestrator label is NOT present", async () => {
			// Arrange - Mock issue WITHOUT Orchestrator label (default)
			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody =
				"Please implement a new feature with full testing and documentation";

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should NOT use orchestrator-full (will use AI routing)
			expect(procedureCallArgs[1]).not.toBe("orchestrator-full");

			// Verify the console log indicates AI routing was used
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining("AI routing decision"),
			);
		});

		it("should consistently use orchestrator-full even with builder-like prompts when Orchestrator label is present", async () => {
			// Arrange - Mock issue WITH Orchestrator label
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue with Orchestrator",
				description: "This is an orchestrator issue",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "Orchestrator" }], // Has Orchestrator label
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			// This is a builder-like prompt that might trigger AI to classify as builder
			const promptBody =
				"Please implement this feature with full tests and documentation. Create a PR when done.";

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should STILL use orchestrator-full despite builder-like prompt
			expect(procedureCallArgs[1]).toBe("orchestrator-full");
			expect(procedureCallArgs[2]).toBe("orchestrator");

			// Verify Orchestrator label override log
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining(
					"Using orchestrator-full procedure due to Orchestrator label (skipping AI routing)",
				),
			);
		});

		it("should consistently use orchestrator-full when receiving child agent results", async () => {
			// Arrange - Mock issue WITH Orchestrator label
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue with Orchestrator",
				description: "This is an orchestrator issue",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "orchestrator" }], // Lowercase variant
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			// Simulating a child agent posting results - this was the problematic case
			const promptBody = `## Summary

Work completed on subtask TEST-124.

## Status

✅ Complete - PR created at https://github.com/org/repo/pull/123`;

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should use orchestrator-full, NOT switch to builder based on the summary content
			expect(procedureCallArgs[1]).toBe("orchestrator-full");
			expect(procedureCallArgs[2]).toBe("orchestrator");

			// Verify Orchestrator label override was used
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining(
					"Using orchestrator-full procedure due to Orchestrator label (skipping AI routing)",
				),
			);
		});

		it("should handle label fetch errors gracefully and fall back to AI routing", async () => {
			// Arrange - Mock Linear client to throw error
			mockLinearClient.issue.mockRejectedValue(new Error("Linear API error"));

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Test comment";

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert - Should not throw, should fall back to AI routing
			expect(console.error).toHaveBeenCalledWith(
				expect.stringContaining("Failed to fetch issue labels for routing"),
				expect.any(Error),
			);

			// Should still have posted a procedure selection (via AI routing)
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
		});

		it("should work with different Orchestrator label variants from config", async () => {
			// Arrange - Mock issue with "orchestrator" (lowercase)
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "orchestrator" }], // lowercase
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Test comment";

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should recognize lowercase "orchestrator" from config
			expect(procedureCallArgs[1]).toBe("orchestrator-full");
			expect(procedureCallArgs[2]).toBe("orchestrator");
		});

		it("should skip AI routing entirely when Orchestrator label is present", async () => {
			// Arrange - Mock issue WITH Orchestrator label
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "Orchestrator" }],
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Test comment";

			// Act
			await (edgeWorker as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				mockRepository,
			);

			// Assert - Should NOT see AI routing decision logs
			const allLogCalls = (console.log as any).mock.calls.map(
				(call: any[]) => call[0],
			);

			// Should NOT have any AI routing logs
			const hasAIRoutingLogs = allLogCalls.some((msg: string) =>
				msg.includes("AI routing decision"),
			);
			expect(hasAIRoutingLogs).toBe(false);

			// SHOULD have the Orchestrator label override log
			const hasOrchestratorOverrideLog = allLogCalls.some((msg: string) =>
				msg.includes(
					"Using orchestrator-full procedure due to Orchestrator label (skipping AI routing)",
				),
			);
			expect(hasOrchestratorOverrideLog).toBe(true);
		});

		it("should use orchestrator-full procedure when orchestrator label is present WITHOUT labelPrompts config", async () => {
			// Create a repository WITHOUT labelPrompts.orchestrator config
			const repositoryWithoutOrchestratorConfig: RepositoryConfig = {
				id: "test-repo-no-config",
				name: "Test Repo No Config",
				repositoryPath: "/test/repo",
				workspaceBaseDir: "/test/workspaces",
				baseBranch: "main",
				linearToken: "test-token",
				linearWorkspaceId: "test-workspace",
				isActive: true,
				allowedTools: ["Read", "Edit"],
				// NO labelPrompts.orchestrator configured!
			};

			// Create new EdgeWorker with the config that has no orchestrator labelPrompts
			const configWithoutOrchestratorLabels: EdgeWorkerConfig = {
				proxyUrl: "http://localhost:3000",
				cyrusHome: "/tmp/test-cyrus-home",
				repositories: [repositoryWithoutOrchestratorConfig],
				handlers: {
					createWorkspace: vi.fn().mockResolvedValue({
						path: "/test/workspaces/TEST-123",
						isGitWorktree: false,
					}),
				},
			};

			const edgeWorkerNoConfig = new EdgeWorker(
				configWithoutOrchestratorLabels,
			);

			// Arrange - Mock issue WITH orchestrator label (lowercase)
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "orchestrator" }], // lowercase orchestrator label
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Test comment";

			// Act
			await (edgeWorkerNoConfig as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				repositoryWithoutOrchestratorConfig,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should use orchestrator-full even without labelPrompts config
			expect(procedureCallArgs[1]).toBe("orchestrator-full");
			expect(procedureCallArgs[2]).toBe("orchestrator");

			// Verify Orchestrator label override log
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining(
					"Using orchestrator-full procedure due to Orchestrator label (skipping AI routing)",
				),
			);
		});

		it("should use orchestrator-full procedure when Orchestrator label (capitalized) is present WITHOUT labelPrompts config", async () => {
			// Create a repository WITHOUT labelPrompts.orchestrator config
			const repositoryWithoutOrchestratorConfig: RepositoryConfig = {
				id: "test-repo-no-config",
				name: "Test Repo No Config",
				repositoryPath: "/test/repo",
				workspaceBaseDir: "/test/workspaces",
				baseBranch: "main",
				linearToken: "test-token",
				linearWorkspaceId: "test-workspace",
				isActive: true,
				allowedTools: ["Read", "Edit"],
				// NO labelPrompts.orchestrator configured!
			};

			// Create new EdgeWorker with the config that has no orchestrator labelPrompts
			const configWithoutOrchestratorLabels: EdgeWorkerConfig = {
				proxyUrl: "http://localhost:3000",
				cyrusHome: "/tmp/test-cyrus-home",
				repositories: [repositoryWithoutOrchestratorConfig],
				handlers: {
					createWorkspace: vi.fn().mockResolvedValue({
						path: "/test/workspaces/TEST-123",
						isGitWorktree: false,
					}),
				},
			};

			const edgeWorkerNoConfig = new EdgeWorker(
				configWithoutOrchestratorLabels,
			);

			// Arrange - Mock issue WITH Orchestrator label (capitalized)
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "Orchestrator" }], // Capitalized Orchestrator label
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Test comment";

			// Act
			await (edgeWorkerNoConfig as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				repositoryWithoutOrchestratorConfig,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should use orchestrator-full even without labelPrompts config
			expect(procedureCallArgs[1]).toBe("orchestrator-full");
			expect(procedureCallArgs[2]).toBe("orchestrator");

			// Verify Orchestrator label override log
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining(
					"Using orchestrator-full procedure due to Orchestrator label (skipping AI routing)",
				),
			);
		});

		it("should NOT use orchestrator-full when no orchestrator label and no labelPrompts config", async () => {
			// Create a repository WITHOUT labelPrompts.orchestrator config
			const repositoryWithoutOrchestratorConfig: RepositoryConfig = {
				id: "test-repo-no-config",
				name: "Test Repo No Config",
				repositoryPath: "/test/repo",
				workspaceBaseDir: "/test/workspaces",
				baseBranch: "main",
				linearToken: "test-token",
				linearWorkspaceId: "test-workspace",
				isActive: true,
				allowedTools: ["Read", "Edit"],
				// NO labelPrompts.orchestrator configured!
			};

			// Create new EdgeWorker with the config that has no orchestrator labelPrompts
			const configWithoutOrchestratorLabels: EdgeWorkerConfig = {
				proxyUrl: "http://localhost:3000",
				cyrusHome: "/tmp/test-cyrus-home",
				repositories: [repositoryWithoutOrchestratorConfig],
				handlers: {
					createWorkspace: vi.fn().mockResolvedValue({
						path: "/test/workspaces/TEST-123",
						isGitWorktree: false,
					}),
				},
			};

			const edgeWorkerNoConfig = new EdgeWorker(
				configWithoutOrchestratorLabels,
			);

			// Arrange - Mock issue WITHOUT orchestrator label
			mockLinearClient.issue.mockResolvedValue({
				id: "issue-123",
				identifier: "TEST-123",
				title: "Test Issue",
				description: "Test description",
				url: "https://linear.app/test/issue/TEST-123",
				branchName: "test-branch",
				state: { name: "In Progress", type: "started" },
				team: { id: "team-123" },
				labels: vi.fn().mockResolvedValue({
					nodes: [{ name: "Bug" }], // Different label, not orchestrator
				}),
			});

			const session: CyrusAgentSession = {
				id: "agent-session-123",
				externalSessionId: "agent-session-123",
				type: AgentSessionType.CommentThread,
				status: AgentSessionStatus.Active,
				context: AgentSessionType.CommentThread,
				createdAt: Date.now(),
				updatedAt: Date.now(),
				issueContext: {
					trackerId: "linear",
					issueId: "issue-123",
					issueIdentifier: "TEST-123",
				},
				workspace: { path: "/test/workspaces/TEST-123", isGitWorktree: false },
				metadata: {},
			};

			const promptBody = "Please fix this bug in the codebase";

			// Act
			await (edgeWorkerNoConfig as any).rerouteProcedureForSession(
				session,
				"agent-session-123",
				mockAgentSessionManager,
				promptBody,
				repositoryWithoutOrchestratorConfig,
			);

			// Assert
			expect(
				mockAgentSessionManager.postProcedureSelectionThought,
			).toHaveBeenCalled();
			const procedureCallArgs =
				mockAgentSessionManager.postProcedureSelectionThought.mock.calls[0];

			// Should NOT use orchestrator-full (should use AI routing)
			expect(procedureCallArgs[1]).not.toBe("orchestrator-full");

			// Verify AI routing was used
			expect(console.log).toHaveBeenCalledWith(
				expect.stringContaining("AI routing decision"),
			);
		});
	});
});
