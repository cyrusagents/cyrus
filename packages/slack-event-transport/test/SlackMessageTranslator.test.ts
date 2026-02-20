import type { SlackSessionStartPlatformData } from "cyrus-core";
import { describe, expect, it } from "vitest";
import {
	SlackMessageTranslator,
	stripMention,
} from "../src/SlackMessageTranslator.js";
import type { SlackWebhookEvent } from "../src/types.js";
import { testThreadedWebhookEvent, testWebhookEvent } from "./fixtures.js";

describe("SlackMessageTranslator", () => {
	const translator = new SlackMessageTranslator();

	describe("canTranslate", () => {
		it("returns true for valid app_mention webhook events", () => {
			expect(translator.canTranslate(testWebhookEvent)).toBe(true);
		});

		it("returns false for null", () => {
			expect(translator.canTranslate(null)).toBe(false);
		});

		it("returns false for undefined", () => {
			expect(translator.canTranslate(undefined)).toBe(false);
		});

		it("returns false for non-object", () => {
			expect(translator.canTranslate("string")).toBe(false);
		});

		it("returns false for missing eventType", () => {
			const { eventType: _, ...rest } = testWebhookEvent;
			expect(translator.canTranslate(rest)).toBe(false);
		});

		it("returns false for unsupported eventType", () => {
			expect(
				translator.canTranslate({
					...testWebhookEvent,
					eventType: "message",
				}),
			).toBe(false);
		});

		it("returns false for missing eventId", () => {
			const { eventId: _, ...rest } = testWebhookEvent;
			expect(translator.canTranslate(rest)).toBe(false);
		});

		it("returns false for null payload", () => {
			expect(
				translator.canTranslate({
					...testWebhookEvent,
					payload: null,
				}),
			).toBe(false);
		});
	});

	describe("translate (SessionStartMessage)", () => {
		it("translates app_mention to SessionStartMessage", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.source).toBe("slack");
			expect(result.message.action).toBe("session_start");
		});

		it("sets correct session key from channel and ts", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			// Non-threaded: sessionKey = channel:ts
			expect(result.message.sessionKey).toBe("C9876543210:1704110400.000100");
		});

		it("uses thread_ts for session key in threaded messages", () => {
			const result = translator.translate(testThreadedWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			// Threaded: sessionKey = channel:thread_ts
			expect(result.message.sessionKey).toBe("C9876543210:1704110400.000100");
		});

		it("strips @mention from initial prompt", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			const msg = result.message as { initialPrompt: string };
			expect(msg.initialPrompt).toBe(
				"Please fix the failing tests in the CI pipeline",
			);
		});

		it("sets correct work item identifier", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.workItemIdentifier).toBe(
				"slack:C9876543210:1704110400.000100",
			);
		});

		it("sets author from event user ID", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.author).toEqual({
				id: "U1234567890",
				name: "U1234567890",
			});
		});

		it("uses team_id as organizationId", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.organizationId).toBe("T0001");
		});

		it("uses context organizationId when provided", () => {
			const result = translator.translate(testWebhookEvent, {
				organizationId: "custom-org-id",
			});

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.organizationId).toBe("custom-org-id");
		});

		it("preserves Slack platform data", () => {
			const eventWithToken: SlackWebhookEvent = {
				...testWebhookEvent,
				slackBotToken: "xoxb-test-token",
			};
			const result = translator.translate(eventWithToken);

			expect(result.success).toBe(true);
			if (!result.success) return;

			const msg = result.message as {
				platformData: SlackSessionStartPlatformData;
			};
			expect(msg.platformData.channel.id).toBe("C9876543210");
			expect(msg.platformData.thread.ts).toBe("1704110400.000100");
			expect(msg.platformData.message.text).toBe(
				"<@U0BOT1234> Please fix the failing tests in the CI pipeline",
			);
			expect(msg.platformData.slackBotToken).toBe("xoxb-test-token");
		});

		it("sets receivedAt from event_ts", () => {
			const result = translator.translate(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			// event_ts "1704110400.000100" -> epoch 1704110400.0001
			const date = new Date(result.message.receivedAt);
			expect(date.getFullYear()).toBe(2024);
		});

		it("truncates long titles to 100 characters with ellipsis", () => {
			const longText = "a".repeat(200);
			const event: SlackWebhookEvent = {
				...testWebhookEvent,
				payload: {
					...testWebhookEvent.payload,
					text: longText,
				},
			};

			const result = translator.translate(event);
			expect(result.success).toBe(true);
			if (!result.success) return;

			const msg = result.message as { title: string };
			expect(msg.title.length).toBe(103); // 100 + "..."
			expect(msg.title.endsWith("...")).toBe(true);
		});

		it("returns failure for unsupported event types", () => {
			const event = {
				...testWebhookEvent,
				eventType: "message" as SlackWebhookEvent["eventType"],
			};
			const result = translator.translate(event);

			expect(result.success).toBe(false);
			if (result.success) return;

			expect(result.reason).toContain("Unsupported Slack event type");
		});
	});

	describe("translateAsUserPrompt", () => {
		it("translates app_mention as UserPromptMessage", () => {
			const result = translator.translateAsUserPrompt(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.source).toBe("slack");
			expect(result.message.action).toBe("user_prompt");
		});

		it("strips @mention from content", () => {
			const result = translator.translateAsUserPrompt(testWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			const msg = result.message as { content: string };
			expect(msg.content).toBe(
				"Please fix the failing tests in the CI pipeline",
			);
		});

		it("sets correct session key for threaded messages", () => {
			const result = translator.translateAsUserPrompt(testThreadedWebhookEvent);

			expect(result.success).toBe(true);
			if (!result.success) return;

			expect(result.message.sessionKey).toBe("C9876543210:1704110400.000100");
		});

		it("returns failure for unsupported event types", () => {
			const event = {
				...testWebhookEvent,
				eventType: "message" as SlackWebhookEvent["eventType"],
			};
			const result = translator.translateAsUserPrompt(event);

			expect(result.success).toBe(false);
			if (result.success) return;

			expect(result.reason).toContain("Unsupported Slack event type");
		});
	});
});

describe("stripMention", () => {
	it("strips @mention from the beginning of text", () => {
		expect(stripMention("<@U1234567890> hello world")).toBe("hello world");
	});

	it("handles text without @mention", () => {
		expect(stripMention("hello world")).toBe("hello world");
	});

	it("handles text with leading whitespace before @mention", () => {
		expect(stripMention("  <@U1234567890> hello")).toBe("hello");
	});

	it("handles empty text after stripping mention", () => {
		expect(stripMention("<@U1234567890>")).toBe("");
	});

	it("does not strip @mentions in the middle of text", () => {
		expect(stripMention("hello <@U1234567890> world")).toBe(
			"hello <@U1234567890> world",
		);
	});
});
