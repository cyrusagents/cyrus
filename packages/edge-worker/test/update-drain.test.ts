import { afterEach, describe, expect, it } from "vitest";
import { SharedApplicationServer } from "../src/SharedApplicationServer.js";

describe("update admission drain", () => {
	let server: SharedApplicationServer;
	afterEach(async () => {
		await server.getFastifyInstance().close();
	});
	it("waits for in-flight requests, then rejects new work during the restart", async () => {
		server = new SharedApplicationServer(0, "localhost", true);
		server.initializeFastify();
		const app = server.getFastifyInstance();
		let finish!: () => void;
		let started!: () => void;
		const admitted = new Promise<void>((resolve) => {
			started = resolve;
		});
		app.post("/work", async () => {
			started();
			await new Promise<void>((resolve) => {
				finish = resolve;
			});
			return { ok: true };
		});
		const running = app
			.inject({ method: "POST", url: "/work" })
			.then((response) => response);
		await admitted;
		expect(server.tryDrainForUpdate()).toBe(false);
		finish();
		expect((await running).statusCode).toBe(200);
		expect(server.tryDrainForUpdate()).toBe(true);
		const rejected = await app.inject({ method: "POST", url: "/work" });
		expect(rejected.statusCode).toBe(503);
		expect(rejected.headers["retry-after"]).toBe("30");
		server.resumeAfterUpdate();
		expect(
			(await app.inject({ method: "GET", url: "/robots.txt" })).statusCode,
		).toBe(200);
	});
	it("does not remain busy after a handler error", async () => {
		server = new SharedApplicationServer(0, "localhost", true);
		server.initializeFastify();
		const app = server.getFastifyInstance();
		app.post("/failure", async () => {
			throw Error("failure");
		});
		expect(
			(await app.inject({ method: "POST", url: "/failure" })).statusCode,
		).toBe(500);
		expect(server.tryDrainForUpdate()).toBe(true);
	});
});
