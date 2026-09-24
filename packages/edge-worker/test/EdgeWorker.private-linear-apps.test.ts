import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FastifyInstance } from "fastify";
import type { EdgeWorkerConfig } from "miko-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import type { SharedApplicationServer } from "../src/SharedApplicationServer.js";

describe("EdgeWorker private Linear app webhook routing", () => {
	let worker: EdgeWorker;
	let app: FastifyInstance;
	let home: string;
	let config: EdgeWorkerConfig;

	beforeEach(async () => {
		vi.stubEnv("LINEAR_DIRECT_WEBHOOKS", "true");
		vi.stubEnv("LINEAR_WEBHOOK_SECRET", "legacy-secret");
		home = await mkdtemp(join(tmpdir(), "miko-private-apps-"));
		config = {
			mikoHome: home,
			repositories: [],
			linearWorkspaces: {
				legacy: { linearToken: "legacy-token" },
				private: {
					linearToken: "private-token",
					linearOAuth: {
						clientId: "private-client",
						clientSecret: "private-client-secret",
						webhookSecret: "private-webhook-secret",
					},
				},
				missingSecret: {
					linearToken: "missing-secret-token",
					linearOAuth: {
						clientId: "other-client",
						clientSecret: "other-client-secret",
					},
				},
			},
		};
		worker = new EdgeWorker(config);
		const internals = worker as unknown as {
			initializeComponents(): Promise<void>;
			sharedApplicationServer: SharedApplicationServer;
		};
		await internals.initializeComponents();
		app = internals.sharedApplicationServer.getFastifyInstance();
	});

	afterEach(async () => {
		await app?.close();
		await rm(home, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	async function deliver(organizationId: string, secret: string) {
		const body = JSON.stringify({
			type: "Issue",
			action: "create",
			organizationId,
			data: { id: "ignored-issue" },
		});
		return app.inject({
			method: "POST",
			url: "/linear-webhook",
			payload: body,
			remoteAddress: "34.186.126.124",
			headers: {
				"content-type": "application/json",
				"linear-signature": createHmac("sha256", secret)
					.update(body)
					.digest("hex"),
			},
		});
	}

	it("serves a legacy app and a private app on the same route", async () => {
		expect((await deliver("legacy", "legacy-secret")).statusCode).toBe(200);
		expect(
			(await deliver("private", "private-webhook-secret")).statusCode,
		).toBe(200);
		expect((await deliver("private", "legacy-secret")).statusCode).toBe(401);
		expect((await deliver("legacy", "private-webhook-secret")).statusCode).toBe(
			401,
		);
	});

	it.each([
		"unknown",
		"missingSecret",
		"__proto__",
	])("does not fall back to the global secret for %s", async (workspace) => {
		expect((await deliver(workspace, "legacy-secret")).statusCode).toBe(401);
	});

	it("resolves secrets from the current configuration after reload", async () => {
		const newConfig = structuredClone(config);
		newConfig.linearWorkspaces!.private!.linearOAuth!.webhookSecret =
			"rotated-secret";
		(worker as unknown as { config: EdgeWorkerConfig }).config = newConfig;
		expect(
			(await deliver("private", "private-webhook-secret")).statusCode,
		).toBe(401);
		expect((await deliver("private", "rotated-secret")).statusCode).toBe(200);
	});
});
