import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubCommentService } from "../src/GitHubCommentService.js";

afterEach(() => vi.unstubAllGlobals());

const params = {
	token: "test",
	owner: "o",
	repo: "r",
	pullNumber: 42,
	reviewId: 5265084414,
};
const review = {
	node_id: "review-target",
	user: { login: "chatgpt-codex-connector[bot]" },
	state: "COMMENTED",
};
const thread = (id: string, isResolved: boolean) => ({
	isResolved,
	comments: { nodes: [{ pullRequestReview: { id } }] },
});
function page(
	nodes: ReturnType<typeof thread>[],
	cursor: string | null = null,
) {
	return {
		data: {
			repository: {
				pullRequest: {
					reviewThreads: {
						nodes,
						pageInfo: { hasNextPage: cursor !== null, endCursor: cursor },
					},
				},
			},
		},
	};
}

describe("completed Codex review detection", () => {
	it("proves all six threads from the exact review are resolved, including later pages", async () => {
		const requests: Array<{ url: string; body?: string }> = [];
		const responses = [
			review,
			page(
				[
					thread("other-review", false),
					...Array.from({ length: 3 }, () => thread("review-target", true)),
				],
				"next",
			),
			page(Array.from({ length: 3 }, () => thread("review-target", true))),
		];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			requests.push({ url, body: init.body as string });
			return Response.json(responses.shift());
		});
		expect(await new GitHubCommentService().isReviewFullyResolved(params)).toBe(
			true,
		);
		expect(requests.map((r) => r.url)).toEqual([
			"https://api.github.com/repos/o/r/pulls/42/reviews/5265084414",
			"https://api.github.com/graphql",
			"https://api.github.com/graphql",
		]);
		expect(JSON.parse(requests[2].body!).variables).toEqual({
			owner: "o",
			repo: "r",
			number: 42,
			cursor: "next",
		});
	});

	it.each([
		{ nodes: [thread("review-target", false)] },
		{ nodes: [thread("other-review", true)] },
		{ nodes: [] },
	])("does not skip unresolved or unproven review threads (%j)", async ({
		nodes,
	}) => {
		const responses = [review, page(nodes)];
		vi.stubGlobal("fetch", async () => Response.json(responses.shift()));
		expect(await new GitHubCommentService().isReviewFullyResolved(params)).toBe(
			false,
		);
	});

	it("does not miss an unresolved finding on the next page", async () => {
		const responses = [
			review,
			page([thread("review-target", true)], "next"),
			page([thread("review-target", false)]),
		];
		vi.stubGlobal("fetch", async () => Response.json(responses.shift()));
		expect(await new GitHubCommentService().isReviewFullyResolved(params)).toBe(
			false,
		);
	});

	it.each([
		{ ...review, user: { login: "human-reviewer" } },
		{ ...review, state: "CHANGES_REQUESTED" },
	])("does not infer completion of a different review kind (%j)", async (input) => {
		const fetch = vi.fn(async () => Response.json(input));
		vi.stubGlobal("fetch", fetch);
		expect(await new GitHubCommentService().isReviewFullyResolved(params)).toBe(
			false,
		);
		expect(fetch).toHaveBeenCalledOnce();
	});

	it("rejects partial GraphQL results instead of marking a request completed", async () => {
		const responses = [
			review,
			{
				...page([thread("review-target", true)]),
				errors: [{ message: "partial failure" }],
			},
		];
		vi.stubGlobal("fetch", async () => Response.json(responses.shift()));
		await expect(
			new GitHubCommentService().isReviewFullyResolved(params),
		).rejects.toThrow("query failed");
	});

	it("rejects incomplete pagination instead of accepting the first page", async () => {
		const responses = [
			review,
			page([thread("review-target", true)], "same"),
			page([thread("review-target", true)], "same"),
		];
		vi.stubGlobal("fetch", async () => Response.json(responses.shift()));
		await expect(
			new GitHubCommentService().isReviewFullyResolved(params),
		).rejects.toThrow("pagination");
	});
});
