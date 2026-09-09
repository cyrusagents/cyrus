import type {
	ZulipMessage,
	ZulipWebhookEvent,
} from "cyrus-zulip-event-transport";
import { ZulipMessageService } from "cyrus-zulip-event-transport";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatRepositoryProvider } from "../src/ChatRepositoryProvider.js";
import { ZulipChatAdapter } from "../src/ZulipChatAdapter.js";

const credentials = {
	site: "https://example.zulipchat.com",
	botEmail: "impala-bot@example.zulipchat.com",
	apiKey: "api-key",
};

const repositoryProvider = {
	getRepositoryPaths: () => ["/repos/alean"],
	getDefaultRepository: () => undefined,
	getDefaultLinearWorkspaceId: () => undefined,
} as unknown as ChatRepositoryProvider;

function streamMessage(overrides: Partial<ZulipMessage> = {}): ZulipMessage {
	return {
		id: 4242,
		type: "stream",
		content: "@**Impala** what changed?",
		sender_id: 7,
		sender_email: "nate@example.com",
		sender_full_name: "Nate",
		subject: "parser rewrite",
		stream_id: 99,
		display_recipient: "engineering",
		timestamp: 1_760_000_000,
		...overrides,
	};
}

function event(message: ZulipMessage): ZulipWebhookEvent {
	return {
		trigger: message.type === "stream" ? "mention" : "direct_message",
		message,
		data: message.content,
		botEmail: credentials.botEmail,
		botFullName: "Impala",
		credentials,
	};
}

function adapterWith(service: ZulipMessageService) {
	return new ZulipChatAdapter(repositoryProvider, undefined, {
		messageService: service,
	});
}

describe("ZulipChatAdapter", () => {
	let service: ZulipMessageService;

	beforeEach(() => {
		vi.clearAllMocks();
		service = new ZulipMessageService();
	});

	describe("thread identity", () => {
		it("keys a channel message on channel and topic", () => {
			const adapter = adapterWith(service);
			expect(adapter.getThreadKey(event(streamMessage()))).toBe(
				"99:parser rewrite",
			);
		});

		it("keys two topics in one channel separately", () => {
			const adapter = adapterWith(service);
			const a = adapter.getThreadKey(event(streamMessage()));
			const b = adapter.getThreadKey(
				event(streamMessage({ subject: "other topic" })),
			);
			expect(a).not.toBe(b);
		});

		it("keeps the same key when the topic is resolved or unresolved", () => {
			const adapter = adapterWith(service);
			// Zulip resolves a topic by renaming it, so the session must not be
			// stranded when someone ticks the checkmark mid-conversation.
			const open = adapter.getThreadKey(event(streamMessage()));
			const resolved = adapter.getThreadKey(
				event(streamMessage({ subject: "\u2714 parser rewrite" })),
			);

			expect(resolved).toBe(open);
		});

		it("addresses Zulip by the topic's real name, marker included", async () => {
			const postSpy = vi.spyOn(service, "postMessage").mockResolvedValue(1);
			const fetchSpy = vi
				.spyOn(service, "fetchTopicMessages")
				.mockResolvedValue([]);
			const adapter = adapterWith(service);
			const resolved = event(
				streamMessage({ subject: "\u2714 parser rewrite" }),
			);

			await adapter.fetchThreadContext(resolved);
			await adapter.postReply(resolved, {
				getMessages: () => [],
			} as any);

			expect(fetchSpy).toHaveBeenCalledWith(
				expect.objectContaining({ topic: "\u2714 parser rewrite" }),
			);
			expect(postSpy).toHaveBeenCalledWith(
				expect.objectContaining({
					destination: expect.objectContaining({
						topic: "\u2714 parser rewrite",
					}),
				}),
			);
		});

		it("keys a DM on its participants, regardless of their order", () => {
			const adapter = adapterWith(service);
			const dm = (ids: number[]) =>
				streamMessage({
					type: "private",
					stream_id: undefined,
					display_recipient: ids.map((id) => ({
						id,
						email: `u${id}@example.com`,
						full_name: `User ${id}`,
					})),
				});

			expect(adapter.getThreadKey(event(dm([11, 7])))).toBe(
				adapter.getThreadKey(event(dm([7, 11]))),
			);
			expect(adapter.getThreadKey(event(dm([7, 11])))).toBe("dm:7,11");
		});
	});

	describe("catch-up cursor", () => {
		/**
		 * ChatSessionHandler compares cursors as strings and only advances on a
		 * strictly greater value, so a raw Zulip message ID would stall the
		 * cursor the moment the ID gained a digit ("9" > "10").
		 */
		it("pads the cursor so string ordering stays chronological", () => {
			const adapter = adapterWith(service);
			const older = adapter.getThreadContextTs(
				event(streamMessage({ id: 9 })),
			) as string;
			const newer = adapter.getThreadContextTs(
				event(streamMessage({ id: 10 })),
			) as string;

			expect(older < newer).toBe(true);
		});

		it("gives a DM no cursor, since the bot already sees every DM", () => {
			const adapter = adapterWith(service);
			expect(
				adapter.getThreadContextTs(
					event(streamMessage({ type: "private", stream_id: undefined })),
				),
			).toBeUndefined();
		});

		it("unpads the cursor when selecting what follows it", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue([
				streamMessage({ id: 9, content: "at the cursor" }),
				streamMessage({ id: 10, content: "after the cursor" }),
			]);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage({ id: 11 })),
				"00000000000000000009",
			);

			// A string compare of the padded cursor against a raw id would put
			// "10" before "9" and drop the newer message.
			expect(context).toContain("after the cursor");
			expect(context).not.toContain("at the cursor");
		});
	});

	describe("fetchThreadContext", () => {
		it("returns the catch-up block without the triggering message", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue([
				streamMessage({ id: 4240, content: "we shipped the lexer" }),
				streamMessage({ id: 4242 }),
			]);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage()),
				"00000000000000004239",
			);

			expect(context).toContain("we shipped the lexer");
			expect(context).not.toContain("what changed?");
		});

		it("selects only what follows the cursor", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue([
				streamMessage({ id: 4100, content: "ancient history" }),
				streamMessage({ id: 4241, content: "said since the cursor" }),
			]);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage()),
				"00000000000000004240",
			);

			expect(context).toContain("said since the cursor");
			expect(context).not.toContain("ancient history");
		});

		it("drops its own replies from a catch-up, which the session already holds", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue([
				streamMessage({
					id: 4241,
					sender_email: credentials.botEmail,
					content: "my own earlier reply",
				}),
				streamMessage({ id: 4243, content: "a teammate" }),
			]);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage()),
				"00000000000000004240",
			);

			expect(context).toContain("a teammate");
			expect(context).not.toContain("my own earlier reply");
		});

		it("keeps its own replies for a fresh session, which has no memory", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue([
				streamMessage({
					id: 4241,
					sender_email: credentials.botEmail,
					sender_full_name: "Impala",
					content: "the lexer moved",
				}),
			]);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(event(streamMessage()));

			expect(context).toContain("the lexer moved");
			expect(context).toContain("assistant (you)");
		});

		it("says so when the window filled and older messages fell off", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue(
				Array.from({ length: 50 }, (_, i) =>
					streamMessage({ id: 5000 + i, content: `chatter ${i}` }),
				),
			);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage()),
				"00000000000000004000",
			);

			expect(context).toContain("Older messages in this topic are not shown");
		});

		it("stays silent about truncation when the whole gap fit", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue([
				streamMessage({ id: 4241, content: "the only thing said" }),
			]);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage()),
				"00000000000000004240",
			);

			expect(context).toContain("the only thing said");
			expect(context).not.toContain("not shown");
		});

		it("stays silent about truncation when a full window predates the cursor", async () => {
			// The cap was spent on messages the session has already seen, so
			// nothing in the gap was lost.
			vi.spyOn(service, "fetchTopicMessages").mockResolvedValue(
				Array.from({ length: 50 }, (_, i) =>
					streamMessage({ id: 4000 + i, content: `old chatter ${i}` }),
				),
			);
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage()),
				"00000000000000004048",
			);

			expect(context).not.toContain("not shown");
		});

		it("returns null on a failed read so the cursor does not advance", async () => {
			vi.spyOn(service, "fetchTopicMessages").mockRejectedValue(
				new Error("boom"),
			);
			const adapter = adapterWith(service);

			expect(
				await adapter.fetchThreadContext(event(streamMessage())),
			).toBeNull();
		});

		it("skips the read entirely for a DM", async () => {
			const fetchSpy = vi.spyOn(service, "fetchTopicMessages");
			const adapter = adapterWith(service);

			const context = await adapter.fetchThreadContext(
				event(streamMessage({ type: "private", stream_id: undefined })),
			);

			expect(context).toBe("");
			expect(fetchSpy).not.toHaveBeenCalled();
		});
	});

	describe("replies", () => {
		it("posts the last assistant message back to the topic", async () => {
			const postSpy = vi.spyOn(service, "postMessage").mockResolvedValue(1);
			const adapter = adapterWith(service);

			await adapter.postReply(event(streamMessage()), {
				getMessages: () => [
					{
						type: "assistant",
						message: { content: [{ type: "text", text: "the parser moved" }] },
					},
				],
			} as any);

			expect(postSpy).toHaveBeenCalledWith({
				credentials,
				destination: { type: "stream", streamId: 99, topic: "parser rewrite" },
				content: "the parser moved",
			});
		});

		it("swallows a post failure rather than failing the turn", async () => {
			vi.spyOn(service, "postMessage").mockRejectedValue(new Error("boom"));
			const adapter = adapterWith(service);

			await expect(
				adapter.postReply(event(streamMessage()), {
					getMessages: () => [],
				} as any),
			).resolves.toBeUndefined();
		});
	});

	describe("acknowledgement", () => {
		it("swaps the receipt reaction for the processed one", async () => {
			const addSpy = vi.spyOn(service, "addReaction").mockResolvedValue();
			const removeSpy = vi.spyOn(service, "removeReaction").mockResolvedValue();
			const adapter = adapterWith(service);

			await adapter.acknowledgeProcessed(event(streamMessage()));

			expect(removeSpy).toHaveBeenCalledWith(credentials, 4242, "eyes");
			// Zulip's name for U+2705; `white_check_mark` does not exist there
			expect(addSpy).toHaveBeenCalledWith(credentials, 4242, "check");
		});
	});

	describe("prompt", () => {
		it("strips the mention that summoned it", () => {
			const adapter = adapterWith(service);
			expect(adapter.extractTaskInstructions(event(streamMessage()))).toBe(
				"what changed?",
			);
		});

		it("falls back when the mention carried no text", () => {
			const adapter = adapterWith(service);
			expect(
				adapter.extractTaskInstructions(
					event(streamMessage({ content: "@**Impala**" })),
				),
			).toBe("Ask the user for more context");
		});

		it("names the channel and topic in the system prompt", () => {
			const adapter = adapterWith(service);
			const prompt = adapter.buildSystemPrompt(event(streamMessage()));

			expect(prompt).toContain("engineering");
			expect(prompt).toContain("parser rewrite");
			expect(prompt).toContain("/repos/alean");
		});
	});
});
