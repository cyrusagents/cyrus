import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify from "fastify";
import { afterEach, expect, it } from "vitest";
import { AutomationAdapters } from "../src/automation/AutomationAdapters.js";
import { AutomationService } from "../src/automation/AutomationService.js";
import { AutomationStore } from "../src/automation/AutomationStore.js";
import { registerStatusBoard } from "../src/StatusBoard.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "automation-routes-"));
	cleanups.push(() => rm(directory, { force: true, recursive: true }));
	const adapter = new AutomationAdapters({
		repositories: () => [],
		workspaces: () => ({}),
		repoTags: () => [],
		startTask: async () => {},
		localState: () => undefined,
	});
	const service = new AutomationService(new AutomationStore(directory), {
		validate: async () => {},
		dispatch: async () => ({ status: "running" }),
		reconcile: async () => ({ status: "uncertain" }),
	});
	await service.start(false);
	cleanups.push(() => service.stop());
	const app = Fastify();
	registerStatusBoard(app, {
		getSessions: () => [],
		getEntries: () => [],
		getStatus: () => "idle",
		getRepositoryName: () => "repo",
		automations: { service, adapters: adapter },
	});
	cleanups.push(() => app.close());
	return { app, service };
}
const input = {
	name: "Scheduled task",
	instructions: "Fix it",
	repositoryId: "repo",
	enabled: true,
	timezone: "UTC",
	schedule: { kind: "daily", time: "09:00" },
	target: { kind: "direct_repository" },
};
const local = {
	remoteAddress: "127.0.0.1",
	headers: {
		host: "localhost:3600",
		origin: "http://localhost:3600",
		"content-type": "application/json",
	},
};

it("supports create, preview, revision conflicts, deduplicated execution and archive", async () => {
	const { app } = await fixture();
	const created = await app.inject({
		...local,
		method: "POST",
		url: "/board/api/automations",
		payload: input,
	});
	expect(created.statusCode).toBe(201);
	const definition = created.json();
	const preview = await app.inject({
		...local,
		method: "POST",
		url: "/board/api/automations/preview",
		payload: { schedule: input.schedule, timezone: input.timezone },
	});
	expect(preview.json().times).toHaveLength(5);
	const path = `/board/api/automations/${definition.id}`;
	const run = await app.inject({
		...local,
		method: "POST",
		url: `${path}/run`,
		payload: { requestId: "request-1" },
	});
	expect(run.statusCode).toBe(202);
	const duplicate = await app.inject({
		...local,
		method: "POST",
		url: `${path}/run`,
		payload: { requestId: "request-1" },
	});
	expect(duplicate.json().id).toBe(run.json().id);
	const paused = await app.inject({
		...local,
		method: "PATCH",
		url: path,
		payload: { revision: definition.revision, enabled: false },
	});
	expect(paused.json().enabled).toBe(false);
	const stale = await app.inject({
		...local,
		method: "PATCH",
		url: path,
		payload: { revision: definition.revision, input },
	});
	expect(stale.statusCode).toBe(409);
	const archived = await app.inject({
		...local,
		method: "DELETE",
		url: path,
		payload: { revision: paused.json().revision },
	});
	expect(archived.json().archived).toBe(true);
	const history = await app.inject({
		...local,
		method: "GET",
		url: `${path}/runs`,
	});
	expect(history.json()).toHaveLength(1);
});

it("requires local same-origin JSON mutations and rejects proxy access", async () => {
	const { app } = await fixture();
	for (const headers of [
		{ host: "localhost:3600", "content-type": "application/json" },
		{ ...local.headers, origin: "https://attacker.example" },
		{ ...local.headers, "x-forwarded-for": "127.0.0.1" },
	]) {
		const response = await app.inject({
			remoteAddress: "127.0.0.1",
			headers,
			method: "POST",
			url: "/board/api/automations",
			payload: input,
		});
		expect(response.statusCode).toBe(403);
	}
	const remote = await app.inject({
		...local,
		remoteAddress: "192.0.2.1",
		url: "/board/api/automations",
	});
	expect(remote.statusCode).toBe(403);
	const invalid = await app.inject({
		...local,
		method: "POST",
		url: "/board/api/automations",
		payload: {},
	});
	expect(invalid.statusCode).toBe(400);
});
