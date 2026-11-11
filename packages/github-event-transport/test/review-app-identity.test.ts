import { describe, expect, it } from "vitest";
import {
	allowedReviewAppIds,
	resolveReviewAppId,
} from "../src/review-app-identity.js";

const author = {
	id: 999,
	node_id: "BOT_node",
	type: "Bot",
	login: "reviewer[bot]",
};
const node = {
	__typename: "Bot",
	databaseId: 999,
	login: "reviewer",
	url: "https://github.com/apps/reviewer",
};
const app = { id: 42, slug: "reviewer" };
function responses(bot: unknown = node, appBody: unknown = app, status = 200) {
	const calls: string[] = [];
	const fetcher = (async (url: string | URL | Request) => {
		calls.push(String(url));
		return Response.json(
			calls.length === 1 ? { data: { node: bot } } : appBody,
			{ status },
		);
	}) as typeof fetch;
	return { calls, fetcher };
}
describe("review App identity", () => {
	it("resolves Bot node to App ID, not bot user ID, without a /users avatar lookup", async () => {
		const { fetcher, calls } = responses();
		expect(await resolveReviewAppId(author, "test-token", fetcher)).toBe(42);
		expect(calls).toEqual([
			"https://api.github.com/graphql",
			"https://api.github.com/apps/reviewer",
		]);
	});
	it("rejects users, missing nodes, and missing credentials", async () => {
		const { fetcher, calls } = responses();
		for (const input of [
			{ ...author, type: "User" },
			{ ...author, node_id: undefined },
		]) {
			expect(await resolveReviewAppId(input, "token", fetcher)).toBeNull();
		}
		expect(await resolveReviewAppId(author, "", fetcher)).toBeNull();
		expect(calls).toHaveLength(0);
	});
	it("fails closed on mismatched numeric identity, login, node type, and non-app URL", async () => {
		for (const bot of [
			{ ...node, databaseId: 42 },
			{ ...node, login: "other[bot]" },
			{ ...node, __typename: "User" },
			{ ...node, url: "https://evil.example/apps/reviewer" },
			{ ...node, url: "https://github.com/reviewer" },
			null,
		]) {
			expect(
				await resolveReviewAppId(author, "token", responses(bot).fetcher),
			).toBeNull();
		}
	});
	it("fails closed on deleted, unavailable, renamed apps and arbitrary bots including Actions", async () => {
		expect(
			await resolveReviewAppId(
				author,
				"token",
				responses(node, app, 404).fetcher,
			),
		).toBeNull();
		expect(
			await resolveReviewAppId(
				author,
				"token",
				responses(node, { ...app, slug: "other" }).fetcher,
			),
		).toBeNull();
		expect(
			await resolveReviewAppId(
				{ ...author, login: "github-actions[bot]" },
				"token",
				responses().fetcher,
			),
		).toBeNull();
	});
	it("requires both installation and organization and defaults to no app grants", () => {
		const policies = [
			{ installationId: "123", organization: "Grain", appIds: [42] },
			{ installationId: "456", organization: "Other", appIds: [43] },
		];
		expect(
			allowedReviewAppIds(policies, "123", {
				login: "grain",
				type: "Organization",
			}),
		).toEqual([42]);
		expect(
			allowedReviewAppIds(policies, "456", {
				login: "grain",
				type: "Organization",
			}),
		).toEqual([]);
		expect(
			allowedReviewAppIds(policies, "123", {
				login: "other",
				type: "Organization",
			}),
		).toEqual([]);
		expect(
			allowedReviewAppIds(policies, "123", { login: "grain", type: "User" }),
		).toEqual([]);
		expect(
			allowedReviewAppIds(undefined, "123", {
				login: "grain",
				type: "Organization",
			}),
		).toEqual([]);
	});
});
