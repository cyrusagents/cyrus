import { describe, expect, it } from "vitest";
import {
	extractCommentAuthor,
	extractCommentBody,
	extractCommentId,
	extractCommentUrl,
	extractInstallationId,
	extractPRBranchRef,
	extractPRNumber,
	extractPRTitle,
	extractRepoFullName,
	extractRepoName,
	extractRepoOwner,
	extractSessionKey,
	isCommentOnPullRequest,
	isIssueCommentPayload,
	isPullRequestReviewCommentPayload,
	stripMention,
} from "../src/github-webhook-utils.js";
import {
	issueCommentEvent,
	issueCommentPayload,
	plainIssueCommentEvent,
	prReviewCommentEvent,
	prReviewCommentPayload,
} from "./fixtures.js";

describe("github-webhook-utils", () => {
	describe("type guards", () => {
		it("isIssueCommentPayload returns true for issue_comment payloads", () => {
			expect(isIssueCommentPayload(issueCommentPayload)).toBe(true);
		});

		it("isIssueCommentPayload returns false for PR review comment payloads", () => {
			expect(isIssueCommentPayload(prReviewCommentPayload)).toBe(false);
		});

		it("isPullRequestReviewCommentPayload returns true for PR review comment payloads", () => {
			expect(isPullRequestReviewCommentPayload(prReviewCommentPayload)).toBe(
				true,
			);
		});

		it("isPullRequestReviewCommentPayload returns false for issue_comment payloads", () => {
			expect(isPullRequestReviewCommentPayload(issueCommentPayload)).toBe(
				false,
			);
		});
	});

	describe("extractPRBranchRef", () => {
		it("returns branch ref from pull_request_review_comment", () => {
			expect(extractPRBranchRef(prReviewCommentEvent)).toBe("fix-tests");
		});

		it("returns null for issue_comment events (branch must be fetched separately)", () => {
			expect(extractPRBranchRef(issueCommentEvent)).toBeNull();
		});
	});

	describe("extractPRNumber", () => {
		it("returns PR number from issue_comment on a PR", () => {
			expect(extractPRNumber(issueCommentEvent)).toBe(42);
		});

		it("returns PR number from pull_request_review_comment", () => {
			expect(extractPRNumber(prReviewCommentEvent)).toBe(42);
		});

		it("returns null for issue_comment on a plain issue", () => {
			expect(extractPRNumber(plainIssueCommentEvent)).toBeNull();
		});
	});

	describe("extractCommentBody", () => {
		it("returns comment body from issue_comment", () => {
			expect(extractCommentBody(issueCommentEvent)).toBe(
				"@cyrusagent Please fix the failing tests",
			);
		});

		it("returns comment body from PR review comment", () => {
			expect(extractCommentBody(prReviewCommentEvent)).toBe(
				"@cyrusagent This function needs better error handling",
			);
		});
	});

	describe("extractCommentAuthor", () => {
		it("returns comment author login", () => {
			expect(extractCommentAuthor(issueCommentEvent)).toBe("testuser");
		});
	});

	describe("extractRepoFullName", () => {
		it("returns full repository name", () => {
			expect(extractRepoFullName(issueCommentEvent)).toBe("testorg/my-repo");
		});
	});

	describe("extractRepoOwner", () => {
		it("returns repository owner login", () => {
			expect(extractRepoOwner(issueCommentEvent)).toBe("testorg");
		});
	});

	describe("extractRepoName", () => {
		it("returns repository name", () => {
			expect(extractRepoName(issueCommentEvent)).toBe("my-repo");
		});
	});

	describe("extractCommentId", () => {
		it("returns comment ID from issue_comment", () => {
			expect(extractCommentId(issueCommentEvent)).toBe(999);
		});

		it("returns comment ID from PR review comment", () => {
			expect(extractCommentId(prReviewCommentEvent)).toBe(888);
		});
	});

	describe("extractInstallationId", () => {
		it("returns installation ID when present", () => {
			expect(extractInstallationId(issueCommentEvent)).toBe(55555);
		});

		it("returns null when installation is not present", () => {
			const eventWithoutInstallation = {
				...issueCommentEvent,
				payload: {
					...issueCommentPayload,
					installation: undefined,
				},
			};
			expect(extractInstallationId(eventWithoutInstallation)).toBeNull();
		});
	});

	describe("isCommentOnPullRequest", () => {
		it("returns true for issue_comment on a PR", () => {
			expect(isCommentOnPullRequest(issueCommentEvent)).toBe(true);
		});

		it("returns false for issue_comment on a plain issue", () => {
			expect(isCommentOnPullRequest(plainIssueCommentEvent)).toBe(false);
		});

		it("returns true for pull_request_review_comment (always a PR)", () => {
			expect(isCommentOnPullRequest(prReviewCommentEvent)).toBe(true);
		});
	});

	describe("extractSessionKey", () => {
		it("creates session key from issue_comment event", () => {
			expect(extractSessionKey(issueCommentEvent)).toBe(
				"github:testorg/my-repo#42",
			);
		});

		it("creates session key from PR review comment event", () => {
			expect(extractSessionKey(prReviewCommentEvent)).toBe(
				"github:testorg/my-repo#42",
			);
		});
	});

	describe("extractPRTitle", () => {
		it("returns title from issue_comment event", () => {
			expect(extractPRTitle(issueCommentEvent)).toBe("Fix failing tests");
		});

		it("returns title from PR review comment event", () => {
			expect(extractPRTitle(prReviewCommentEvent)).toBe("Fix failing tests");
		});
	});

	describe("extractCommentUrl", () => {
		it("returns comment HTML URL from issue_comment", () => {
			expect(extractCommentUrl(issueCommentEvent)).toBe(
				"https://github.com/testorg/my-repo/pull/42#issuecomment-999",
			);
		});

		it("returns comment HTML URL from PR review comment", () => {
			expect(extractCommentUrl(prReviewCommentEvent)).toBe(
				"https://github.com/testorg/my-repo/pull/42#discussion_r888",
			);
		});
	});

	describe("stripMention", () => {
		it("strips @cyrusagent from comment body", () => {
			expect(stripMention("@cyrusagent Please fix the failing tests")).toBe(
				"Please fix the failing tests",
			);
		});

		it("strips mention from middle of text", () => {
			expect(stripMention("Hey @cyrusagent please fix this")).toBe(
				"Hey please fix this",
			);
		});

		it("handles case-insensitive mentions", () => {
			expect(stripMention("@CyrusAgent Please fix")).toBe("Please fix");
		});

		it("strips custom mention handle", () => {
			expect(stripMention("@mybot do something", "@mybot")).toBe(
				"do something",
			);
		});

		it("handles text with no mention", () => {
			expect(stripMention("Please fix the failing tests")).toBe(
				"Please fix the failing tests",
			);
		});

		it("handles text that is only the mention", () => {
			expect(stripMention("@cyrusagent")).toBe("");
		});

		it("handles mention with special regex characters in custom handle", () => {
			expect(stripMention("@bot.v2 do something", "@bot.v2")).toBe(
				"do something",
			);
		});
	});
});
