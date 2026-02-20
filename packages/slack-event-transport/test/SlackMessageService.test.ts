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
