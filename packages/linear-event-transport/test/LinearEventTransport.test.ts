import type { FastifyInstance } from "fastify";
import { describe, expect, it, vi } from "vitest";
import { LinearEventTransport } from "../src/LinearEventTransport.js";

describe("LinearEventTransport", () => {
	describe("register", () => {
		it("registers POST /linear-webhook and a deprecated /webhook alias", () => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;

			const transport = new LinearEventTransport({
				fastifyServer,
				verificationMode: "proxy",
				secret: "test-secret",
			});

			transport.register();

			const registeredPaths = post.mock.calls.map((call: unknown[]) => call[0]);
			expect(registeredPaths).toEqual(
				expect.arrayContaining(["/linear-webhook", "/webhook"]),
			);
			expect(post).toHaveBeenCalledTimes(2);
		});

		it("deprecated /webhook alias delegates to the same handler as /linear-webhook", async () => {
			const post = vi.fn();
			const fastifyServer = { post } as unknown as FastifyInstance;

			const transport = new LinearEventTransport({
				fastifyServer,
				verificationMode: "proxy",
				secret: "test-secret",
			});

			transport.register();

			const calls = post.mock.calls as Array<
				[string, (request: unknown, reply: unknown) => Promise<void>]
			>;
			const primary = calls.find(([path]) => path === "/linear-webhook");
			const deprecated = calls.find(([path]) => path === "/webhook");
			expect(primary).toBeDefined();
			expect(deprecated).toBeDefined();

			const makeReply = () => ({
				code: vi.fn().mockReturnThis(),
				send: vi.fn().mockReturnThis(),
			});

			const unauthorizedRequest = {
				headers: {},
			};

			const primaryReply = makeReply();
			await primary![1](unauthorizedRequest, primaryReply);
			expect(primaryReply.code).toHaveBeenCalledWith(401);

			const deprecatedReply = makeReply();
			await deprecated![1](unauthorizedRequest, deprecatedReply);
			expect(deprecatedReply.code).toHaveBeenCalledWith(401);
		});
	});
});
