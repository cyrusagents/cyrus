import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubEventTransport } from "../src/GitHubEventTransport.js";
import type { GitHubEventTransportConfig } from "../src/types.js";
import {
	issueCommentPayload,
	prReviewCommentPayload,
	prReviewPayload,
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
		post: vi.fn((path: string, ...args: unknown[]) => {
			// Handle both (path, handler) and (path, options, handler) signatures
			const handler =
				args.length === 1
					? (args[0] as (request: unknown, reply: unknown) => Promise<void>)
					: (args[1] as (request: unknown, reply: unknown) => Promise<void>);
			routes[path] = handler;
		}),
		routes,
	};
}

/**
 * Creates a mock Fastify request
 */
function createMockRequest(
	body: unknown,
	headers: Record<string, string> = {},
	ip: string = "127.0.0.1",
) {
	const rawBody = JSON.stringify(body);
	return {
		body,
		rawBody,
		headers,
		ip,
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

describe("GitHubEventTransport", () => {
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
		it("registers POST /github-webhook endpoint in proxy mode", () => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};

			const transport = new GitHubEventTransport(config);
			transport.register();

			expect(mockFastify.post).toHaveBeenCalledWith(
				"/github-webhook",
				expect.any(Object),
				expect.any(Function),
			);
		});

		it("registers POST /github-webhook endpoint in signature mode", () => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "signature",
				secret: testSecret,
			};

			const transport = new GitHubEventTransport(config);
			transport.register();

			expect(mockFastify.post).toHaveBeenCalledWith(
				"/github-webhook",
				expect.any(Object),
				expect.any(Function),
			);
		});
	});

	describe("proxy mode verification", () => {
		let transport: GitHubEventTransport;

		beforeEach(() => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			transport = new GitHubEventTransport(config);
			transport.register();
		});

		it("accepts valid Bearer token and emits event", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-123",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-123",
					payload: issueCommentPayload,
				}),
			);
		});

		it("rejects missing Authorization header", async () => {
			const request = createMockRequest(issueCommentPayload, {
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-123",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing Authorization header",
			});
		});

		it("rejects invalid Bearer token", async () => {
			const request = createMockRequest(issueCommentPayload, {
				authorization: "Bearer wrong-token",
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-123",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Invalid authorization token",
			});
		});
	});

	describe("signature mode verification", () => {
		let transport: GitHubEventTransport;

		beforeEach(() => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "signature",
				secret: testSecret,
			};
			transport = new GitHubEventTransport(config);
			transport.register();
		});

		it("accepts valid HMAC-SHA256 signature and emits event", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(issueCommentPayload, {
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-456",
			});
			const signature = `sha256=${createHmac("sha256", testSecret).update(request.rawBody).digest("hex")}`;
			request.headers["x-hub-signature-256"] = signature;
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-456",
				}),
			);
		});

		it("rejects missing x-hub-signature-256 header", async () => {
			const request = createMockRequest(issueCommentPayload, {
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-456",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing x-hub-signature-256 header",
			});
		});

		it("rejects invalid signature", async () => {
			const request = createMockRequest(issueCommentPayload, {
				"x-hub-signature-256": "sha256=invalid_signature_here",
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-456",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Invalid webhook signature",
			});
		});
	});

	describe("event filtering", () => {
		let transport: GitHubEventTransport;

		beforeEach(() => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			transport = new GitHubEventTransport(config);
			transport.register();
		});

		it("ignores unsupported event types", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(
				{ action: "created" },
				{
					authorization: `Bearer ${testSecret}`,
					"x-github-event": "deployment",
					"x-github-delivery": "delivery-789",
				},
			);
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("ignores events without x-github-event header", async () => {
			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-delivery": "delivery-789",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(400);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing x-github-event header",
			});
		});

		it("ignores non-created actions (edited, deleted)", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const editedPayload = {
				...issueCommentPayload,
				action: "edited" as const,
			};

			const request = createMockRequest(editedPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-789",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("processes pull_request_review_comment events", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(prReviewCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "pull_request_review_comment",
				"x-github-delivery": "delivery-pr-001",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "pull_request_review_comment",
					deliveryId: "delivery-pr-001",
					payload: prReviewCommentPayload,
				}),
			);
		});

		it("processes pull_request_review events with submitted action", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(prReviewPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "pull_request_review",
				"x-github-delivery": "delivery-pr-review-001",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "pull_request_review",
					deliveryId: "delivery-pr-review-001",
					payload: prReviewPayload,
				}),
			);
		});

		it("ignores pull_request_review events with edited action", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const editedReviewPayload = {
				...prReviewPayload,
				action: "edited" as const,
			};

			const request = createMockRequest(editedReviewPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "pull_request_review",
				"x-github-delivery": "delivery-pr-review-002",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("ignores pull_request_review events with dismissed action", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const dismissedReviewPayload = {
				...prReviewPayload,
				action: "dismissed" as const,
			};

			const request = createMockRequest(dismissedReviewPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "pull_request_review",
				"x-github-delivery": "delivery-pr-review-003",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({
				success: true,
				ignored: true,
			});
			expect(eventListener).not.toHaveBeenCalled();
		});

		it("extracts installation token from X-GitHub-Installation-Token header", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const installationToken = "ghs_test_installation_token_12345";

			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-token-test",
				"x-github-installation-token": installationToken,
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-token-test",
					payload: issueCommentPayload,
					installationToken,
				}),
			);
		});

		it("includes undefined installationToken when header is not present", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-no-token",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-no-token",
					payload: issueCommentPayload,
					installationToken: undefined,
				}),
			);
		});
	});

	describe("error handling", () => {
		it("returns 500 when proxy webhook processing throws", async () => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			const transport = new GitHubEventTransport(config);
			transport.register();

			// Create a request with null body that will cause processAndEmitEvent
			// to throw when accessing request.body.action
			const request = createMockRequest(null, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-err",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			// The inner catch in handleProxyWebhook handles the error and sends 500
			expect(reply.code).toHaveBeenCalledWith(500);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Failed to process webhook",
			});
		});

		it("emits error and returns 500 for unexpected errors in outer handler", async () => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			const transport = new GitHubEventTransport(config);
			transport.register();

			const errorListener = vi.fn();
			transport.on("error", errorListener);

			// Create a request without authorization header AND with a body
			// that triggers the auth check but the headers object itself causes issues
			const request = {
				body: issueCommentPayload,
				get headers() {
					// First access for authorization returns undefined (triggers rejection),
					// but we need the outer catch to fire, not the inner one
					throw new Error("Unexpected headers access error");
				},
			};
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(500);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Internal server error",
			});
			expect(errorListener).toHaveBeenCalledWith(expect.any(Error));
		});
	});

	describe("runtime mode switching (proxy → signature)", () => {
		const runtimeWebhookSecret = "runtime-github-webhook-secret";
		let transport: GitHubEventTransport;

		beforeEach(() => {
			// Start in proxy mode (no webhook secret at startup)
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
			};
			transport = new GitHubEventTransport(config);
			transport.register();
		});

		afterEach(() => {
			delete process.env.GITHUB_WEBHOOK_SECRET;
			delete process.env.CYRUS_HOST_EXTERNAL;
		});

		it("switches to signature verification when GITHUB_WEBHOOK_SECRET and CYRUS_HOST_EXTERNAL are set at request time", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			// Add env vars after startup
			process.env.GITHUB_WEBHOOK_SECRET = runtimeWebhookSecret;
			process.env.CYRUS_HOST_EXTERNAL = "true";

			const request = createMockRequest(issueCommentPayload, {
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-runtime-001",
			});
			const signature = `sha256=${createHmac("sha256", runtimeWebhookSecret).update(request.rawBody).digest("hex")}`;
			request.headers["x-hub-signature-256"] = signature;
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-runtime-001",
				}),
			);
		});

		it("stays in proxy mode when only GITHUB_WEBHOOK_SECRET is set (no CYRUS_HOST_EXTERNAL)", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			// Only set webhook secret, not external host flag
			process.env.GITHUB_WEBHOOK_SECRET = runtimeWebhookSecret;
			delete process.env.CYRUS_HOST_EXTERNAL;

			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-proxy-001",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-proxy-001",
				}),
			);
		});

		it("stays in proxy mode when neither env var is set", async () => {
			const eventListener = vi.fn();
			transport.on("event", eventListener);

			delete process.env.GITHUB_WEBHOOK_SECRET;
			delete process.env.CYRUS_HOST_EXTERNAL;

			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-proxy-002",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(reply.send).toHaveBeenCalledWith({ success: true });
			expect(eventListener).toHaveBeenCalledWith(
				expect.objectContaining({
					eventType: "issue_comment",
					deliveryId: "delivery-proxy-002",
				}),
			);
		});

		it("rejects proxy-style request after switching to signature mode", async () => {
			// Add env vars to trigger signature mode
			process.env.GITHUB_WEBHOOK_SECRET = runtimeWebhookSecret;
			process.env.CYRUS_HOST_EXTERNAL = "true";

			// Send request with Bearer token (proxy style) — should fail
			// because signature mode expects x-hub-signature-256 header
			const request = createMockRequest(issueCommentPayload, {
				authorization: `Bearer ${testSecret}`,
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-reject-001",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Missing x-hub-signature-256 header",
			});
		});

		it("rejects invalid signature after switching to signature mode", async () => {
			// Add env vars to trigger signature mode
			process.env.GITHUB_WEBHOOK_SECRET = runtimeWebhookSecret;
			process.env.CYRUS_HOST_EXTERNAL = "true";

			const request = createMockRequest(issueCommentPayload, {
				"x-hub-signature-256": "sha256=invalid_signature_here",
				"x-github-event": "issue_comment",
				"x-github-delivery": "delivery-invalid-001",
			});
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(401);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Invalid webhook signature",
			});
		});
	});

	describe("IP allowlist validation", () => {
		it("rejects webhook from unauthorized IP when allowlist is configured", async () => {
			const secret = "test-github-webhook-secret";
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "signature",
				secret,
				ipAllowlist: ["10.0.0.1", "10.0.0.2"],
			};

			const transport = new GitHubEventTransport(config);
			transport.register();

			const body = JSON.stringify(issueCommentPayload);
			const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

			const request = createMockRequest(
				issueCommentPayload,
				{
					"x-hub-signature-256": signature,
					"x-github-event": "issue_comment",
					"x-github-delivery": "delivery-ip-test",
				},
				"192.168.1.100", // unauthorized IP
			);
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(403);
			expect(reply.send).toHaveBeenCalledWith({
				error: "Forbidden: unauthorized source IP",
			});
		});

		it("accepts webhook from authorized IP when allowlist is configured", async () => {
			const secret = "test-github-webhook-secret";
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "signature",
				secret,
				ipAllowlist: ["10.0.0.0/8"],
			};

			const transport = new GitHubEventTransport(config);
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			transport.register();

			const body = JSON.stringify(issueCommentPayload);
			const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

			const request = createMockRequest(
				issueCommentPayload,
				{
					"x-hub-signature-256": signature,
					"x-github-event": "issue_comment",
					"x-github-delivery": "delivery-ip-ok",
				},
				"10.5.3.1", // authorized IP within CIDR
			);
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalled();
		});

		it("skips IP validation when no allowlist is configured", async () => {
			const secret = "test-github-webhook-secret";
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "signature",
				secret,
				// No ipAllowlist
			};

			const transport = new GitHubEventTransport(config);
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			transport.register();

			const body = JSON.stringify(issueCommentPayload);
			const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

			const request = createMockRequest(
				issueCommentPayload,
				{
					"x-hub-signature-256": signature,
					"x-github-event": "issue_comment",
					"x-github-delivery": "delivery-no-allowlist",
				},
				"1.2.3.4", // any IP should work
			);
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalled();
		});

		it("does not validate IP in proxy mode", async () => {
			const config: GitHubEventTransportConfig = {
				fastifyServer:
					mockFastify as unknown as GitHubEventTransportConfig["fastifyServer"],
				verificationMode: "proxy",
				secret: testSecret,
				ipAllowlist: ["10.0.0.1"], // should be ignored in proxy mode
			};

			const transport = new GitHubEventTransport(config);
			const eventListener = vi.fn();
			transport.on("event", eventListener);
			transport.register();

			const request = createMockRequest(
				issueCommentPayload,
				{
					authorization: `Bearer ${testSecret}`,
					"x-github-event": "issue_comment",
					"x-github-delivery": "delivery-proxy-ip",
				},
				"192.168.1.100", // different from allowlist
			);
			const reply = createMockReply();

			const handler = mockFastify.routes["/github-webhook"]!;
			await handler(request, reply);

			// Should succeed because proxy mode doesn't check IPs
			expect(reply.code).toHaveBeenCalledWith(200);
			expect(eventListener).toHaveBeenCalled();
		});
	});
});
