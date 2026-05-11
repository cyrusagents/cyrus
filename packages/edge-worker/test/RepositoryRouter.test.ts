import { AgentActivitySignal } from "@linear/sdk";
import type {
	LinearAgentSessionCreatedWebhook,
	RepositoryConfig,
} from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	RepositoryRouter,
	type RepositoryRouterDeps,
	type RepositoryRoutingResult,
} from "../src/RepositoryRouter.js";

/**
 * DSL-style Test Suite for RepositoryRouter
 *
 * This test suite uses a fluent, readable DSL to test all repository routing scenarios.
 * Each test reads like a specification, making it easy to understand what is being tested.
 */

// ============================================================================
// TEST DSL - Builders for readable test scenarios
// ============================================================================

/**
 * Repository Builder - Fluent API for creating test repositories
 */
class RepositoryBuilder {
	private config: Partial<RepositoryConfig> = {};

	constructor(id: string, name: string) {
		this.config = {
			id,
			name,
			repositoryPath: `/path/to/${id}`,
			baseBranch: "main",
			linearWorkspaceId: "default-workspace",
			workspaceBaseDir: "/workspace",
			isActive: true,
		};
	}

	inWorkspace(workspaceId: string): this {
		this.config.linearWorkspaceId = workspaceId;
		return this;
	}

	withTeams(...teamKeys: string[]): this {
		this.config.teamKeys = teamKeys;
		return this;
	}

	withLabels(...labels: string[]): this {
		this.config.routingLabels = labels;
		return this;
	}

	withProjects(...projects: string[]): this {
		this.config.projectKeys = projects;
		return this;
	}

	withGithubUrl(url: string): this {
		this.config.githubUrl = url;
		return this;
	}

	asCatchAll(): this {
		this.config.teamKeys = undefined;
		this.config.routingLabels = undefined;
		this.config.projectKeys = undefined;
		return this;
	}

	build(): RepositoryConfig {
		return this.config as RepositoryConfig;
	}
}

/**
 * Webhook Builder - Fluent API for creating test webhooks
 */
class WebhookBuilder {
	private data: any = {
		action: "created",
		organizationId: "default-workspace",
		agentSession: {
			id: "session-1",
			issue: {
				id: "issue-1",
				identifier: "TEST-1",
				team: { key: "TEST" },
			},
			comment: null,
		},
		guidance: [],
	};

	inWorkspace(workspaceId: string): this {
		this.data.organizationId = workspaceId;
		return this;
	}

	forIssue(issueId: string, identifier: string): this {
		this.data.agentSession.issue.id = issueId;
		this.data.agentSession.issue.identifier = identifier;
		return this;
	}

	inTeam(teamKey: string): this {
		this.data.agentSession.issue.team.key = teamKey;
		return this;
	}

	withSession(sessionId: string): this {
		this.data.agentSession.id = sessionId;
		return this;
	}

	build(): LinearAgentSessionCreatedWebhook {
		return this.data;
	}
}

/**
 * Test Environment - Manages mocks and setup for routing scenarios
 */
class RoutingTestEnvironment {
	public router: RepositoryRouter;
	public mockLinearClient: any;
	public mockDeps: RepositoryRouterDeps;
	private issueLabels: Map<string, string[]> = new Map();
	private issueProjects: Map<string, string> = new Map();
	private issueDescriptions: Map<string, string> = new Map();
	private activeSessions: Map<string, Set<string>> = new Map();

	constructor() {
		this.mockLinearClient = {
			createAgentActivity: vi.fn().mockResolvedValue({}),
			fetchIssue: vi.fn().mockImplementation(async (issueId: string) => ({
				id: issueId,
				identifier: "TEST-1",
				project: this.issueProjects.has(issueId)
					? { name: this.issueProjects.get(issueId) }
					: null,
			})),
		};

		this.mockDeps = {
			fetchIssueLabels: vi.fn().mockImplementation(async (issueId: string) => {
				return this.issueLabels.get(issueId) || [];
			}),
			fetchIssueDescription: vi
				.fn()
				.mockImplementation(async (issueId: string) => {
					return this.issueDescriptions.get(issueId);
				}),
			hasActiveSession: vi
				.fn()
				.mockImplementation((issueId: string, repoId: string) => {
					return this.activeSessions.get(issueId)?.has(repoId) || false;
				}),
			getIssueTracker: vi.fn().mockReturnValue(this.mockLinearClient),
		};

		this.router = new RepositoryRouter(this.mockDeps);
	}

	/**
	 * Configure issue to have specific labels
	 */
	issueHasLabels(issueId: string, ...labels: string[]): this {
		this.issueLabels.set(issueId, labels);
		return this;
	}

	/**
	 * Configure issue to be in a specific project
	 */
	issueIsInProject(issueId: string, projectName: string): this {
		this.issueProjects.set(issueId, projectName);
		return this;
	}

	/**
	 * Configure issue to have a specific description
	 */
	issueHasDescription(issueId: string, description: string): this {
		this.issueDescriptions.set(issueId, description);
		return this;
	}

	/**
	 * Configure issue to have an active session in a repository
	 */
	issueHasActiveSessionIn(issueId: string, repoId: string): this {
		if (!this.activeSessions.has(issueId)) {
			this.activeSessions.set(issueId, new Set());
		}
		this.activeSessions.get(issueId)!.add(repoId);
		return this;
	}

	/**
	 * Simulate label fetching failure
	 */
	labelFetchingFails(): this {
		this.mockDeps.fetchIssueLabels = vi
			.fn()
			.mockRejectedValue(new Error("Failed to fetch labels"));
		return this;
	}

	/**
	 * Simulate description fetching failure
	 */
	descriptionFetchingFails(): this {
		this.mockDeps.fetchIssueDescription = vi
			.fn()
			.mockRejectedValue(new Error("Failed to fetch description"));
		return this;
	}

	/**
	 * Create a repository builder
	 */
	repository(id: string, name: string): RepositoryBuilder {
		return new RepositoryBuilder(id, name);
	}

	/**
	 * Create a webhook builder
	 */
	webhook(): WebhookBuilder {
		return new WebhookBuilder();
	}
}

/**
 * Routing Assertion Builder - Fluent API for asserting routing results
 */
class RoutingAssertion {
	constructor(private result: RepositoryRoutingResult) {}

	shouldSelectRepository(expectedRepo: RepositoryConfig): this {
		expect(this.result.type).toBe("selected");
		if (this.result.type === "selected") {
			expect(this.result.repositories[0]?.id).toBe(expectedRepo.id);
			expect(this.result.repositories[0]?.name).toBe(expectedRepo.name);
		}
		return this;
	}

	shouldSelectRepositoryVia(
		expectedRepo: RepositoryConfig,
		method: string,
	): this {
		expect(this.result.type).toBe("selected");
		if (this.result.type === "selected") {
			expect(this.result.repositories[0]?.id).toBe(expectedRepo.id);
			expect(this.result.routingMethod).toBe(method);
		}
		return this;
	}

	shouldSelectRepositories(expectedRepos: RepositoryConfig[]): this {
		expect(this.result.type).toBe("selected");
		if (this.result.type === "selected") {
			expect(this.result.repositories).toHaveLength(expectedRepos.length);
			for (let i = 0; i < expectedRepos.length; i++) {
				expect(this.result.repositories[i]?.id).toBe(expectedRepos[i]!.id);
			}
		}
		return this;
	}

	shouldSelectRepositoriesVia(
		expectedRepos: RepositoryConfig[],
		method: string,
	): this {
		expect(this.result.type).toBe("selected");
		if (this.result.type === "selected") {
			expect(this.result.repositories).toHaveLength(expectedRepos.length);
			for (let i = 0; i < expectedRepos.length; i++) {
				expect(this.result.repositories[i]?.id).toBe(expectedRepos[i]!.id);
			}
			expect(this.result.routingMethod).toBe(method);
		}
		return this;
	}

	shouldNeedSelection(): this {
		expect(this.result.type).toBe("needs_selection");
		return this;
	}

	shouldNeedSelectionWithRepos(expectedCount: number): this {
		expect(this.result.type).toBe("needs_selection");
		if (this.result.type === "needs_selection") {
			expect(this.result.workspaceRepos).toHaveLength(expectedCount);
		}
		return this;
	}

	shouldSelectNothing(): this {
		expect(this.result.type).toBe("none");
		return this;
	}
}

/**
 * Helper to create routing assertion from result
 */
function expectRouting(result: RepositoryRoutingResult): RoutingAssertion {
	return new RoutingAssertion(result);
}

// ============================================================================
// TEST SUITE
// ============================================================================

describe("RepositoryRouter", () => {
	let env: RoutingTestEnvironment;

	beforeEach(() => {
		env = new RoutingTestEnvironment();
	});

	// ========================================================================
	// Cache Management Tests
	// ========================================================================

	describe("Cache Management", () => {
		describe("when retrieving cached repositories", () => {
			it("should return the cached repositories when they exist in both cache and repository map", () => {
				// Given: A repository and a populated cache
				const repo = env
					.repository("repo-1", "Cached Repo")
					.inWorkspace("workspace-1")
					.build();
				const reposMap = new Map([[repo.id, repo]]);
				env.router.getIssueRepositoryCache().set("issue-1", [repo.id]);

				// When: Retrieving cached repositories
				const result = env.router.getCachedRepositories("issue-1", reposMap);

				// Then: Should return the cached repositories
				expect(result).toEqual([repo]);
			});

			it("should return null when no cache entry exists for the issue", () => {
				// Given: A repository but no cache entry
				const repo = env.repository("repo-1", "Uncached Repo").build();
				const reposMap = new Map([[repo.id, repo]]);

				// When: Retrieving cached repositories
				const result = env.router.getCachedRepositories("issue-1", reposMap);

				// Then: Should return null
				expect(result).toBeNull();
			});

			it("should remove invalid cache entries when all cached repositories no longer exist", () => {
				// Given: Cache points to non-existent repository
				const repo = env.repository("repo-1", "Valid Repo").build();
				const reposMap = new Map([[repo.id, repo]]);
				env.router
					.getIssueRepositoryCache()
					.set("issue-1", ["non-existent-repo"]);

				// When: Retrieving cached repositories
				const result = env.router.getCachedRepositories("issue-1", reposMap);

				// Then: Should return null and clean up cache
				expect(result).toBeNull();
				expect(env.router.getIssueRepositoryCache().has("issue-1")).toBe(false);
			});

			it("should return only valid repos and clean invalid from cache", () => {
				// Given: Cache with one valid and one invalid repo ID
				const repo = env.repository("repo-1", "Valid Repo").build();
				const reposMap = new Map([[repo.id, repo]]);
				env.router
					.getIssueRepositoryCache()
					.set("issue-1", ["repo-1", "non-existent-repo"]);

				// When: Retrieving cached repositories
				const result = env.router.getCachedRepositories("issue-1", reposMap);

				// Then: Should return only valid repos and update cache
				expect(result).toEqual([repo]);
				expect(env.router.getIssueRepositoryCache().get("issue-1")).toEqual([
					"repo-1",
				]);
			});
		});

		describe("when persisting cache", () => {
			it("should restore cache from serialized data (new string[] format)", () => {
				// Given: A serialized cache in new format
				const cache = new Map<string, string[]>([
					["issue-1", ["repo-1"]],
					["issue-2", ["repo-2", "repo-3"]],
				]);

				// When: Restoring cache
				env.router.restoreIssueRepositoryCache(cache);

				// Then: Cache should be restored
				expect(env.router.getIssueRepositoryCache()).toEqual(cache);
			});

			it("should migrate old string format to string[] on restore", () => {
				// Given: A serialized cache in old format (string values)
				const oldCache = new Map<string, string | string[]>([
					["issue-1", "repo-1"],
					["issue-2", "repo-2"],
				]);

				// When: Restoring from old format
				env.router.restoreIssueRepositoryCache(oldCache);

				// Then: Cache should be migrated to string[] format
				expect(env.router.getIssueRepositoryCache().get("issue-1")).toEqual([
					"repo-1",
				]);
				expect(env.router.getIssueRepositoryCache().get("issue-2")).toEqual([
					"repo-2",
				]);
			});

			it("should allow exporting cache for serialization", () => {
				// Given: A router with cache entries
				const cache = env.router.getIssueRepositoryCache();
				cache.set("issue-1", ["repo-1"]);
				cache.set("issue-2", ["repo-2", "repo-3"]);

				// When: Exporting cache
				const exported = env.router.getIssueRepositoryCache();

				// Then: Should export all entries as string[]
				expect(exported.size).toBe(2);
				expect(exported.get("issue-1")).toEqual(["repo-1"]);
				expect(exported.get("issue-2")).toEqual(["repo-2", "repo-3"]);
			});
		});
	});

	// ========================================================================
	// Priority 0: Active Session Routing
	// ========================================================================

	describe("Priority 0: Active Session Routing", () => {
		describe("when an issue already has an active session in a repository", () => {
			it("should route to that repository regardless of other routing rules", async () => {
				// Given: An issue with an active session in repo-1
				// Both repos in same workspace so they both get considered
				const repo1 = env
					.repository("repo-1", "Active Session Repo")
					.inWorkspace("default-workspace")
					.withTeams("TEAM1")
					.build();
				const repo2 = env
					.repository("repo-2", "Other Repo")
					.inWorkspace("default-workspace")
					.withTeams("TEAM2")
					.build();

				env.issueHasActiveSessionIn("issue-1", "repo-1");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEAM2-123")
					.inTeam("TEAM2")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo1,
					repo2,
				]);

				// Then: Should select repo with active session (not team-matched repo)
				expectRouting(result).shouldSelectRepository(repo1);
			});

			it("should skip active session check when issue has no active sessions", async () => {
				// Given: An issue with no active sessions
				const repo = env
					.repository("repo-1", "Team Matched Repo")
					.withTeams("TEAM1")
					.build();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "TEAM1-123")
					.inTeam("TEAM1")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should proceed to team-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "team-based");
			});
		});
	});

	// ========================================================================
	// Priority 1: Description Tag Routing
	// ========================================================================

	describe("Priority 1: Description Tag Routing", () => {
		describe("when issue description contains [repo=...] tag", () => {
			it("should route to repository when tag matches GitHub URL", async () => {
				// Given: Repositories with different GitHub URLs
				const cyrusRepo = env
					.repository("repo-1", "Cyrus")
					.inWorkspace("default-workspace")
					.withGithubUrl("https://github.com/ceedaragents/cyrus")
					.build();

				const otherRepo = env
					.repository("repo-2", "Other Repo")
					.inWorkspace("default-workspace")
					.withGithubUrl("https://github.com/org/other-repo")
					.build();

				// Issue has description with repo tag
				env.issueHasDescription(
					"issue-1",
					"Please fix this bug in [repo=ceedaragents/cyrus]\n\nMore details here.",
				);

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					cyrusRepo,
					otherRepo,
				]);

				// Then: Should select cyrus repo via description-tag routing
				expectRouting(result).shouldSelectRepositoryVia(
					cyrusRepo,
					"description-tag",
				);
			});

			it("should route to repository when tag matches repository name exactly", async () => {
				// Given: Repositories with different names
				const frontendRepo = env
					.repository("repo-1", "frontend-app")
					.inWorkspace("default-workspace")
					.build();

				const backendRepo = env
					.repository("repo-2", "backend-api")
					.inWorkspace("default-workspace")
					.build();

				// Issue has description with repo tag matching name
				env.issueHasDescription(
					"issue-1",
					"This is for [repo=frontend-app] development",
				);

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					frontendRepo,
					backendRepo,
				]);

				// Then: Should select frontend repo via description-tag routing
				expectRouting(result).shouldSelectRepositoryVia(
					frontendRepo,
					"description-tag",
				);
			});

			it("should route to repository when tag matches repository name case-insensitively", async () => {
				// Given: Repository with specific casing
				const repo = env
					.repository("repo-1", "MyApp")
					.inWorkspace("default-workspace")
					.build();

				// Issue has description with lowercase repo tag
				env.issueHasDescription("issue-1", "Fix bug in [repo=myapp]");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should select repo via description-tag routing
				expectRouting(result).shouldSelectRepositoryVia(
					repo,
					"description-tag",
				);
			});

			it("should route to repository when tag matches repository ID", async () => {
				// Given: Repositories with known IDs
				const targetRepo = env
					.repository("specific-repo-id", "Target Repo")
					.inWorkspace("default-workspace")
					.build();

				// Issue has description with repo ID tag
				env.issueHasDescription(
					"issue-1",
					"Work on [repo=specific-repo-id] feature",
				);

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					targetRepo,
				]);

				// Then: Should select repo via description-tag routing
				expectRouting(result).shouldSelectRepositoryVia(
					targetRepo,
					"description-tag",
				);
			});

			it("should take precedence over label-based routing", async () => {
				// Given: A repository matched by label, another by description tag
				const labelMatchedRepo = env
					.repository("repo-1", "Label Matched")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.build();

				const descriptionMatchedRepo = env
					.repository("repo-2", "Description Matched")
					.inWorkspace("default-workspace")
					.withGithubUrl("https://github.com/org/description-matched")
					.build();

				// Issue has both label and description tag
				env.issueHasLabels("issue-1", "frontend");
				env.issueHasDescription(
					"issue-1",
					"Work on [repo=org/description-matched]",
				);

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					labelMatchedRepo,
					descriptionMatchedRepo,
				]);

				// Then: Should select description-matched repo (higher priority)
				expectRouting(result).shouldSelectRepositoryVia(
					descriptionMatchedRepo,
					"description-tag",
				);
			});

			it("should continue to label routing when description has no repo tag", async () => {
				// Given: A repository with routing labels
				const repo = env
					.repository("repo-1", "Repo")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.build();

				// Issue has description without repo tag
				env.issueHasDescription(
					"issue-1",
					"This is a regular description without any tags",
				);
				env.issueHasLabels("issue-1", "frontend");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to label-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "label-based");
			});

			it("should continue to next priority when repo tag does not match any repository", async () => {
				// Given: A repository with routing labels
				const repo = env
					.repository("repo-1", "Actual Repo")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.build();

				// Issue has description with unmatched repo tag
				env.issueHasDescription(
					"issue-1",
					"Work on [repo=non-existent-repo] feature",
				);
				env.issueHasLabels("issue-1", "frontend");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to label-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "label-based");
			});

			it("should handle description fetching failures gracefully", async () => {
				// Given: A repository with routing labels
				const repo = env
					.repository("repo-1", "Repo")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.build();

				// Description fetching will fail
				env.descriptionFetchingFails();
				env.issueHasLabels("issue-1", "frontend");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository (should not throw)
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to label-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "label-based");
			});
		});

		describe("parseRepoTagsFromDescription", () => {
			it("should parse simple repo name", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Work on [repo=my-repo] feature",
				);
				expect(result).toEqual([{ repo: "my-repo" }]);
			});

			it("should parse org/repo format", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Fix bug in [repo=org/repo-name]",
				);
				expect(result).toEqual([{ repo: "org/repo-name" }]);
			});

			it("should parse repo with dots", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Work on [repo=my.dotted.repo]",
				);
				expect(result).toEqual([{ repo: "my.dotted.repo" }]);
			});

			it("should parse repo with underscores", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Fix [repo=my_repo_name]",
				);
				expect(result).toEqual([{ repo: "my_repo_name" }]);
			});

			it("should return all tags when multiple tags exist", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"[repo=first-repo] and [repo=second-repo]",
				);
				expect(result).toEqual([
					{ repo: "first-repo" },
					{ repo: "second-repo" },
				]);
			});

			it("should return empty array when no tag exists", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"This is a description without tags",
				);
				expect(result).toEqual([]);
			});

			it("should return empty array for malformed tags", () => {
				const result = env.router.parseRepoTagsFromDescription("[repo=]");
				expect(result).toEqual([]);
			});

			it("should return empty array for tags with spaces (invalid characters)", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"[repo=invalid chars here!]",
				);
				expect(result).toEqual([]);
			});

			it("should handle multiline descriptions", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Line 1\n\n[repo=my-repo]\n\nLine 3",
				);
				expect(result).toEqual([{ repo: "my-repo" }]);
			});

			it("should handle escaped brackets from Linear (\\[repo=...\\])", () => {
				// Linear escapes square brackets in descriptions
				const result = env.router.parseRepoTagsFromDescription(
					"test\\n\\n\\[repo=cyrus\\]",
				);
				expect(result).toEqual([{ repo: "cyrus" }]);
			});

			it("should handle escaped brackets with org/repo format", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Fix bug in \\[repo=org/repo-name\\]",
				);
				expect(result).toEqual([{ repo: "org/repo-name" }]);
			});

			it("should handle mixed escaped and unescaped brackets", () => {
				// Only the opening bracket is escaped
				const result = env.router.parseRepoTagsFromDescription(
					"Work on \\[repo=my-repo]",
				);
				expect(result).toEqual([{ repo: "my-repo" }]);
			});

			it("should handle only closing bracket escaped", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Work on [repo=my-repo\\]",
				);
				expect(result).toEqual([{ repo: "my-repo" }]);
			});

			it("should parse multiple tags with different formats", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Work on [repo=frontend] and [repo=org/backend] and \\[repo=shared-lib\\]",
				);
				expect(result).toEqual([
					{ repo: "frontend" },
					{ repo: "org/backend" },
					{ repo: "shared-lib" },
				]);
			});

			it("should parse branch override with # syntax", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Work on [repo=my-repo#feature-branch]",
				);
				expect(result).toEqual([{ repo: "my-repo", branch: "feature-branch" }]);
			});

			it("should parse multiple repos with mixed branch overrides", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"[repo=frontend#develop] and [repo=backend]",
				);
				expect(result).toEqual([
					{ repo: "frontend", branch: "develop" },
					{ repo: "backend" },
				]);
			});

			it("should parse org/repo format with branch override", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"[repo=org/repo-name#release/v2]",
				);
				expect(result).toEqual([
					{ repo: "org/repo-name", branch: "release/v2" },
				]);
			});

			// Unbracketed syntax tests
			it("should parse unbracketed repo= syntax", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"Some text\nrepo=my-repo",
				);
				expect(result).toEqual([{ repo: "my-repo" }]);
			});

			it("should parse unbracketed repos= syntax (plural)", () => {
				const result = env.router.parseRepoTagsFromDescription("repos=my-repo");
				expect(result).toEqual([{ repo: "my-repo" }]);
			});

			it("should parse comma-separated repos in unbracketed syntax", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"repo=cyrus,cyrus-hosted",
				);
				expect(result).toEqual([{ repo: "cyrus" }, { repo: "cyrus-hosted" }]);
			});

			it("should parse comma-separated repos with branch override", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"repos=cyrus,cyrus-hosted#feature-branch",
				);
				expect(result).toEqual([
					{ repo: "cyrus", branch: "feature-branch" },
					{ repo: "cyrus-hosted", branch: "feature-branch" },
				]);
			});

			it("should parse unbracketed repo= with branch but no comma", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"repo=my-repo#develop",
				);
				expect(result).toEqual([{ repo: "my-repo", branch: "develop" }]);
			});

			it("should deduplicate repos across bracketed and unbracketed syntax", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"[repo=cyrus] and also repo=cyrus,cyrus-hosted",
				);
				expect(result).toEqual([{ repo: "cyrus" }, { repo: "cyrus-hosted" }]);
			});

			it("should not match repo= inside URLs or paths", () => {
				const result = env.router.parseRepoTagsFromDescription(
					"See https://github.com/repo=something for details",
				);
				expect(result).toEqual([]);
			});
		});

		describe("parseEnvironmentTagFromDescription", () => {
			it("parses bracketed [env=name]", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"Please work on this [env=read-only] feature",
					),
				).toEqual({ name: "read-only", overrides: {} });
			});

			it("parses escaped-bracket form from Linear", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"intro text \\[env=staging\\] more text",
					),
				).toEqual({ name: "staging", overrides: {} });
			});

			it("parses unbracketed env=name at start of line", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"env=prod\nother content",
					),
				).toEqual({ name: "prod", overrides: {} });
			});

			it("parses unbracketed env=name after whitespace", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"line one\n env=team.qa something",
					),
				).toEqual({ name: "team.qa", overrides: {} });
			});

			it("returns null when no tag exists", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"just a description with no env tag",
					),
				).toBeNull();
			});

			it("returns null for empty descriptions", () => {
				expect(env.router.parseEnvironmentTagFromDescription("")).toBeNull();
			});

			it("returns only the first match when multiple tags are present", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"[env=first] and also [env=second]",
					),
				).toEqual({ name: "first", overrides: {} });
			});

			it("ignores env= inside URLs", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"See https://example.com/path?env=foo for details",
					),
				).toBeNull();
			});

			it("parses a single inline override", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"env=test$FEATURE_FLAG=1",
					),
				).toEqual({ name: "test", overrides: { FEATURE_FLAG: "1" } });
			});

			it("parses multiple inline overrides separated by comma+$", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"env=test$FEATURE_FLAG=1,$CYRUS_REMOTE=true",
					),
				).toEqual({
					name: "test",
					overrides: { FEATURE_FLAG: "1", CYRUS_REMOTE: "true" },
				});
			});

			it("parses inline overrides inside bracketed form", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"[env=test$FOO=bar,$BAZ=qux]",
					),
				).toEqual({
					name: "test",
					overrides: { FOO: "bar", BAZ: "qux" },
				});
			});

			it("silently drops malformed override keys (lowercase, numeric-start)", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"env=test$feature_flag=1,$1BAD=x,$GOOD_ONE=yes",
					),
				).toEqual({ name: "test", overrides: { GOOD_ONE: "yes" } });
			});

			it("silently drops overrides without an equals sign", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"env=test$NO_EQUALS,$REAL=ok",
					),
				).toEqual({ name: "test", overrides: { REAL: "ok" } });
			});

			it("allows = inside override values", () => {
				expect(
					env.router.parseEnvironmentTagFromDescription(
						"env=test$BASE64=YWJjPQ==",
					),
				).toEqual({ name: "test", overrides: { BASE64: "YWJjPQ==" } });
			});
		});
	});

	// ========================================================================
	// Priority 2: Label-Based Routing
	// ========================================================================

	describe("Priority 2: Label-Based Routing", () => {
		describe("when repositories have routing labels configured", () => {
			it("should route to repository when issue has matching label", async () => {
				// Given: A repository configured with routing label "frontend"
				const frontendRepo = env
					.repository("repo-1", "Frontend Repo")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.build();

				const backendRepo = env
					.repository("repo-2", "Backend Repo")
					.inWorkspace("default-workspace")
					.withLabels("backend")
					.build();

				env.issueHasLabels("issue-1", "frontend", "bug");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					frontendRepo,
					backendRepo,
				]);

				// Then: Should select frontend repo via label-based routing
				expectRouting(result).shouldSelectRepositoryVia(
					frontendRepo,
					"label-based",
				);
			});

			it("should route to first matching repository when multiple labels match", async () => {
				// Given: Multiple repositories with overlapping labels
				const repo1 = env
					.repository("repo-1", "First Repo")
					.inWorkspace("default-workspace")
					.withLabels("shared-label")
					.build();

				const repo2 = env
					.repository("repo-2", "Second Repo")
					.inWorkspace("default-workspace")
					.withLabels("shared-label")
					.build();

				env.issueHasLabels("issue-1", "shared-label");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo1,
					repo2,
				]);

				// Then: Should select first matching repository
				expectRouting(result).shouldSelectRepositoryVia(repo1, "label-based");
			});

			it("should continue to next priority when issue has no matching labels", async () => {
				// Given: Repository with routing labels but issue has different labels
				const repo = env
					.repository("repo-1", "Label Repo")
					.withLabels("frontend")
					.withTeams("TEST")
					.build();

				env.issueHasLabels("issue-1", "backend", "bug");

				const webhook = env
					.webhook()
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to team-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "team-based");
			});

			it("should handle label fetching failures gracefully and continue to next priority", async () => {
				// Given: Label fetching will fail
				const repo = env
					.repository("repo-1", "Repo")
					.withLabels("frontend")
					.withTeams("TEST")
					.build();

				env.labelFetchingFails();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository (should not throw)
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to team-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "team-based");
			});
		});
	});

	// ========================================================================
	// Priority 3: Project-Based Routing
	// ========================================================================

	describe("Priority 3: Project-Based Routing", () => {
		describe("when repositories have project keys configured", () => {
			it("should route to repository when issue is in matching project", async () => {
				// Given: A repository configured for "Mobile App" project
				const mobileRepo = env
					.repository("repo-1", "Mobile Repo")
					.inWorkspace("default-workspace")
					.withProjects("Mobile App")
					.build();

				const webRepo = env
					.repository("repo-2", "Web Repo")
					.inWorkspace("default-workspace")
					.withProjects("Web App")
					.build();

				env.issueIsInProject("issue-1", "Mobile App");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					mobileRepo,
					webRepo,
				]);

				// Then: Should select mobile repo via project-based routing
				expectRouting(result).shouldSelectRepositoryVia(
					mobileRepo,
					"project-based",
				);
			});

			it("should continue to next priority when issue has no project", async () => {
				// Given: Repository with project keys but issue has no project
				const repo = env
					.repository("repo-1", "Project Repo")
					.withProjects("Mobile App")
					.withTeams("TEST")
					.build();

				// Issue has no project (default in mock)

				const webhook = env
					.webhook()
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to team-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "team-based");
			});

			it("should continue to next priority when project does not match", async () => {
				// Given: Repository configured for different project
				const repo = env
					.repository("repo-1", "Project Repo")
					.withProjects("Mobile App")
					.withTeams("TEST")
					.build();

				env.issueIsInProject("issue-1", "Web App");

				const webhook = env
					.webhook()
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to team-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "team-based");
			});
		});
	});

	// ========================================================================
	// Priority 4: Team-Based Routing
	// ========================================================================

	describe("Priority 4: Team-Based Routing", () => {
		describe("when repositories have team keys configured", () => {
			it("should route to repository when webhook team matches repository team key", async () => {
				// Given: Repositories configured for different teams
				const engineeringRepo = env
					.repository("repo-1", "Engineering Repo")
					.inWorkspace("default-workspace")
					.withTeams("ENG")
					.build();

				const designRepo = env
					.repository("repo-2", "Design Repo")
					.inWorkspace("default-workspace")
					.withTeams("DESIGN")
					.build();

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "ENG-123")
					.inTeam("ENG")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					engineeringRepo,
					designRepo,
				]);

				// Then: Should select engineering repo via team-based routing
				expectRouting(result).shouldSelectRepositoryVia(
					engineeringRepo,
					"team-based",
				);
			});

			it("should route by team prefix from issue identifier when team key not in webhook", async () => {
				// Given: Repository configured for team ABC
				const repo = env
					.repository("repo-1", "ABC Team Repo")
					.withTeams("ABC")
					.build();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "ABC-123")
					.inTeam("") // Empty team key
					.build();
				webhook.agentSession.issue.team.key = undefined as any;

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should select repo via team prefix routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "team-prefix");
			});

			it("should continue to next priority when team does not match", async () => {
				// Given: Repositories with specific team keys
				const repo1 = env
					.repository("repo-1", "Team A Repo")
					.withTeams("TEAM_A")
					.build();

				const repo2 = env
					.repository("repo-2", "Catch All Repo")
					.asCatchAll()
					.build();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "OTHER-123")
					.inTeam("OTHER")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo1,
					repo2,
				]);

				// Then: Should fallback to catch-all routing
				expectRouting(result).shouldSelectRepositoryVia(repo2, "catch-all");
			});
		});
	});

	// ========================================================================
	// Priority 5: Catch-All Routing
	// ========================================================================

	describe("Priority 5: Catch-All Routing", () => {
		describe("when no specific routing rules match", () => {
			it("should route to catch-all repository with no routing configuration", async () => {
				// Given: One repository with routing config, one without
				const specificRepo = env
					.repository("repo-1", "Specific Repo")
					.withTeams("TEAM1")
					.build();

				const catchAllRepo = env
					.repository("repo-2", "Catch All Repo")
					.asCatchAll()
					.build();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "OTHER-123")
					.inTeam("OTHER")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					specificRepo,
					catchAllRepo,
				]);

				// Then: Should select catch-all repository
				expectRouting(result).shouldSelectRepositoryVia(
					catchAllRepo,
					"catch-all",
				);
			});

			it("should prefer first catch-all when multiple catch-all repositories exist", async () => {
				// Given: Multiple catch-all repositories
				const catchAll1 = env
					.repository("repo-1", "First Catch All")
					.asCatchAll()
					.build();

				const catchAll2 = env
					.repository("repo-2", "Second Catch All")
					.asCatchAll()
					.build();

				const webhook = env.webhook().forIssue("issue-1", "TEST-123").build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					catchAll1,
					catchAll2,
				]);

				// Then: Should select first catch-all repository
				expectRouting(result).shouldSelectRepositoryVia(catchAll1, "catch-all");
			});
		});
	});

	// ========================================================================
	// Workspace Fallback & Edge Cases
	// ========================================================================

	describe("Workspace Fallback & Edge Cases", () => {
		describe("when single repository exists", () => {
			it("should request user selection when single configured repository doesn't match routing", async () => {
				// Given: Single repository with specific team configuration that doesn't match
				const repo = env
					.repository("repo-1", "Only Repo")
					.withTeams("TEAM1")
					.build();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "OTHER-123")
					.inTeam("OTHER")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: No default assignment — request user selection
				expectRouting(result).shouldNeedSelectionWithRepos(1);
			});
		});

		describe("when multiple repositories exist with no routing match", () => {
			it("should request user selection when multiple configured repositories don't match", async () => {
				// Given: Multiple repositories with specific configurations
				const repo1 = env
					.repository("repo-1", "Repo 1")
					.withTeams("TEAM1")
					.build();

				const repo2 = env
					.repository("repo-2", "Repo 2")
					.withTeams("TEAM2")
					.build();

				const webhook = env
					.webhook()
					.forIssue("issue-1", "OTHER-123")
					.inTeam("OTHER")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo1,
					repo2,
				]);

				// Then: Should request user selection
				expectRouting(result).shouldNeedSelectionWithRepos(2);
			});
		});

		describe("when no repositories exist", () => {
			it("should return none when no repositories configured", async () => {
				// Given: No repositories
				const webhook = env.webhook().build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(
					webhook,
					[],
				);

				// Then: Should return none
				expectRouting(result).shouldSelectNothing();
			});

			it("should return workspace fallback when no workspace ID in webhook", async () => {
				// Given: Repository but no workspace ID
				const repo = env.repository("repo-1", "Repo").build();

				const webhook = env.webhook().build();
				webhook.organizationId = undefined as any;

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should fallback to first repo
				expectRouting(result).shouldSelectRepositoryVia(
					repo,
					"workspace-fallback",
				);
			});

			it("should return none when repositories exist but in different workspace", async () => {
				// Given: Repository in different workspace
				const repo = env
					.repository("repo-1", "Repo")
					.inWorkspace("workspace-1")
					.build();

				const webhook = env.webhook().inWorkspace("workspace-2").build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should return none
				expectRouting(result).shouldSelectNothing();
			});
		});
	});

	// ========================================================================
	// Repository Selection Elicitation
	// ========================================================================

	describe("Repository Selection Elicitation", () => {
		describe("when posting repository selection to Linear", () => {
			it("should create elicitation activity with repository options", async () => {
				// Given: Multiple repositories to choose from
				const repo1 = env
					.repository("repo-1", "Frontend Repo")
					.withGithubUrl("https://github.com/org/frontend")
					.build();

				const repo2 = env
					.repository("repo-2", "Backend Repo")
					.withGithubUrl("https://github.com/org/backend")
					.build();

				const webhook = env.webhook().withSession("session-123").build();

				// When: Eliciting user selection
				await env.router.elicitUserRepositorySelection(webhook, [repo1, repo2]);

				// Then: Should post elicitation with correct options
				expect(env.mockLinearClient.createAgentActivity).toHaveBeenCalledWith({
					agentSessionId: "session-123",
					content: {
						type: "elicitation",
						body: "Which repository should I work in for this issue?",
					},
					signal: AgentActivitySignal.Select,
					signalMetadata: {
						options: [
							{ value: "https://github.com/org/frontend" },
							{ value: "https://github.com/org/backend" },
						],
					},
				});
			});

			it("should use repository name as option value when GitHub URL not available", async () => {
				// Given: Repository without GitHub URL
				const repo = env.repository("repo-1", "Local Repo").build(); // No GitHub URL

				const webhook = env.webhook().build();

				// When: Eliciting user selection
				await env.router.elicitUserRepositorySelection(webhook, [repo]);

				// Then: Should use repository name
				expect(env.mockLinearClient.createAgentActivity).toHaveBeenCalledWith(
					expect.objectContaining({
						signalMetadata: {
							options: [{ value: "Local Repo" }],
						},
					}),
				);
			});

			it("should store pending selection for later processing", async () => {
				// Given: Repository selection scenario
				const repo = env.repository("repo-1", "Repo").build();
				const webhook = env.webhook().withSession("session-123").build();

				// When: Eliciting user selection
				await env.router.elicitUserRepositorySelection(webhook, [repo]);

				// Then: Should have pending selection
				expect(env.router.hasPendingSelection("session-123")).toBe(true);
			});

			it("should post error activity when elicitation fails", async () => {
				// Given: Elicitation will fail
				const repo = env.repository("repo-1", "Repo").build();
				const webhook = env.webhook().build();

				env.mockLinearClient.createAgentActivity = vi
					.fn()
					.mockRejectedValueOnce(new Error("API error"))
					.mockResolvedValueOnce({}); // Error activity succeeds

				// When: Eliciting user selection
				await env.router.elicitUserRepositorySelection(webhook, [repo]);

				// Then: Should post error activity
				expect(env.mockLinearClient.createAgentActivity).toHaveBeenCalledTimes(
					2,
				);
				expect(
					env.mockLinearClient.createAgentActivity,
				).toHaveBeenNthCalledWith(
					2,
					expect.objectContaining({
						content: {
							type: "error",
							body: expect.stringContaining(
								"Failed to display repository selection",
							),
						},
					}),
				);
			});

			it("should clean up pending selection when both elicitation and error posting fail", async () => {
				// Given: Both elicitation and error posting will fail
				const repo = env.repository("repo-1", "Repo").build();
				const webhook = env.webhook().withSession("session-123").build();

				env.mockLinearClient.createAgentActivity = vi
					.fn()
					.mockRejectedValue(new Error("API error"));

				// When: Eliciting user selection (should not throw)
				await env.router.elicitUserRepositorySelection(webhook, [repo]);

				// Then: Should have cleaned up pending selection
				expect(env.router.hasPendingSelection("session-123")).toBe(false);
			});
		});
	});

	// ========================================================================
	// Repository Selection Response Handling
	// ========================================================================

	describe("Repository Selection Response Handling", () => {
		describe("when processing user repository selection", () => {
			it("should find and return repository matching GitHub URL selection", async () => {
				// Given: User selecting repository by GitHub URL
				const repo1 = env
					.repository("repo-1", "Frontend")
					.withGithubUrl("https://github.com/org/frontend")
					.build();

				const repo2 = env
					.repository("repo-2", "Backend")
					.withGithubUrl("https://github.com/org/backend")
					.build();

				const webhook = env.webhook().withSession("session-1").build();
				await env.router.elicitUserRepositorySelection(webhook, [repo1, repo2]);

				// When: User selects backend repository
				const result = await env.router.selectRepositoryFromResponse(
					"session-1",
					"https://github.com/org/backend",
				);

				// Then: Should return backend repository
				expect(result).toBe(repo2);
			});

			it("should find and return repository matching name selection", async () => {
				// Given: User selecting repository by name
				const repo1 = env.repository("repo-1", "Frontend Repo").build();
				const repo2 = env.repository("repo-2", "Backend Repo").build();

				const webhook = env.webhook().withSession("session-1").build();
				await env.router.elicitUserRepositorySelection(webhook, [repo1, repo2]);

				// When: User selects backend repository by name
				const result = await env.router.selectRepositoryFromResponse(
					"session-1",
					"Backend Repo",
				);

				// Then: Should return backend repository
				expect(result).toBe(repo2);
			});

			it("should fallback to first repository when selection not found", async () => {
				// Given: User selecting non-existent repository
				const repo1 = env.repository("repo-1", "Repo 1").build();
				const repo2 = env.repository("repo-2", "Repo 2").build();

				const webhook = env.webhook().withSession("session-1").build();
				await env.router.elicitUserRepositorySelection(webhook, [repo1, repo2]);

				// When: User provides invalid selection
				const result = await env.router.selectRepositoryFromResponse(
					"session-1",
					"Non-existent Repo",
				);

				// Then: Should fallback to first repository
				expect(result).toBe(repo1);
			});

			it("should return null when no pending selection exists for session", async () => {
				// Given: No pending selection

				// When: Attempting to process selection
				const result = await env.router.selectRepositoryFromResponse(
					"non-existent-session",
					"Some Repo",
				);

				// Then: Should return null
				expect(result).toBeNull();
			});

			it("should remove pending selection after processing", async () => {
				// Given: Pending repository selection
				const repo = env.repository("repo-1", "Repo").build();
				const webhook = env.webhook().withSession("session-1").build();
				await env.router.elicitUserRepositorySelection(webhook, [repo]);

				expect(env.router.hasPendingSelection("session-1")).toBe(true);

				// When: Processing user selection
				await env.router.selectRepositoryFromResponse("session-1", "Repo");

				// Then: Should remove pending selection
				expect(env.router.hasPendingSelection("session-1")).toBe(false);
			});
		});

		describe("when managing pending selections", () => {
			it("should correctly track pending selections", async () => {
				// Given: Multiple pending selections
				const repo1 = env.repository("repo-1", "Repo 1").build();
				const repo2 = env.repository("repo-2", "Repo 2").build();

				const webhook1 = env.webhook().withSession("session-1").build();
				const webhook2 = env.webhook().withSession("session-2").build();

				// When: Creating pending selections
				await env.router.elicitUserRepositorySelection(webhook1, [repo1]);
				await env.router.elicitUserRepositorySelection(webhook2, [repo2]);

				// Then: Both should be tracked
				expect(env.router.hasPendingSelection("session-1")).toBe(true);
				expect(env.router.hasPendingSelection("session-2")).toBe(true);

				// When: Processing one selection
				await env.router.selectRepositoryFromResponse("session-1", "Repo 1");

				// Then: Only processed one should be removed
				expect(env.router.hasPendingSelection("session-1")).toBe(false);
				expect(env.router.hasPendingSelection("session-2")).toBe(true);
			});
		});
	});

	// ========================================================================
	// Complex Routing Priority Tests
	// ========================================================================

	describe("Complex Routing Scenarios", () => {
		describe("when multiple routing methods could apply", () => {
			it("should prioritize label routing over project routing", async () => {
				// Given: Repository configured with both labels and projects
				const repo = env
					.repository("repo-1", "Full Config Repo")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.withProjects("Mobile App")
					.withTeams("TEST")
					.build();

				env.issueHasLabels("issue-1", "frontend");
				env.issueIsInProject("issue-1", "Mobile App");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should use label-based routing (highest priority)
				expectRouting(result).shouldSelectRepositoryVia(repo, "label-based");
			});

			it("should prioritize project routing over team routing", async () => {
				// Given: Repository configured with projects and teams
				const repo = env
					.repository("repo-1", "Project & Team Repo")
					.inWorkspace("default-workspace")
					.withProjects("Mobile App")
					.withTeams("TEST")
					.build();

				env.issueIsInProject("issue-1", "Mobile App");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should use project-based routing
				expectRouting(result).shouldSelectRepositoryVia(repo, "project-based");
			});

			it("should prioritize team routing over catch-all", async () => {
				// Given: Both team-specific and catch-all repositories
				const teamRepo = env
					.repository("repo-1", "Team Repo")
					.inWorkspace("default-workspace")
					.withTeams("TEST")
					.build();

				const catchAllRepo = env
					.repository("repo-2", "Catch All")
					.inWorkspace("default-workspace")
					.asCatchAll()
					.build();

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-123")
					.inTeam("TEST")
					.build();

				// When: Determining repository
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					teamRepo,
					catchAllRepo,
				]);

				// Then: Should use team-based routing
				expectRouting(result).shouldSelectRepositoryVia(teamRepo, "team-based");
			});
		});

		describe("when routing priority chain is fully tested", () => {
			it("should traverse entire priority chain from label to catch-all", async () => {
				// Given: Repository with all routing configs
				const fullRepo = env
					.repository("repo-full", "Full Config")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.withProjects("Mobile")
					.withTeams("FULL")
					.build();

				const catchAllRepo = env
					.repository("repo-catch", "Catch All")
					.inWorkspace("default-workspace")
					.asCatchAll()
					.build();

				// Test Priority 2: Label routing
				env.issueHasLabels("issue-1", "frontend");
				let webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-1")
					.build();
				let result = await env.router.determineRepositoryForWebhook(webhook, [
					fullRepo,
					catchAllRepo,
				]);
				expectRouting(result).shouldSelectRepositoryVia(
					fullRepo,
					"label-based",
				);

				// Test Priority 3: Project routing (no labels)
				env.issueHasLabels("issue-2", "other-label");
				env.issueIsInProject("issue-2", "Mobile");
				webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-2", "TEST-2")
					.build();
				result = await env.router.determineRepositoryForWebhook(webhook, [
					fullRepo,
					catchAllRepo,
				]);
				expectRouting(result).shouldSelectRepositoryVia(
					fullRepo,
					"project-based",
				);

				// Test Priority 4: Team routing (no labels or project match)
				env.issueHasLabels("issue-3", "other-label");
				env.issueIsInProject("issue-3", "Other Project");
				webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-3", "FULL-3")
					.inTeam("FULL")
					.build();
				result = await env.router.determineRepositoryForWebhook(webhook, [
					fullRepo,
					catchAllRepo,
				]);
				expectRouting(result).shouldSelectRepositoryVia(fullRepo, "team-based");

				// Test Priority 5: Catch-all (nothing matches)
				env.issueHasLabels("issue-4", "other-label");
				env.issueIsInProject("issue-4", "Other Project");
				webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-4", "OTHER-4")
					.inTeam("OTHER")
					.build();
				result = await env.router.determineRepositoryForWebhook(webhook, [
					fullRepo,
					catchAllRepo,
				]);
				expectRouting(result).shouldSelectRepositoryVia(
					catchAllRepo,
					"catch-all",
				);
			});
		});
	});

	// ========================================================================
	// Multi-Repo Routing Tests
	// ========================================================================

	describe("Multi-Repo Routing", () => {
		describe("when multiple [repo=...] description tags exist", () => {
			it("should return all matching repositories via description-tag routing", async () => {
				// Given: Two repos matching two description tags
				const frontendRepo = env
					.repository("repo-1", "frontend")
					.inWorkspace("default-workspace")
					.build();
				const backendRepo = env
					.repository("repo-2", "backend")
					.inWorkspace("default-workspace")
					.build();

				env.issueHasDescription(
					"issue-1",
					"Work on [repo=frontend] and [repo=backend]",
				);

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-1")
					.build();

				// When: Determining repositories
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					frontendRepo,
					backendRepo,
				]);

				// Then: Should return both repos
				expectRouting(result).shouldSelectRepositoriesVia(
					[frontendRepo, backendRepo],
					"description-tag",
				);
			});

			it("should not duplicate repos when same tag matches twice", async () => {
				// Given: A repo that could match by name and by URL
				const repo = env
					.repository("repo-1", "my-repo")
					.inWorkspace("default-workspace")
					.withGithubUrl("https://github.com/org/my-repo")
					.build();

				env.issueHasDescription("issue-1", "[repo=my-repo] [repo=org/my-repo]");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-1")
					.build();

				// When
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo,
				]);

				// Then: Should return only one repo (deduplicated)
				expectRouting(result).shouldSelectRepositoriesVia(
					[repo],
					"description-tag",
				);
			});

			it("should skip team-based routing when description tags match", async () => {
				// Given: A repo matching by description tag AND by team
				const descRepo = env
					.repository("repo-1", "desc-match")
					.inWorkspace("default-workspace")
					.build();
				const teamRepo = env
					.repository("repo-2", "team-match")
					.inWorkspace("default-workspace")
					.withTeams("TEST")
					.build();

				env.issueHasDescription("issue-1", "[repo=desc-match]");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-1")
					.inTeam("TEST")
					.build();

				// When
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					descRepo,
					teamRepo,
				]);

				// Then: Description-tag takes priority; team routing is skipped
				expectRouting(result).shouldSelectRepositoriesVia(
					[descRepo],
					"description-tag",
				);
			});
		});

		describe("when label-based routing matches multiple repos", () => {
			it("should return all label-matched repositories", async () => {
				// Given: Two repos both matching the same routing label
				const repo1 = env
					.repository("repo-1", "Repo A")
					.inWorkspace("default-workspace")
					.withLabels("monorepo")
					.build();
				const repo2 = env
					.repository("repo-2", "Repo B")
					.inWorkspace("default-workspace")
					.withLabels("monorepo")
					.build();

				env.issueHasLabels("issue-1", "monorepo");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-1")
					.build();

				// When
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo1,
					repo2,
				]);

				// Then: Both repos matched
				expectRouting(result).shouldSelectRepositoriesVia(
					[repo1, repo2],
					"label-based",
				);
			});

			it("should skip team-based routing when labels match", async () => {
				// Given: A repo matching by label AND a different repo matching by team
				const labelRepo = env
					.repository("repo-1", "Label Match")
					.inWorkspace("default-workspace")
					.withLabels("frontend")
					.build();
				const teamRepo = env
					.repository("repo-2", "Team Match")
					.inWorkspace("default-workspace")
					.withTeams("TEST")
					.build();

				env.issueHasLabels("issue-1", "frontend");

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "TEST-1")
					.inTeam("TEST")
					.build();

				// When
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					labelRepo,
					teamRepo,
				]);

				// Then: Label routing wins; team routing skipped
				expectRouting(result).shouldSelectRepositoriesVia(
					[labelRepo],
					"label-based",
				);
			});
		});

		describe("when no routing matches", () => {
			it("should return needs_selection instead of default assignment", async () => {
				// Given: Repos with routing config that doesn't match
				const repo1 = env
					.repository("repo-1", "Repo A")
					.inWorkspace("default-workspace")
					.withTeams("TEAM1")
					.build();
				const repo2 = env
					.repository("repo-2", "Repo B")
					.inWorkspace("default-workspace")
					.withTeams("TEAM2")
					.build();

				const webhook = env
					.webhook()
					.inWorkspace("default-workspace")
					.forIssue("issue-1", "OTHER-1")
					.inTeam("OTHER")
					.build();

				// When
				const result = await env.router.determineRepositoryForWebhook(webhook, [
					repo1,
					repo2,
				]);

				// Then: No default — prompt user
				expectRouting(result).shouldNeedSelectionWithRepos(2);
			});
		});

		describe("cache migration from old format", () => {
			it("should migrate old string values to string[] on restore", () => {
				// Given: Old format cache (string values instead of string[])
				const oldCache = new Map<string, string | string[]>([
					["issue-1", "repo-1"],
					["issue-2", "repo-2"],
				]);

				// When: Restoring from old format
				env.router.restoreIssueRepositoryCache(oldCache);

				// Then: All values should be string[]
				const cache = env.router.getIssueRepositoryCache();
				expect(cache.get("issue-1")).toEqual(["repo-1"]);
				expect(cache.get("issue-2")).toEqual(["repo-2"]);
			});

			it("should preserve new string[] values on restore", () => {
				// Given: New format cache
				const newCache = new Map<string, string[]>([
					["issue-1", ["repo-1", "repo-2"]],
					["issue-2", ["repo-3"]],
				]);

				// When: Restoring
				env.router.restoreIssueRepositoryCache(newCache);

				// Then: Values should be preserved
				const cache = env.router.getIssueRepositoryCache();
				expect(cache.get("issue-1")).toEqual(["repo-1", "repo-2"]);
				expect(cache.get("issue-2")).toEqual(["repo-3"]);
			});

			it("should handle mixed old and new format values", () => {
				// Given: Cache with both old string and new string[] values
				const mixedCache = new Map<string, string | string[]>([
					["issue-1", "repo-1"], // old format
					["issue-2", ["repo-2", "repo-3"]], // new format
				]);

				// When: Restoring
				env.router.restoreIssueRepositoryCache(mixedCache);

				// Then: All migrated to string[]
				const cache = env.router.getIssueRepositoryCache();
				expect(cache.get("issue-1")).toEqual(["repo-1"]);
				expect(cache.get("issue-2")).toEqual(["repo-2", "repo-3"]);
			});
		});
	});

	describe("parseEnvironmentTagFromDescription", () => {
		it("parses bracketed [env=name]", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription("Run this in [env=prod]"),
			).toEqual({ name: "prod", overrides: {} });
		});

		it("parses unbracketed env=name at start of line", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription(
					"env=staging\n\nDo the thing",
				),
			).toEqual({ name: "staging", overrides: {} });
		});

		it("parses env=name after whitespace", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription(
					"hello env=read-only world",
				),
			).toEqual({ name: "read-only", overrides: {} });
		});

		it("handles Linear's escaped brackets", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription("Run in \\[env=prod\\]"),
			).toEqual({ name: "prod", overrides: {} });
		});

		it("returns only the first match when multiple exist", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription(
					"[env=first] and [env=second]",
				),
			).toEqual({ name: "first", overrides: {} });
		});

		it("returns null when no tag is present", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription(
					"A description without tags",
				),
			).toBeNull();
		});

		it("returns null on empty description", () => {
			expect(env.router.parseEnvironmentTagFromDescription("")).toBeNull();
		});

		it("rejects names with invalid characters", () => {
			expect(
				env.router.parseEnvironmentTagFromDescription("[env=has spaces]"),
			).toBeNull();
		});
	});
});
