/** Deterministic F1 drive of actual EdgeWorker registration/session delivery.
 * GitHub API and agent runner are fixtures; no provider delivery or LLM execution.
 * Run after pnpm build: node apps/f1/github-ci-routing-drive.mjs
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeWorker } from "cyrus-edge-worker";

const home = await mkdtemp(join(tmpdir(), "cyrus-ci-f1-"));
const originalFetch = globalThis.fetch;
const saved = {
	key: process.env.CYRUS_API_KEY,
	external: process.env.CYRUS_HOST_EXTERNAL,
	disabled: process.env.CYRUS_DISABLE_REMOTE_SESSION_STORE,
};
process.env.CYRUS_API_KEY = "f1-runtime-secret";
process.env.CYRUS_HOST_EXTERNAL = "false";
process.env.CYRUS_DISABLE_REMOTE_SESSION_STORE = "1";
const sha = "a".repeat(40);
const pr = {
	number: 7,
	state: "open",
	head: { sha, ref: "cyrus/ci-task", repo: { id: 42 } },
	base: { repo: { id: 42 } },
	merge_commit_sha: null,
};
const repo = {
	id: "f1-ci-repo",
	name: "CI fixture",
	repositoryPath: home,
	workspaceBaseDir: home,
	githubUrl: "https://github.com/f1-test/ci-repo",
	baseBranch: "main",
	isActive: true,
};
const context = "ci/semaphoreci/push: Tests";
const received = [];
const worker = new EdgeWorker({
	platform: "cli",
	ciFailureTrigger: false,
	repositories: [repo],
	cyrusHome: home,
	serverPort: 0,
	serverHost: "127.0.0.1",
});
const configPath = join(home, "config.json");
await writeFile(configPath, JSON.stringify({ repositories: [repo] }));
worker.setConfigPath(configPath);
async function flip(value, atomic = false) {
	const config = {
		repositories: [repo],
		...(value === undefined ? {} : { ciFailureTrigger: value }),
	};
	const target = atomic ? `${configPath}.tmp` : configPath;
	await writeFile(target, JSON.stringify(config));
	if (atomic) await rename(target, configPath);
	const deadline = Date.now() + 5000;
	while (worker.config.ciFailureTrigger !== (value === true)) {
		if (Date.now() > deadline) throw new Error("Live config update timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
let app;
try {
	worker.registerGitHubEventTransport();
	// Use the same watcher registration as EdgeWorker.start(), without unrelated
	// startup integrations. The worker, transport and session runner stay alive.
	worker.startConfigWatcher();
	await new Promise((resolve) =>
		worker.configManager.configWatcher.once("ready", resolve),
	);
	app = worker.getSharedApplicationServer().getFastifyInstance();
	await app.listen({ host: "127.0.0.1", port: 0 });
	for (const [id, branchName] of [
		["responsible", pr.head.ref],
		["unrelated", "another-branch"],
	]) {
		const session = worker.agentSessionManager.createCyrusAgentSession(
			id,
			`issue-${id}`,
			{
				id: `issue-${id}`,
				identifier: `F1-${id}`,
				title: "CI fixture",
				branchName,
			},
			{ path: home, isGitWorktree: false },
			"linear",
			[{ repositoryId: repo.id, branchName }],
		);
		const runner = new EventEmitter();
		runner.supportsStreamingInput = true;
		runner.isRunning = () => true;
		runner.addStreamMessage = (prompt) =>
			received.push({ sessionId: session.id, prompt });
		runner.stop = () => {};
		worker.agentSessionManager.addAgentRunner(id, runner);
	}
	globalThis.fetch = async (url, options) => {
		if (!String(url).startsWith("https://api.github.com/repos/f1-test/ci-repo"))
			throw new Error("Unexpected network request");
		assert.equal(options.headers.Authorization, "Bearer f1-installation-token");
		const path = new URL(url).pathname;
		if (path.endsWith("/pulls")) return Response.json([pr]);
		if (path.endsWith("/pulls/7")) return Response.json(pr);
		if (path.endsWith("/statuses"))
			return Response.json([{ id: 10, context, state: "failure" }]);
		return Response.json({ id: 42 });
	};
	const payload = {
		id: 10,
		sha,
		context,
		state: "failure",
		installation: { id: 9 },
		repository: { id: 42, full_name: "f1-test/ci-repo" },
	};
	const send = (auth, body = payload) =>
		originalFetch(
			`http://127.0.0.1:${app.server.address().port}/github-webhook`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: `Bearer ${auth}`,
					"x-github-installation-token": "f1-installation-token",
					"x-github-event": "status",
					"x-github-delivery": "f1-ci-delivery",
				},
				body: JSON.stringify(body),
			},
		);
	assert.equal((await send("wrong")).status, 401);
	assert.equal(received.length, 0);
	assert.equal(
		(await (await send("f1-runtime-secret")).json()).outcome,
		"disabled",
	);
	assert.equal(received.length, 0);
	await flip(true);
	assert.deepEqual(await (await send("f1-runtime-secret")).json(), {
		ciProtocol: 1,
		outcome: "accepted",
		sessionId: "responsible",
	});
	assert.equal(received.length, 1);
	assert.equal(received[0].sessionId, "responsible");
	assert.ok(received[0].prompt.includes(`<name>${context}</name>`));
	assert.ok(received[0].prompt.startsWith("<ci_failure_notification>"));
	assert.ok(received[0].prompt.includes(sha));
	await new Promise((resolve) => setTimeout(resolve, 30));
	assert.equal(
		(await (await send("f1-runtime-secret")).json()).outcome,
		"duplicate_revision",
	);
	assert.equal(
		(
			await (
				await send("f1-runtime-secret", { ...payload, sha: "c".repeat(40) })
			).json()
		).outcome,
		"no_current_pr",
	);
	assert.equal(received.length, 1);
	await flip(false, true);
	assert.equal(
		(await (await send("f1-runtime-secret")).json()).outcome,
		"disabled",
	);
	await flip(true);
	await flip(undefined);
	assert.equal(
		(await (await send("f1-runtime-secret")).json()).outcome,
		"disabled",
	);
	assert.equal(received.length, 1);
	console.log(
		"PASS: actual HTTP -> EdgeWorker -> responsible session stream; unauthorized/stale/duplicate deliveries do not dispatch. Live file edits, atomic replacement and removing opt-in work without restarting the worker. Runner/API are fixtures.",
	);
} finally {
	globalThis.fetch = originalFetch;
	await worker.configManager.stop();
	if (app) await app.close();
	await rm(home, { recursive: true, force: true });
	for (const [key, value] of Object.entries({
		CYRUS_API_KEY: saved.key,
		CYRUS_HOST_EXTERNAL: saved.external,
		CYRUS_DISABLE_REMOTE_SESSION_STORE: saved.disabled,
	})) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
