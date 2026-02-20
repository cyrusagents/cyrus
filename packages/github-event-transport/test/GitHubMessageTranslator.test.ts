import type { GitHubSessionStartPlatformData } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { GitHubMessageTranslator } from "../src/GitHubMessageTranslator.js";
import type {
	GitHubIssueCommentPayload,
	GitHubPullRequestReviewCommentPayload,
	GitHubWebhookEvent,
} from "../src/types.js";

describe("GitHubMessageTranslator", () => {
	const translator = new GitHubMessageTranslator();

	const createMockIssueCommentPayload = (
		overrides: Partial<GitHubIssueCommentPayload> = {},
	): GitHubIssueCommentPayload => ({
		action: "created",
		issue: {
			id: 123,
			number: 42,
			title: "Test PR",
			body: "PR description",
			state: "open",
			html_url: "https://github.com/owner/repo/pull/42",
			url: "https://api.github.com/repos/owner/repo/issues/42",
			user: {
				login: "author",
				id: 1,
				avatar_url: "https://avatars.githubusercontent.com/u/1",
				html_url: "https://github.com/author",
				type: "User",
			},
			pull_request: {
				url: "https://api.github.com/repos/owner/repo/pulls/42",
				html_url: "https://github.com/owner/repo/pull/42",
				diff_url: "https://github.com/owner/repo/pull/42.diff",
				patch_url: "https://github.com/owner/repo/pull/42.patch",
			},
		},
		comment: {
			id: 456,
			body: "@cyrus please review this PR",
			html_url: "https://github.com/owner/repo/pull/42#issuecomment-456",
			url: "https://api.github.com/repos/owner/repo/issues/comments/456",
			user: {
				login: "commenter",
				id: 2,
				avatar_url: "https://avatars.githubusercontent.com/u/2",
				html_url: "https://github.com/commenter",
				type: "User",
			},
			created_at: "2025-01-27T12:00:00Z",
			updated_at: "2025-01-27T12:00:00Z",
		},
		repository: {
			id: 789,
			name: "repo",
			full_name: "owner/repo",
			html_url: "https://github.com/owner/repo",
			clone_url: "https://github.com/owner/repo.git",
			ssh_url: "git@github.com:owner/repo.git",
			default_branch: "main",
			owner: {
				login: "owner",
				id: 3,
				avatar_url: "https://avatars.githubusercontent.com/u/3",
				html_url: "https://github.com/owner",
				type: "Organization",
			},
		},
		sender: {
			login: "commenter",
			id: 2,
			avatar_url: "https://avatars.githubusercontent.com/u/2",
			html_url: "https://github.com/commenter",
			type: "User",
		},
		installation: {
			id: 12345,
			node_id: "MDIzOkluc3RhbGxhdGlvbjEyMzQ1",
		},
		...overrides,
	});

	const createMockPRReviewCommentPayload = (
		overrides: Partial<GitHubPullRequestReviewCommentPayload> = {},
	): GitHubPullRequestReviewCommentPayload => ({
		action: "created",
		pull_request: {
			id: 123,
			number: 42,
			title: "Test PR",
			body: "PR description",
			state: "open",
			html_url: "https://github.com/owner/repo/pull/42",
			url: "https://api.github.com/repos/owner/repo/pulls/42",
			head: {
				label: "owner:feature-branch",
				ref: "feature-branch",
				sha: "abc123",
				repo: {
					id: 789,
					name: "repo",
					full_name: "owner/repo",
					html_url: "https://github.com/owner/repo",
					clone_url: "https://github.com/owner/repo.git",
					ssh_url: "git@github.com:owner/repo.git",
					default_branch: "main",
					owner: {
						login: "owner",
						id: 3,
						avatar_url: "https://avatars.githubusercontent.com/u/3",
						html_url: "https://github.com/owner",
						type: "Organization",
					},
				},
			},
			base: {
				label: "owner:main",
				ref: "main",
				sha: "def456",
				repo: {
					id: 789,
					name: "repo",
					full_name: "owner/repo",
					html_url: "https://github.com/owner/repo",
					clone_url: "https://github.com/owner/repo.git",
					ssh_url: "git@github.com:owner/repo.git",
					default_branch: "main",
					owner: {
						login: "owner",
						id: 3,
						avatar_url: "https://avatars.githubusercontent.com/u/3",
						html_url: "https://github.com/owner",
						type: "Organization",
					},
				},
			},
			user: {
				login: "author",
				id: 1,
				avatar_url: "https://avatars.githubusercontent.com/u/1",
				html_url: "https://github.com/author",
				type: "User",
			},
		},
		comment: {
			id: 456,
			body: "Please fix this line",
			html_url: "https://github.com/owner/repo/pull/42#discussion_r456",
			url: "https://api.github.com/repos/owner/repo/pulls/comments/456",
			user: {
				login: "reviewer",
				id: 4,
				avatar_url: "https://avatars.githubusercontent.com/u/4",
				html_url: "https://github.com/reviewer",
				type: "User",
			},
			created_at: "2025-01-27T12:00:00Z",
			updated_at: "2025-01-27T12:00:00Z",
			path: "src/file.ts",
			diff_hunk: "@@ -10,6 +10,7 @@ function foo() {",
			commit_id: "abc123",
		},
		repository: {
			id: 789,
			name: "repo",
			full_name: "owner/repo",
			html_url: "https://github.com/owner/repo",
			clone_url: "https://github.com/owner/repo.git",
			ssh_url: "git@github.com:owner/repo.git",
			default_branch: "main",
			owner: {
				login: "owner",
				id: 3,
				avatar_url: "https://avatars.githubusercontent.com/u/3",
				html_url: "https://github.com/owner",
				type: "Organization",
			},
		},
		sender: {
			login: "reviewer",
			id: 4,
			avatar_url: "https://avatars.githubusercontent.com/u/4",
			html_url: "https://github.com/reviewer",
			type: "User",
		},
		...overrides,
	});

	describe("canTranslate", () => {
		it("should return true for issue_comment events", () => {
			const event: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "delivery-123",
				payload: createMockIssueCommentPayload(),
			};
			expect(translator.canTranslate(event)).toBe(true);
		});

		it("should return true for pull_request_review_comment events", () => {
			const event: GitHubWebhookEvent = {
				eventType: "pull_request_review_comment",
				deliveryId: "delivery-123",
				payload: createMockPRReviewCommentPayload(),
			};
			expect(translator.canTranslate(event)).toBe(true);
		});

		it("should return false for null", () => {
			expect(translator.canTranslate(null)).toBe(false);
		});

		it("should return false for undefined", () => {
			expect(translator.canTranslate(undefined)).toBe(false);
		});

		it("should return false for non-object", () => {
			expect(translator.canTranslate("string")).toBe(false);
		});

		it("should return false for missing eventType", () => {
			const event = {
				deliveryId: "delivery-123",
				payload: {},
			};
			expect(translator.canTranslate(event)).toBe(false);
		});
	});

	describe("translate - issue_comment", () => {
		it("should translate issue_comment event to SessionStartMessage", () => {
			const event: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "delivery-123",
				payload: createMockIssueCommentPayload(),
				installationToken: "token-abc",
			};

			const result = translator.translate(event);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("session_start");
			expect(result.message.source).toBe("github");
			expect(result.message.sessionKey).toBe("owner/repo#42");
			expect(result.message.workItemId).toBe("123");
			expect(result.message.workItemIdentifier).toBe("owner/repo#42");
			expect(result.message.receivedAt).toBe("2025-01-27T12:00:00Z");

			// Author info
			expect(result.message.author?.id).toBe("2");
			expect(result.message.author?.name).toBe("commenter");

			// Session start specific fields
			const sessionStart = result.message;
			if (sessionStart.action !== "session_start") return;

			expect(sessionStart.initialPrompt).toBe("@cyrus please review this PR");
			expect(sessionStart.title).toBe("Test PR");
			expect(sessionStart.description).toBe("PR description");

			// Platform data (narrow type)
			const platformData =
				sessionStart.platformData as GitHubSessionStartPlatformData;
			expect(platformData.eventType).toBe("issue_comment");
			expect(platformData.repository.fullName).toBe("owner/repo");
			expect(platformData.comment.body).toBe("@cyrus please review this PR");
			expect(platformData.installationToken).toBe("token-abc");
			expect(platformData.issue?.isPullRequest).toBe(true);
		});

		it("should use installation ID as organizationId", () => {
			const event: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "delivery-123",
				payload: createMockIssueCommentPayload(),
			};

			const result = translator.translate(event);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.organizationId).toBe("12345");
		});

		it("should fall back to repo owner ID when no installation", () => {
			const payload = createMockIssueCommentPayload();
			delete payload.installation;

			const event: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "delivery-123",
				payload,
			};

			const result = translator.translate(event);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.organizationId).toBe("3"); // owner.id
		});
	});

	describe("translate - pull_request_review_comment", () => {
		it("should translate pull_request_review_comment event to SessionStartMessage", () => {
			const event: GitHubWebhookEvent = {
				eventType: "pull_request_review_comment",
				deliveryId: "delivery-123",
				payload: createMockPRReviewCommentPayload(),
			};

			const result = translator.translate(event);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("session_start");
			expect(result.message.source).toBe("github");
			expect(result.message.sessionKey).toBe("owner/repo#42");
			expect(result.message.workItemId).toBe("123");
			expect(result.message.workItemIdentifier).toBe("owner/repo#42");

			// Session start specific fields
			const sessionStart = result.message;
			if (sessionStart.action !== "session_start") return;

			expect(sessionStart.initialPrompt).toBe("Please fix this line");
			expect(sessionStart.title).toBe("Test PR");
			expect(sessionStart.description).toBe("PR description");

			// Platform data (narrow type)
			const platformData =
				sessionStart.platformData as GitHubSessionStartPlatformData;
			expect(platformData.eventType).toBe("pull_request_review_comment");
			expect(platformData.pullRequest?.headRef).toBe("feature-branch");
			expect(platformData.pullRequest?.baseRef).toBe("main");
			expect(platformData.comment.path).toBe("src/file.ts");
			expect(platformData.comment.diffHunk).toBe(
				"@@ -10,6 +10,7 @@ function foo() {",
			);
		});
	});

	describe("translateAsUserPrompt", () => {
		it("should translate issue_comment as UserPromptMessage", () => {
			const event: GitHubWebhookEvent = {
				eventType: "issue_comment",
				deliveryId: "delivery-123",
				payload: createMockIssueCommentPayload(),
			};

			const result = translator.translateAsUserPrompt(event);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("user_prompt");
			expect(result.message.source).toBe("github");
			expect(result.message.sessionKey).toBe("owner/repo#42");

			const userPrompt = result.message;
			if (userPrompt.action !== "user_prompt") return;

			expect(userPrompt.content).toBe("@cyrus please review this PR");
			expect(userPrompt.author?.name).toBe("commenter");
		});

		it("should translate pull_request_review_comment as UserPromptMessage", () => {
			const event: GitHubWebhookEvent = {
				eventType: "pull_request_review_comment",
				deliveryId: "delivery-123",
				payload: createMockPRReviewCommentPayload(),
			};

			const result = translator.translateAsUserPrompt(event);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.action).toBe("user_prompt");
			expect(result.message.source).toBe("github");

			const userPrompt = result.message;
			if (userPrompt.action !== "user_prompt") return;

			expect(userPrompt.content).toBe("Please fix this line");
		});
	});
});
