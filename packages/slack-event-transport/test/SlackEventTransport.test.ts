import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackEventTransport } from "../src/SlackEventTransport.js";
import type { SlackEventTransportConfig } from "../src/types.js";
import {
	testEventEnvelope,
	testThreadedEventEnvelope,
	testThreadedMessageEnvelope,
	testUrlVerificationEnvelope,
} from "./fixtures.js";

/**
 * Creates a mock Fastify server with a `post` method.
 * Handles both (path, handler) and (path, options, handler) signatures.
 */
function createMockFastify() {
	const routes: Record<
		string,
		(request: unknown, reply: unknown) => Promise<void>
	> = {};
	return {
		post: vi.fn((path: string, ...args: unknown[]) => {
			const handler = (args.length === 1 ? args[0] : args[1]) as (
				request: unknown,
				reply: unknown,
			) => Promise<void>;
			routes[path] = handler;
		}),
		routes,
	};
}

/**
 * Creates a mock Fastify request with optional rawBody for signature verification
 */
function createMockRequest(
	body: unknown,
	headers: Record<string, string> = {},
) {
	const rawBody = JSON.stringify(body);
	return {
		body,
		rawBody,
		headers,
	};
}

/**
 * Creates Slack signature headers for a request body
 */
function signSlackRequest(rawBody: string, secret: string, timestamp?: string) {
	const ts = timestamp ?? String(Math.floor(Date.now() / 1000));
	const sigBaseString = `v0:${ts}:${rawBody}`;
	const sig = `v0=${createHmac("sha256", secret).update(sigBaseString).digest("hex")}`;
	return { timestamp: ts, signature: sig };
}

/**
 * Creates a mock Fastify reply
 */
function createMockReply() {
	const reply = {
		code: vi.fn().mockReturnThis(),
		send: vi.fn().mockReturnThis(),
	};
	return reply;
}

describe("SlackEventTransport", () => {
	let mockFastify: ReturnType<typeof createMockFastify>;
	const testSecret = "test-webhook-secret-123";

	beforeEach(() => {
		vi.clearAllMocks();
		mockFastify = createMockFastify();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("register", () => {
		it("registers POST /slack-webhook endpoint", () => {
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};

			const transport = new SlackEventTransport(config);
			transport.register();

			expect(mockFastify.post).toHaveBeenCalledWith(
				"/slack-webhook",
				expect.objectContaining({ config: { rawBody: true } }),
				expect.any(Function),
			);
		});
	});

	describe("proxy mode verification", () => {
		let transport: SlackEventTransport;

		beforeEach(() => {
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			transport = new SlackEventTransport(config);
			transport.register();
		});

		it("accepts valid Bearer token and emits event", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(testEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "app_mention",
					eventId: "Ev0001",
					teamId: "T0001",
					// Proxy mode: CYHOST already gated this event upstream.
					upstreamGated: true,
				}),
			);
		});

		it("rejects missing Authorization header", async () => {
			const request = createMockRequest(testEventEnvelope, {});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing Authorization header",
			});
		});

		it("rejects invalid Bearer token", async () => {
			const request = createMockRequest(testEventEnvelope, {
				authorization: "Bearer wrong-token",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Invalid authorization token",
			});
		});
	});

	describe("event handling", () => {
		let transport: SlackEventTransport;

		beforeEach(() => {
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			transport = new SlackEventTransport(config);
			transport.register();
		});

		it("responds to Slack URL verification challenge", async () => {
			const request = createMockRequest(testUrlVerificationEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				challenge: "test-challenge-string",
			});
		});

		it("emits message event with translated InternalMessage", async () => {
			const messageListener = vi.fn();
			transport.on("message", messageListener);

			const request = createMockRequest(testEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(messageListener).toHaveBeenCalledWith(
				expect.objectContaining({
					source: "slack",
					action: "session_start",
					initialPrompt: "Please fix the failing tests in the CI pipeline",
				}),
			);
		});

		it("processes threaded app_mention events", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(testThreadedEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "app_mention",
					eventId: "Ev0002",
					payload: expect.objectContaining({
						thread_ts: "1704110400.000100",
					}),
				}),
			);
		});

		it("reads Slack Bot token from SLACK_BOT_TOKEN environment variable", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const envBotToken = "xoxb-env-token-98765";
			process.env.SLACK_BOT_TOKEN = envBotToken;

			try {
				const request = createMockRequest(testEventEnvelope, {
					authorization: `Bearer ${testSecret}`,
				});
				const reply = createMockReply();

				const handler = mockFastify.routes["/slack-webhook"]!;
				await handler(request, reply);

				expect(reply.code).toHaveBeenCalledWith(200);
				expect(eventListener).toHaveBeenCalledWith(
					expect.objectContaining({
						slackBotToken: envBotToken,
					}),
				);
			} finally {
				delete process.env.SLACK_BOT_TOKEN;
			}
		});

		it("sets slackBotToken to undefined when SLACK_BOT_TOKEN env var is not set", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			delete process.env.SLACK_BOT_TOKEN;

			const request = createMockRequest(testEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					slackBotToken: undefined,
				}),
			);
		});

		it("ignores unsupported envelope types", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const unsupportedEnvelope = {
				...testEventEnvelope,
				type: "some_other_type",
			};
			const request = createMockRequest(unsupportedEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("ignores events with an unsupported type", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const envelope = {
				...testEventEnvelope,
				event: { ...testEventEnvelope.event, type: "reaction_added" },
			};
			const request = createMockRequest(envelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("emits threaded message events as follow-ups", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(testThreadedMessageEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "message",
					eventId: "Ev0004",
					payload: expect.objectContaining({
						thread_ts: "1704110400.000100",
					}),
				}),
			);
		});

		it("ignores non-threaded message events", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const envelope = {
				...testThreadedMessageEnvelope,
				event: { ...testThreadedMessageEnvelope.event, thread_ts: undefined },
			};
			const request = createMockRequest(envelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("ignores message events from a bot (loop prevention)", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const envelope = {
				...testThreadedMessageEnvelope,
				event: { ...testThreadedMessageEnvelope.event, bot_id: "B0BOT" },
			};
			const request = createMockRequest(envelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("ignores message events with a subtype (edits, joins, etc.)", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const envelope = {
				...testThreadedMessageEnvelope,
				event: {
					...testThreadedMessageEnvelope.event,
					subtype: "message_changed",
				},
			};
			const request = createMockRequest(envelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("ignores message events when thread-following is disabled", async () => {
			const disabledTransport = new SlackEventTransport({
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
				isThreadFollowingEnabled: () => false,
			});
			disabledTransport.register();
			const eventListener = vi.fn();
			disabledTransport.on("event", eventListener);

			const request = createMockRequest(testThreadedMessageEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("still processes app_mention when thread-following is disabled, even after the message twin", async () => {
			const disabledTransport = new SlackEventTransport({
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
				isThreadFollowingEnabled: () => false,
			});
			disabledTransport.register();
			const eventListener = vi.fn();
			disabledTransport.on("event", eventListener);
			const handler = mockFastify.routes["/slack-webhook"]!;

			// The message twin of an @mention arrives first (same channel:ts).
			const messageTwin = {
				...testThreadedMessageEnvelope,
				event: {
					...testThreadedMessageEnvelope.event,
					ts: "1704110500.000200",
				},
			};
			await handler(
				createMockRequest(messageTwin, {
					authorization: `Bearer ${testSecret}`,
				}),
				createMockReply(),
			);
			// Dropped without poisoning the de-dup, so the app_mention still emits.
			expect(eventListener).not.toHaveBeenCalled();

			await handler(
				createMockRequest(testThreadedEventEnvelope, {
					authorization: `Bearer ${testSecret}`,
				}),
				createMockReply(),
			);
			expect(eventListener).toHaveBeenCalledTimes(1);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({ eventType: "app_mention" }),
			);
		});

		it("de-duplicates app_mention + message delivery for the same message", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const handler = mockFastify.routes["/slack-webhook"]!;

			// app_mention arrives first for ts 1704110500.000200
			await handler(
				createMockRequest(testThreadedEventEnvelope, {
					authorization: `Bearer ${testSecret}`,
				}),
				createMockReply(),
			);

			// Slack also delivers the matching message event (same channel:ts)
			const duplicateMessageEnvelope = {
				...testThreadedMessageEnvelope,
				event: {
					...testThreadedMessageEnvelope.event,
					ts: "1704110500.000200",
				},
			};
			const dupReply = createMockReply();
			await handler(
				createMockRequest(duplicateMessageEnvelope, {
					authorization: `Bearer ${testSecret}`,
				}),
				dupReply,
			);

			// Only the first (app_mention) event is emitted; the message is dropped.
			expect(eventListener).toHaveBeenCalledTimes(1);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({ eventType: "app_mention" }),
			);
			expect(dupReply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
		});
	});

	describe("error handling", () => {
		it("returns 500 when proxy webhook processing throws", async () => {
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			const transport = new SlackEventTransport(config);
			transport.register();

			// Create a request with null body to trigger an error
			const request = createMockRequest(null, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(500);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Failed to process webhook",
			});
		});

		it("emits error and returns 500 for unexpected errors in outer handler", async () => {
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			const transport = new SlackEventTransport(config);
			transport.register();

			const errorListener = vi.fn();
			transport.on("error", errorListener);

			const request = {
				body: testEventEnvelope,
				get headers() {
					throw new Error("Unexpected headers access error");
				},
			};
			const reply = createMockReply();

			const handler = mockFastify.routes["/slack-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(500);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Internal server error",
			});
			expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
		});
	});

	describe("direct mode verification", () => {
		const signingSecret = "test-slack-signing-secret";
		let transport: SlackEventTransport;

		beforeEach(() => {
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "direct",
				secret: signingSecret,
			};
			transport = new SlackEventTransport(config);
			transport.register();
		});

		it("accepts valid HMAC-SHA256 signature and emits event", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(testEventEnvelope);
			const { timestamp, signature } = signSlackRequest(
				request.rawBody,
				signingSecret,
			);
			request.headers["x-slack-request-timestamp"] = timestamp;
			request.headers["x-slack-signature"] = signature;

			const reply = createMockReply();
			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "app_mention",
					eventId: "Ev0001",
					teamId: "T0001",
					// Direct mode: no upstream gate, runtime must self-gate.
					upstreamGated: false,
				}),
			);
		});

		it("rejects missing signature headers", async () => {
			const request = createMockRequest(testEventEnvelope);

			const reply = createMockReply();
			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing Slack signature headers",
			});
		});

		it("rejects invalid signature", async () => {
			const request = createMockRequest(testEventEnvelope);
			request.headers["x-slack-request-timestamp"] = String(
				Math.floor(Date.now() / 1000),
			);
			request.headers["x-slack-signature"] =
				"v0=0000000000000000000000000000000000000000000000000000000000000000";

			const reply = createMockReply();
			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Invalid webhook signature",
			});
		});

		it("rejects stale timestamp (>5 minutes old)", async () => {
			const request = createMockRequest(testEventEnvelope);
			const staleTimestamp = String(Math.floor(Date.now() / 1000) - 600);
			const { signature } = signSlackRequest(
				request.rawBody,
				signingSecret,
				staleTimestamp,
			);
			request.headers["x-slack-request-timestamp"] = staleTimestamp;
			request.headers["x-slack-signature"] = signature;

			const reply = createMockReply();
			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Request timestamp too old",
			});
		});

		it("handles URL verification challenge in direct mode", async () => {
			const request = createMockRequest(testUrlVerificationEnvelope);
			const { timestamp, signature } = signSlackRequest(
				request.rawBody,
				signingSecret,
			);
			request.headers["x-slack-request-timestamp"] = timestamp;
			request.headers["x-slack-signature"] = signature;

			const reply = createMockReply();
			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				challenge: "test-challenge-string",
			});
		});
	});

	describe("runtime mode switching (proxy → direct)", () => {
		const runtimeSigningSecret = "runtime-slack-signing-secret";
		let transport: SlackEventTransport;

		beforeEach(() => {
			// Start in proxy mode (no signing secret at startup)
			const config: SlackEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as SlackEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			transport = new SlackEventTransport(config);
			transport.register();
		});

		afterEach(() => {
			delete process.env.SLACK_SIGNING_SECRET;
			delete process.env.MIKO_HOST_EXTERNAL;
		});

		it("switches to direct verification when SLACK_SIGNING_SECRET and MIKO_HOST_EXTERNAL are set at request time", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			// Add env vars after startup
			process.env.SLACK_SIGNING_SECRET = runtimeSigningSecret;
			process.env.MIKO_HOST_EXTERNAL = "true";

			const request = createMockRequest(testEventEnvelope);
			const { timestamp, signature } = signSlackRequest(
				request.rawBody,
				runtimeSigningSecret,
			);
			request.headers["x-slack-request-timestamp"] = timestamp;
			request.headers["x-slack-signature"] = signature;

			const reply = createMockReply();
			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "app_mention",
					eventId: "Ev0001",
				}),
			);
		});

		it("stays in proxy mode when only SLACK_SIGNING_SECRET is set (no MIKO_HOST_EXTERNAL)", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			// Only set signing secret, not external host flag
			process.env.SLACK_SIGNING_SECRET = runtimeSigningSecret;
			delete process.env.MIKO_HOST_EXTERNAL;

			const request = createMockRequest(testEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "app_mention",
				}),
			);
		});

		it("stays in proxy mode when neither env var is set", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			delete process.env.SLACK_SIGNING_SECRET;
			delete process.env.MIKO_HOST_EXTERNAL;

			const request = createMockRequest(testEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "app_mention",
				}),
			);
		});

		it("rejects proxy-style request after switching to direct mode", async () => {
			// Add env vars to trigger direct mode
			process.env.SLACK_SIGNING_SECRET = runtimeSigningSecret;
			process.env.MIKO_HOST_EXTERNAL = "true";

			// Send request with Bearer token (proxy style) — should fail
			// because direct mode expects Slack signature headers
			const request = createMockRequest(testEventEnvelope, {
				authorization: `Bearer ${testSecret}`,
			});
			const reply = createMockReply();

			await mockFastify.routes["/slack-webhook"]!(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing Slack signature headers",
			});
		});
	});
});
