import { describe, expect, it } from "vitest";
import {
	formatReviewFindings,
	loadReviewFindings,
} from "../src/review-findings.js";

const scope = {
	owner: "grain",
	repo: "repo",
	pullNumber: 1,
	reviewId: 7,
	authorId: 8,
	commitId: "head",
};
const finding = (id = 1) => ({
	id,
	pull_request_review_id: 7,
	user: { id: 8 },
	commit_id: "head",
	path: "README.md",
	line: 26,
	body: "Add a blank line",
	html_url: `https://github.com/grain/repo/pull/1#discussion_r${id}`,
});
describe("submitted review findings", () => {
	it("reads all pages and groups only original findings by the verified reviewer", async () => {
		const urls: string[] = [];
		const request = (async (url: string | URL | Request) => {
			urls.push(String(url));
			return Response.json(
				urls.length === 1
					? Array.from({ length: 100 }, (_, i) => finding(i + 1))
					: [
							finding(101),
							finding(101),
							{ ...finding(102), user: { id: 9 } },
							{ ...finding(103), pull_request_review_id: 99 },
							{ ...finding(104), commit_id: "old" },
							{ ...finding(105), in_reply_to_id: 1 },
							{ ...finding(106), line: null },
							{ ...finding(107), body: " " },
						],
			);
		}) as typeof fetch;
		const result = await loadReviewFindings(scope, "token", request);
		expect(result).toHaveLength(101);
		expect(urls).toEqual(
			[1, 2].map(
				(page) =>
					`https://api.github.com/repos/grain/repo/pulls/1/reviews/7/comments?per_page=100&page=${page}`,
			),
		);
		expect(formatReviewFindings(result)).toContain("README.md:26");
		expect(formatReviewFindings(result)).toContain("#discussion_r101");
	});
	it("does not treat an empty review or provider error as findings", async () => {
		expect(
			await loadReviewFindings(scope, "token", (async () =>
				Response.json([])) as typeof fetch),
		).toEqual([]);
		await expect(
			loadReviewFindings(
				scope,
				"token",
				(async () => new Response(null, { status: 403 })) as typeof fetch,
			),
		).rejects.toThrow("403");
		await expect(
			loadReviewFindings(scope, "token", (async () =>
				Response.json({ message: "invalid" })) as typeof fetch),
		).rejects.toThrow("Invalid");
	});
	it("accepts file-level findings without requiring a line", async () => {
		const result = await loadReviewFindings(scope, "token", (async () =>
			Response.json([
				{ ...finding(), line: null, subject_type: "file" },
			])) as typeof fetch);
		expect(result).toHaveLength(1);
		expect(formatReviewFindings(result)).toContain("### README.md\n");
	});
});

it("accepts the legacy position-only response returned for Codex review 5863629400", async () => {
	const comment = {
		id: 1,
		pull_request_review_id: 7,
		user: { id: 8 },
		commit_id: "head",
		path: "README.md",
		position: 5,
		original_position: 5,
		diff_hunk:
			"@@ -23,7 +23,7 @@\n+   git clone https://github.com/example/repo.git",
		body: "Add a blank line after cloning",
		html_url: "https://github.com/grain/repo/pull/1#discussion_r1",
	};
	const result = await loadReviewFindings(scope, "token", async () =>
		Response.json([comment]),
	);
	expect(result).toHaveLength(1);
	expect(result[0].line).toBeNull();
	expect(formatReviewFindings(result)).toContain(comment.diff_hunk);
	expect(formatReviewFindings(result)).toContain(comment.body);
	expect(
		await loadReviewFindings(scope, "token", async () =>
			Response.json([{ ...comment, position: null }]),
		),
	).toEqual([]);
});
