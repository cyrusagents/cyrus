import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackEventTransport } from "../src/SlackEventTransport.js";
import type { SlackEventTransportConfig } from "../src/types.js";
import {
	testEventEnvelope,
	testThreadedEventEnvelope,
	testUrlVerificationEnvelope,
} from "./fixtures.js";

/**
 * Creates a mock Fastify server with a `post` method
 */
function createMockFastify() {
	const routes: Record<
		string,
		(request: unknown, reply: unknown) => Promise<void>
	> = {};
	return {
		post: vi.fn(
			(
				path: string,
				handler: (request: unknown, reply: unknown) => Promise<void>,
			) => {
				routes[path] = handler;
			},
		),
		routes,
	};
}

/**
 * Creates a mock Fastify request
 */
function createMockRequest(
	body: unknown,
	headers: Record<string, string> = {},
) {
	return {
		body,
		headers,
	};
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

		it("ignores events with non-app_mention type", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const envelope = {
				...testEventEnvelope,
				event: { ...testEventEnvelope.event, type: "message" },
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
});
