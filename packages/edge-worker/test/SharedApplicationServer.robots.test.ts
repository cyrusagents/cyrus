import { describe, expect, it } from "vitest";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";

describe("SharedApplicationServer crawler controls", () => {
	it("serves robots.txt that disallows crawling", async () => {
		const server = new SharedApplicationServer();
		const app = server.getFastifyInstance();

		const response = await app.inject({
			method: "GET",
			url: "/robots.txt",
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["content-type"]).toContain("text/plain");
		expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
		expect(response.body).toBe("User-agent: *\nDisallow: /\n");
	});

	it("adds a noindex header to application responses", async () => {
		const server = new SharedApplicationServer();
		const app = server.getFastifyInstance();

		app.get("/status-check", async () => ({ ok: true }));

		const response = await app.inject({
			method: "GET",
			url: "/status-check",
		});

		expect(response.statusCode).toBe(200);
		expect(response.headers["x-robots-tag"]).toBe("noindex, nofollow");
	});
});
