import { afterEach, describe, expect, it, vi } from "vitest";
import { isInternalSlackChannel } from "../src/SlackChannelPolicy.js";

afterEach(() => vi.unstubAllGlobals());
const internal = {
	id: "C123",
	is_ext_shared: false,
	is_shared: false,
	is_member: true,
	is_archived: false,
};
function provider(
	channel: unknown = internal,
	identity: unknown = { ok: true, team_id: "T123", bot_id: "B123" },
) {
	const fetch = vi.fn(async (url: string, init: RequestInit) => {
		expect(init.headers).toMatchObject({ authorization: "Bearer synthetic" });
		expect(init.redirect).toBe("error");
		expect(init.signal).toBeInstanceOf(AbortSignal);
		return Response.json(
			url.endsWith("auth.test") ? identity : { ok: true, channel },
		);
	});
	vi.stubGlobal("fetch", fetch);
	return fetch;
}
describe("ordinary Slack channel eligibility", () => {
	it("requires fresh current identity and channel, without a positive cache", async () => {
		const fetch = provider();
		expect(await isInternalSlackChannel("synthetic", "T123", "C123")).toBe(
			true,
		);
		provider({ ...internal, is_ext_shared: true });
		expect(await isInternalSlackChannel("synthetic", "T123", "C123")).toBe(
			false,
		);
		expect(fetch).toHaveBeenCalledTimes(2);
	});
	it.each([
		{ ...internal, is_ext_shared: true },
		{ ...internal, is_ext_shared: undefined },
		{ ...internal, is_shared: true },
		{ ...internal, is_pending_ext_shared: true },
		{ ...internal, is_member: false },
		{ ...internal, is_archived: true },
		{ ...internal, id: "COTHER" },
		null,
	])("denies external, uncertain, inaccessible or foreign channel %#", async (channel) => {
		provider(channel);
		expect(await isInternalSlackChannel("synthetic", "T123", "C123")).toBe(
			false,
		);
	});
	it("retains internal enterprise-grid sharing", async () => {
		provider({ ...internal, is_shared: true, is_org_shared: true });
		expect(await isInternalSlackChannel("synthetic", "T123", "C123")).toBe(
			true,
		);
	});
	it.each([
		{ ok: false },
		{ ok: true, team_id: "TOTHER", bot_id: "B123" },
		{ ok: true, team_id: "T123" },
	])("denies unknown or foreign account %#", async (identity) => {
		provider(internal, identity);
		expect(await isInternalSlackChannel("synthetic", "T123", "C123")).toBe(
			false,
		);
	});
	it("does not use missing credentials or malformed identifiers", async () => {
		const fetch = provider();
		expect(await isInternalSlackChannel(undefined, "T123", "C123")).toBe(false);
		expect(await isInternalSlackChannel("synthetic", "T123", "../C123")).toBe(
			false,
		);
		expect(fetch).not.toHaveBeenCalled();
	});
	it.each([
		() => new Response("x".repeat(65537)),
		() => new Response("bad-json"),
		() => new Response("", { status: 429 }),
		() => {
			throw new Error("private provider detail");
		},
	])("fails closed on provider failure %#", async (response) => {
		vi.stubGlobal("fetch", vi.fn(response));
		expect(await isInternalSlackChannel("synthetic", "T123", "C123")).toBe(
			false,
		);
	});
});
