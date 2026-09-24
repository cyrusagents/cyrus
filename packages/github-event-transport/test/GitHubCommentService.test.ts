import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubCommentService } from "../src/GitHubCommentService.js";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("GitHubCommentService", () => {
	let service: GitHubCommentService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = new GitHubCommentService();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("constructor", () => {
		it("uses default GitHub API URL", () => {
			const defaultService = new GitHubCommentService();
			// Verify by making a request and checking the URL
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: 1,
					html_url: "https://example.com",
					body: "test",
				}),
			});

			void defaultService.postIssueComment({
				token: "test-token",
				owner: "testorg",
				repo: "my-repo",
				issueNumber: 42,
				body: "Hello",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/issues/42/comments",
				expect.any(Object),
			);
		});

		it("accepts custom API base URL", () => {
			const customService = new GitHubCommentService({
				apiBaseUrl: "https://github.example.com/api/v3",
			});

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					id: 1,
					html_url: "https://example.com",
					body: "test",
				}),
			});

			void customService.postIssueComment({
				token: "test-token",
				owner: "testorg",
				repo: "my-repo",
				issueNumber: 42,
				body: "Hello",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://github.example.com/api/v3/repos/testorg/my-repo/issues/42/comments",
				expect.any(Object),
			);
		});
	});

	describe("postIssueComment", () => {
		it("posts a comment to the correct endpoint", async () => {
			const mockResponse = {
				id: 12345,
				html_url:
					"https://github.com/testorg/my-repo/pull/42#issuecomment-12345",
				body: "Hello from Miko!",
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockResponse,
			});

			const result = await service.postIssueComment({
				token: "ghp_test123",
				owner: "testorg",
				repo: "my-repo",
				issueNumber: 42,
				body: "Hello from Miko!",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/issues/42/comments",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer ghp_test123",
						Accept: "application/vnd.github+json",
						"Content-Type": "application/json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					body: JSON.stringify({ body: "Hello from Miko!" }),
				},
			);

			expect(result).toEqual(mockResponse);
		});

		it("throws on non-OK response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 403,
				statusText: "Forbidden",
				text: async () =>
					'{"message":"Resource not accessible by integration"}',
			});

			await expect(
				service.postIssueComment({
					token: "bad-token",
					owner: "testorg",
					repo: "my-repo",
					issueNumber: 42,
					body: "Hello",
				}),
			).rejects.toThrow(
				"[GitHubCommentService] Failed to post issue comment: 403 Forbidden",
			);
		});
	});

	describe("addReaction", () => {
		it("adds a reaction to an issue comment", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ id: 901 }),
			});

			await service.addReaction({
				token: "ghp_test123",
				owner: "testorg",
				repo: "my-repo",
				commentId: 555,
				isPullRequestReviewComment: false,
				content: "eyes",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/issues/comments/555/reactions",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer ghp_test123",
						Accept: "application/vnd.github+json",
						"Content-Type": "application/json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					body: JSON.stringify({ content: "eyes" }),
				},
			);
		});

		it("adds a reaction to a PR review comment", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ id: 901 }),
			});

			await service.addReaction({
				token: "ghp_test123",
				owner: "testorg",
				repo: "my-repo",
				commentId: 777,
				isPullRequestReviewComment: true,
				content: "eyes",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/pulls/comments/777/reactions",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer ghp_test123",
						Accept: "application/vnd.github+json",
						"Content-Type": "application/json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					body: JSON.stringify({ content: "eyes" }),
				},
			);
		});

		it("throws on non-OK response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 422,
				statusText: "Unprocessable Entity",
				text: async () => '{"message":"Validation Failed"}',
			});

			await expect(
				service.addReaction({
					token: "ghp_test123",
					owner: "testorg",
					repo: "my-repo",
					commentId: 555,
					isPullRequestReviewComment: false,
					content: "eyes",
				}),
			).rejects.toThrow(
				"[GitHubCommentService] Failed to add reaction: 422 Unprocessable Entity",
			);
		});

		it("respects custom base URL", () => {
			const customService = new GitHubCommentService({
				apiBaseUrl: "https://github.example.com/api/v3",
			});

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ id: 901 }),
			});

			void customService.addReaction({
				token: "test-token",
				owner: "testorg",
				repo: "my-repo",
				commentId: 123,
				isPullRequestReviewComment: false,
				content: "eyes",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://github.example.com/api/v3/repos/testorg/my-repo/issues/comments/123/reactions",
				expect.any(Object),
			);
		});
	});

	describe("postReviewCommentReply", () => {
		it("posts a reply to the correct endpoint", async () => {
			const mockResponse = {
				id: 67890,
				html_url:
					"https://github.com/testorg/my-repo/pull/42#discussion_r67890",
				body: "Fixed the error handling!",
			};

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => mockResponse,
			});

			const result = await service.postReviewCommentReply({
				token: "ghp_test123",
				owner: "testorg",
				repo: "my-repo",
				pullNumber: 42,
				commentId: 888,
				body: "Fixed the error handling!",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/pulls/42/comments/888/replies",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer ghp_test123",
						Accept: "application/vnd.github+json",
						"Content-Type": "application/json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					body: JSON.stringify({ body: "Fixed the error handling!" }),
				},
			);

			expect(result).toEqual(mockResponse);
		});

		it("throws on non-OK response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
				statusText: "Not Found",
				text: async () => '{"message":"Not Found"}',
			});

			await expect(
				service.postReviewCommentReply({
					token: "ghp_test123",
					owner: "testorg",
					repo: "my-repo",
					pullNumber: 42,
					commentId: 888,
					body: "Reply",
				}),
			).rejects.toThrow(
				"[GitHubCommentService] Failed to post review comment reply: 404 Not Found",
			);
		});
	});

	describe("hasRepoWriteAccess", () => {
		const params = {
			token: "ghs_test",
			owner: "testorg",
			repo: "my-repo",
			username: "alice",
		};

		it("allows write permission", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					permission: "write",
					role_name: "write",
					permissions: { pull: true, push: true, admin: false },
				}),
			});

			await expect(service.hasRepoWriteAccess(params)).resolves.toEqual({
				allowed: true,
				permission: "write",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/collaborators/alice/permission",
				expect.objectContaining({
					headers: expect.objectContaining({
						Authorization: "Bearer ghs_test",
					}),
				}),
			);
		});

		it("allows admin permission", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ permission: "admin", role_name: "admin" }),
			});

			await expect(service.hasRepoWriteAccess(params)).resolves.toEqual({
				allowed: true,
				permission: "admin",
			});
		});

		it("allows maintain permission", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					permission: "maintain",
					role_name: "maintain",
				}),
			});

			await expect(service.hasRepoWriteAccess(params)).resolves.toEqual({
				allowed: true,
				permission: "maintain",
			});
		});

		it("denies read permission", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({
					permission: "read",
					role_name: "read",
					permissions: { pull: true, push: false, admin: false },
				}),
			});

			await expect(service.hasRepoWriteAccess(params)).resolves.toEqual({
				allowed: false,
				permission: "read",
				reason: "insufficient_permission",
			});
		});

		it("denies 404 (not a collaborator)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 404,
				statusText: "Not Found",
			});

			await expect(service.hasRepoWriteAccess(params)).resolves.toEqual({
				allowed: false,
				permission: null,
				reason: "not_a_collaborator",
			});
		});

		it("URL-encodes usernames with brackets", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				status: 200,
				json: async () => ({ permission: "write" }),
			});

			await service.hasRepoWriteAccess({
				...params,
				username: "dependabot[bot]",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://api.github.com/repos/testorg/my-repo/collaborators/dependabot%5Bbot%5D/permission",
				expect.any(Object),
			);
		});
	});
});
