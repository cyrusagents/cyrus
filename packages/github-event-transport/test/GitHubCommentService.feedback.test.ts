import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubCommentService } from "../src/GitHubCommentService.js";

afterEach(() => vi.unstubAllGlobals());

describe("GitHub request feedback", () => {
	it("links a normal PR reply to the exact triggering comment", async () => {
		let postedBody: unknown;
		vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
			postedBody = JSON.parse(String(init.body));
			return Response.json({
				id: 7,
				body: "reply",
				html_url: "https://github.com/o/r/pull/1#issuecomment-7",
			});
		});
		await new GitHubCommentService().postIssueComment({
			token: "test",
			owner: "o",
			repo: "r",
			issueNumber: 1,
			body: "Fixed the failing check.",
			replyToUrl: "https://github.com/o/r/pull/1#issuecomment-5",
		});
		expect(postedBody).toEqual({
			body: "[In reply to this request](https://github.com/o/r/pull/1#issuecomment-5)\n\nFixed the failing check.",
		});
	});

	it.each([
		false,
		true,
	])("returns the owned reaction ID and removes only that reaction (review=%s)", async (review) => {
		const requests: Array<{ url: string; method: string }> = [];
		vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
			requests.push({ url, method: init.method! });
			return init.method === "DELETE"
				? new Response(null, { status: 204 })
				: Response.json({ id: 901 });
		});
		const service = new GitHubCommentService();
		const target = {
			token: "test",
			owner: "o",
			repo: "r",
			commentId: 5,
			isPullRequestReviewComment: review,
		};
		const id = await service.addReaction({ ...target, content: "eyes" });
		expect(id).toBe(901);
		await service.deleteReaction({ ...target, reactionId: id });
		const base = `https://api.github.com/repos/o/r/${review ? "pulls" : "issues"}/comments/5/reactions`;
		expect(requests).toEqual([
			{ url: base, method: "POST" },
			{ url: `${base}/901`, method: "DELETE" },
		]);
	});
});
