import { describe, expect, it } from "vitest";
import {
	formatSlackThreadKey,
	parseSlackControlCommand,
	SLACK_STOP_ACTION_ID,
	threadKeyFromBlockActions,
	threadKeyFromSlashCommand,
} from "../src/SlackInteractions.js";

/**
 * These helpers decide what a click or a slash command is allowed to address.
 * The thread key they produce has to match `SlackChatAdapter.getThreadKey` —
 * `<channel>:<thread_ts || ts>` — or a stop lands on the wrong session.
 */
describe("SlackInteractions", () => {
	describe("formatSlackThreadKey", () => {
		it("matches the chat adapter's thread key format", () => {
			expect(formatSlackThreadKey("C9876543210", "1704110400.000100")).toBe(
				"C9876543210:1704110400.000100",
			);
		});
	});

	describe("parseSlackControlCommand", () => {
		it("recognizes the stop verb", () => {
			expect(parseSlackControlCommand("stop")).toBe("stop");
		});

		it("ignores case and trailing words", () => {
			expect(parseSlackControlCommand("  STOP now please ")).toBe("stop");
		});

		it("returns undefined for anything else", () => {
			expect(parseSlackControlCommand("")).toBeUndefined();
			expect(parseSlackControlCommand("status")).toBeUndefined();
			expect(parseSlackControlCommand("stopwatch")).toBeUndefined();
		});
	});

	describe("threadKeyFromBlockActions", () => {
		const basePayload = {
			type: "block_actions" as const,
			trigger_id: "trigger-1",
			user: { id: "U1234567890" },
			actions: [{ action_id: SLACK_STOP_ACTION_ID, type: "button" }],
		};

		it("uses the click target's thread, not the message's own ts", () => {
			const threadKey = threadKeyFromBlockActions({
				...basePayload,
				channel: { id: "C9876543210" },
				message: {
					ts: "1704110500.000200",
					thread_ts: "1704110400.000100",
				},
			});

			expect(threadKey).toBe("C9876543210:1704110400.000100");
		});

		it("falls back to the message ts for a root message and to the container", () => {
			expect(
				threadKeyFromBlockActions({
					...basePayload,
					container: { channel_id: "C1", message_ts: "1704110400.000100" },
					message: { ts: "1704110400.000100" },
				}),
			).toBe("C1:1704110400.000100");
		});

		it("returns null when there is no channel or no timestamp", () => {
			expect(threadKeyFromBlockActions(basePayload)).toBeNull();
			expect(
				threadKeyFromBlockActions({
					...basePayload,
					channel: { id: "C1" },
					message: {},
				}),
			).toBeNull();
		});
	});

	describe("threadKeyFromSlashCommand", () => {
		const baseCommand = {
			type: "slash_command" as const,
			command: "/cyrus",
			text: "stop",
			trigger_id: "trigger-2",
			response_url: "https://hooks.slack.com/commands/1",
			user_id: "U1234567890",
			channel_id: "C9876543210",
			team_id: "T0001",
		};

		it("uses the thread the command was run in", () => {
			expect(
				threadKeyFromSlashCommand({
					...baseCommand,
					thread_ts: "1704110400.000100",
				}),
			).toBe("C9876543210:1704110400.000100");
		});

		it("returns null when run outside a thread", () => {
			expect(threadKeyFromSlashCommand(baseCommand)).toBeNull();
		});
	});
});
