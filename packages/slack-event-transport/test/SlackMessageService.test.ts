import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackMessageService } from "../src/SlackMessageService.js";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SlackMessageService", () => {
	let service: SlackMessageService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = new SlackMessageService();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("postMessage", () => {
		it("renders the reply and footer as top-level blocks without attachments", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});
			const footer = "From Connor <@U123> Turland's device";
			await service.postMessage({
				token: "xoxb-test",
				channel: "C1",
				text: "Done.",
				thread_ts: "1.1",
				footer,
			});
			expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
				channel: "C1",
				text: "Done.",
				thread_ts: "1.1",
				blocks: [
					{ type: "section", text: { type: "mrkdwn", text: "Done." } },
					{
						type: "context",
						elements: [{ type: "plain_text", text: footer, emoji: false }],
					},
				],
			});
		});

		it("keeps long code replies within section limits with balanced fences", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});
			const text = `Here is the code:\n\`\`\`\n${"example\n".repeat(600)}\`\`\``;
			await service.postMessage({
				token: "xoxb-test",
				channel: "C1",
				text,
				footer: "From Connor Turland's device",
			});
			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.text).toBe(text);
			expect(body.attachments).toBeUndefined();
			const sections = body.blocks.slice(0, -1);
			expect(sections.length).toBeGreaterThan(1);
			for (const section of sections) {
				expect(section.text.text.length).toBeLessThanOrEqual(3000);
				expect((section.text.text.match(/```/g)?.length ?? 0) % 2).toBe(0);
			}
			expect(
				sections
					.map((s) => s.text.text)
					.join("")
					.match(/example/g),
			).toHaveLength(600);
			expect(body.blocks.at(-1).type).toBe("context");
		});

		it.each([
			"x".repeat(40000),
			"`".repeat(6000),
			"💻".repeat(3000),
			`${"x".repeat(39998)}💻x`,
		])("bounds sections for long unbroken text (%#)", async (text) => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});
			await service.postMessage({
				token: "test",
				channel: "C1",
				text,
				footer: "From Connor's device",
			});
			const body = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(body.blocks.length).toBeLessThanOrEqual(50);
			for (const section of body.blocks.slice(0, -1)) {
				expect(section.text.text.length).toBeLessThanOrEqual(3000);
				expect(section.text.text.isWellFormed()).toBe(true);
			}
		});

		it("posts a message to a Slack channel with thread_ts", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await service.postMessage({
				token: "xoxb-test-token",
				channel: "C9876543210",
				text: "Hello from Cyrus!",
				thread_ts: "1704110400.000100",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.com/api/chat.postMessage",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-test-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						channel: "C9876543210",
						text: "Hello from Cyrus!",
						thread_ts: "1704110400.000100",
					}),
				},
			);
		});

		it("posts a message without thread_ts", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await service.postMessage({
				token: "xoxb-test-token",
				channel: "C9876543210",
				text: "Hello from Cyrus!",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.com/api/chat.postMessage",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-test-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						channel: "C9876543210",
						text: "Hello from Cyrus!",
					}),
				},
			);
		});

		it("throws on non-OK HTTP response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => '{"ok":false,"error":"invalid_auth"}',
			});

			await expect(
				service.postMessage({
					token: "xoxb-bad-token",
					channel: "C9876543210",
					text: "Hello",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Failed to post message: 401 Unauthorized",
			);
		});

		it("throws on Slack API error (HTTP 200 with ok: false)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: false, error: "channel_not_found" }),
			});

			await expect(
				service.postMessage({
					token: "xoxb-test-token",
					channel: "C9876543210",
					text: "Hello",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Slack API error: channel_not_found",
			);
		});

		it("respects custom base URL", async () => {
			const customService = new SlackMessageService(
				"https://slack.example.com/api",
			);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await customService.postMessage({
				token: "xoxb-test-token",
				channel: "C9876543210",
				text: "Hello",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.example.com/api/chat.postMessage",
				expect.any(Object),
			);
		});
	});

	describe("getUserName", () => {
		it.each([
			[
				{
					id: "U1",
					profile: { real_name: "Connor Turland", display_name: "Connor" },
				},
				"Connor Turland",
			],
			[{ id: "U1", real_name: "Pegah", profile: { real_name: " " } }, "Pegah"],
			[{ id: "U1", profile: { display_name: "Zoë 💻" } }, "Zoë 💻"],
			[{ id: "U1", name: "connor" }, "connor"],
			[{ id: "U2", real_name: "Wrong user" }, undefined],
		])("resolves the requested Slack identity (%#)", async (user, expected) => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true, user }),
			});
			expect(await service.getUserName("xoxb-test", "U1")).toBe(expected);
			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.com/api/users.info?user=U1",
				expect.objectContaining({
					headers: { Authorization: "Bearer xoxb-test" },
					signal: expect.any(AbortSignal),
				}),
			);
		});
		it("omits attribution when the grant cannot read profiles", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: false, error: "missing_scope" }),
			});
			expect(await service.getUserName("xoxb-test", "U1")).toBeUndefined();
		});
	});

	describe("fetchThreadMessages", () => {
		it("fetches thread messages with correct GET params and Bearer auth", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [
						{ user: "U111", text: "Hello", ts: "1704110400.000100" },
						{ user: "U222", text: "World", ts: "1704110400.000200" },
					],
					has_more: false,
				}),
			});

			const result = await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			expect(result).toEqual([
				{ user: "U111", text: "Hello", ts: "1704110400.000100" },
				{ user: "U222", text: "World", ts: "1704110400.000200" },
			]);

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://slack.com/api/conversations.replies?"),
				{
					method: "GET",
					headers: {
						Authorization: "Bearer xoxb-test-token",
					},
				},
			);

			// Verify query params
			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.get("channel")).toBe("C9876543210");
			expect(calledUrl.searchParams.get("ts")).toBe("1704110400.000100");
			expect(calledUrl.searchParams.get("limit")).toBe("100");
		});

		it("handles cursor-based pagination across multiple pages", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U111", text: "Page 1", ts: "1704110400.000100" },
						],
						has_more: true,
						response_metadata: { next_cursor: "cursor_abc" },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U222", text: "Page 2", ts: "1704110400.000200" },
						],
						has_more: false,
					}),
				});

			const result = await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			expect(result).toEqual([
				{ user: "U111", text: "Page 1", ts: "1704110400.000100" },
				{ user: "U222", text: "Page 2", ts: "1704110400.000200" },
			]);

			expect(mockFetch).toHaveBeenCalledTimes(2);

			// Verify second call includes cursor
			const secondCallUrl = new URL(mockFetch.mock.calls[1][0]);
			expect(secondCallUrl.searchParams.get("cursor")).toBe("cursor_abc");
		});

		it("enforces the limit parameter", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [
						{ user: "U111", text: "Msg 1", ts: "1704110400.000100" },
						{ user: "U222", text: "Msg 2", ts: "1704110400.000200" },
						{ user: "U333", text: "Msg 3", ts: "1704110400.000300" },
					],
					has_more: false,
				}),
			});

			const result = await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
				limit: 2,
			});

			expect(result).toHaveLength(2);
			expect(result[0].text).toBe("Msg 1");
			expect(result[1].text).toBe("Msg 2");

			// Verify limit was passed in query params
			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.get("limit")).toBe("2");
		});

		it("passes oldest through so Slack filters server-side", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [{ user: "U111", text: "Newer", ts: "1704110400.000900" }],
					has_more: false,
				}),
			});

			await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
				limit: 50,
				oldest: "1704110400.000500",
			});

			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.get("oldest")).toBe("1704110400.000500");
			expect(calledUrl.searchParams.get("limit")).toBe("50");
		});

		it("omits oldest when it is not supplied", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true, messages: [], has_more: false }),
			});

			await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.has("oldest")).toBe(false);
		});

		it("keeps oldest on paginated follow-up requests", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U111", text: "Page 1", ts: "1704110400.000600" },
						],
						has_more: true,
						response_metadata: { next_cursor: "cursor_abc" },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U222", text: "Page 2", ts: "1704110400.000700" },
						],
						has_more: false,
					}),
				});

			await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
				oldest: "1704110400.000500",
			});

			const secondCallUrl = new URL(mockFetch.mock.calls[1][0]);
			expect(secondCallUrl.searchParams.get("oldest")).toBe(
				"1704110400.000500",
			);
			expect(secondCallUrl.searchParams.get("cursor")).toBe("cursor_abc");
		});

		it("throws on non-OK HTTP response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => '{"ok":false,"error":"invalid_auth"}',
			});

			await expect(
				service.fetchThreadMessages({
					token: "xoxb-bad-token",
					channel: "C9876543210",
					thread_ts: "1704110400.000100",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Failed to fetch thread messages: 401 Unauthorized",
			);
		});

		it("throws on Slack API error (HTTP 200 with ok: false)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: false, error: "thread_not_found" }),
			});

			await expect(
				service.fetchThreadMessages({
					token: "xoxb-test-token",
					channel: "C9876543210",
					thread_ts: "1704110400.000100",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Slack API error: thread_not_found",
			);
		});

		it("respects custom base URL", async () => {
			const customService = new SlackMessageService(
				"https://slack.example.com/api",
			);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [],
					has_more: false,
				}),
			});

			await customService.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining(
					"https://slack.example.com/api/conversations.replies?",
				),
				expect.any(Object),
			);
		});
	});
});
