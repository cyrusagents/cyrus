import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ZulipCredentials, ZulipMessage } from "../src/types.js";
import { ZulipMessageService } from "../src/ZulipMessageService.js";

const credentials: ZulipCredentials = {
	site: "https://example.zulipchat.com/",
	botEmail: "impala-bot@example.zulipchat.com",
	apiKey: "api-key",
};

function message(id: number): ZulipMessage {
	return {
		id,
		type: "stream",
		content: `message ${id}`,
		sender_id: 7,
		sender_email: "nate@example.com",
		sender_full_name: "Nate",
		subject: "parser rewrite",
		stream_id: 99,
		display_recipient: "engineering",
		timestamp: 1_760_000_000,
	};
}

function mockFetch(body: unknown, ok = true, status = 200) {
	const fetchMock = vi.fn().mockResolvedValue({
		ok,
		status,
		statusText: ok ? "OK" : "Bad Request",
		json: async () => body,
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

/** The single fetch call's URL and decoded form body */
function callOf(fetchMock: ReturnType<typeof mockFetch>) {
	const [url, init] = fetchMock.mock.calls[0] as [
		string,
		{ method: string; headers: Record<string, string>; body?: string },
	];
	return {
		url: new URL(url),
		method: init.method,
		headers: init.headers,
		form: new URLSearchParams(init.body ?? ""),
	};
}

describe("ZulipMessageService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	describe("postMessage", () => {
		it("posts to a channel topic with form-encoded parameters", async () => {
			const fetchMock = mockFetch({ result: "success", id: 55 });

			const id = await new ZulipMessageService().postMessage({
				credentials,
				destination: { type: "stream", streamId: 99, topic: "parser rewrite" },
				content: "done",
			});

			const call = callOf(fetchMock);
			expect(id).toBe(55);
			// The trailing slash on the configured site must not double up
			expect(call.url.href).toBe(
				"https://example.zulipchat.com/api/v1/messages",
			);
			expect(call.method).toBe("POST");
			expect(call.form.get("type")).toBe("stream");
			expect(call.form.get("to")).toBe("99");
			expect(call.form.get("topic")).toBe("parser rewrite");
			expect(call.form.get("content")).toBe("done");
			expect(call.headers.Authorization).toBe(
				`Basic ${Buffer.from(`${credentials.botEmail}:${credentials.apiKey}`).toString("base64")}`,
			);
		});

		it("posts a direct message to the conversation's participants", async () => {
			const fetchMock = mockFetch({ result: "success", id: 56 });

			await new ZulipMessageService().postMessage({
				credentials,
				destination: { type: "private", userIds: [7, 11] },
				content: "done",
			});

			const call = callOf(fetchMock);
			expect(call.form.get("type")).toBe("private");
			expect(call.form.get("to")).toBe("[7,11]");
		});

		it("surfaces the Zulip error message on failure", async () => {
			mockFetch({ result: "error", msg: "Invalid API key" }, false, 401);

			await expect(
				new ZulipMessageService().postMessage({
					credentials,
					destination: { type: "stream", streamId: 99, topic: "t" },
					content: "hi",
				}),
			).rejects.toThrow(/Invalid API key/);
		});
	});

	describe("fetchTopicMessages", () => {
		it("always anchors at the newest end of the topic", async () => {
			const fetchMock = mockFetch({ messages: [message(1), message(2)] });

			const messages = await new ZulipMessageService().fetchTopicMessages({
				credentials,
				channel: "engineering",
				topic: "parser rewrite",
				limit: 50,
			});

			const call = callOf(fetchMock);
			// num_before caps what the server returns; it never scans the topic,
			// so a 50-message topic and a 50,000-message one cost the same.
			expect(call.url.searchParams.get("anchor")).toBe("newest");
			expect(call.url.searchParams.get("num_before")).toBe("50");
			expect(call.url.searchParams.get("num_after")).toBe("0");
			// Raw Markdown, not the rendered HTML the API returns by default
			expect(call.url.searchParams.get("apply_markdown")).toBe("false");
			expect(JSON.parse(call.url.searchParams.get("narrow") ?? "")).toEqual([
				{ operator: "channel", operand: "engineering" },
				{ operator: "topic", operand: "parser rewrite" },
			]);
			expect(messages).toHaveLength(2);
		});

		it("issues exactly one request regardless of topic size", async () => {
			const fetchMock = mockFetch({
				messages: Array.from({ length: 50 }, (_, i) => message(i + 1)),
			});

			await new ZulipMessageService().fetchTopicMessages({
				credentials,
				channel: "engineering",
				topic: "parser rewrite",
				limit: 50,
			});

			expect(fetchMock).toHaveBeenCalledTimes(1);
		});

		it("returns the window verbatim, leaving selection to the caller", async () => {
			mockFetch({ messages: [message(10), message(11), message(12)] });

			const messages = await new ZulipMessageService().fetchTopicMessages({
				credentials,
				channel: "engineering",
				topic: "parser rewrite",
				limit: 50,
			});

			expect(messages.map((m) => m.id)).toEqual([10, 11, 12]);
		});
	});

	describe("reactions", () => {
		it("adds a reaction to a message", async () => {
			const fetchMock = mockFetch({ result: "success" });

			await new ZulipMessageService().addReaction(credentials, 4242, "eyes");

			const call = callOf(fetchMock);
			expect(call.method).toBe("POST");
			expect(call.url.pathname).toBe("/api/v1/messages/4242/reactions");
			expect(call.form.get("emoji_name")).toBe("eyes");
		});

		it("removes a reaction with the emoji name in the query string", async () => {
			const fetchMock = mockFetch({ result: "success" });

			await new ZulipMessageService().removeReaction(credentials, 4242, "eyes");

			const call = callOf(fetchMock);
			expect(call.method).toBe("DELETE");
			expect(call.url.pathname).toBe("/api/v1/messages/4242/reactions");
			expect(call.url.searchParams.get("emoji_name")).toBe("eyes");
		});
	});
});
