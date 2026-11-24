/** Deterministic F1 drive of merge conflict follow-up through the actual
 * EdgeWorker /github-webhook transport and session delivery, with standard
 * signed GitHub `pull_request` and `push` payloads: direct signature mode and
 * Hosted Bearer proxy mode, cold and hot config. GitHub API and agent runner
 * are fixtures; no provider delivery or LLM execution.
 * Run after pnpm build: node apps/f1/github-merge-conflict-drive.mjs
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeWorker } from "cyrus-edge-worker";

const home = await mkdtemp(join(tmpdir(), "cyrus-conflict-f1-"));
const originalFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(
	[
		"CYRUS_API_KEY",
		"CYRUS_HOST_EXTERNAL",
		"CYRUS_DISABLE_REMOTE_SESSION_STORE",
		"GITHUB_WEBHOOK_SECRET",
		"GITHUB_TOKEN",
	].map((key) => [key, process.env[key]]),
);
process.env.CYRUS_API_KEY = "f1-runtime-secret";
process.env.CYRUS_HOST_EXTERNAL = "false";
process.env.CYRUS_DISABLE_REMOTE_SESSION_STORE = "1";
process.env.GITHUB_TOKEN = "f1-local-token";
const head = "a".repeat(40);
let baseSha = "b".repeat(40);
const pr = () => ({
	number: 7,
	state: "open",
	draft: false,
	head: { sha: head, ref: "cyrus/conflict-task", repo: { id: 42 } },
	base: { sha: baseSha, ref: "main", repo: { id: 42 } },
	mergeable: false,
});
const repo = {
	id: "f1-conflict-repo",
	name: "Merge conflict fixture",
	repositoryPath: home,
	workspaceBaseDir: home,
	githubUrl: "https://github.com/f1-test/conflict-repo",
	baseBranch: "main",
	isActive: true,
};
const repository = {
	id: 42,
	full_name: "f1-test/conflict-repo",
	owner: { login: "f1-test", type: "Organization" },
};
const received = [];
const githubAuth = [];
// Cold start: opted in before the worker exists.
const worker = new EdgeWorker({
	platform: "cli",
	mergeConflictTrigger: true,
	repositories: [repo],
	cyrusHome: home,
	serverPort: 0,
	serverHost: "127.0.0.1",
});
const configPath = join(home, "config.json");
await writeFile(
	configPath,
	JSON.stringify({ repositories: [repo], mergeConflictTrigger: true }),
);
worker.setConfigPath(configPath);
async function flip(value, atomic = false) {
	const config = {
		repositories: [repo],
		...(value === undefined ? {} : { mergeConflictTrigger: value }),
	};
	const target = atomic ? `${configPath}.tmp` : configPath;
	await writeFile(target, JSON.stringify(config));
	if (atomic) await rename(target, configPath);
	const deadline = Date.now() + 5000;
	while (worker.config.mergeConflictTrigger !== (value === true)) {
		if (Date.now() > deadline) throw new Error("Live config update timed out");
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
}
async function until(check, label) {
	const deadline = Date.now() + 5000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}
let app;
let legacyPushes = 0;
try {
	// Count the ordinary base-branch push handling without changing it.
	const legacy = worker.handleGitHubPushWebhook.bind(worker);
	worker.handleGitHubPushWebhook = async (...args) => {
		legacyPushes++;
		return legacy(...args);
	};
	worker.registerGitHubEventTransport();
	worker.startConfigWatcher();
	await new Promise((resolve) =>
		worker.configManager.configWatcher.once("ready", resolve),
	);
	app = worker.getSharedApplicationServer().getFastifyInstance();
	await app.listen({ host: "127.0.0.1", port: 0 });
	for (const [id, branchName] of [
		["responsible", pr().head.ref],
		["unrelated", "another-branch"],
	]) {
		const session = worker.agentSessionManager.createCyrusAgentSession(
			id,
			`issue-${id}`,
			{
				id: `issue-${id}`,
				identifier: `F1-${id}`,
				title: "Merge conflict fixture",
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
		if (
			!String(url).startsWith(
				"https://api.github.com/repos/f1-test/conflict-repo",
			)
		)
			throw new Error("Unexpected network request");
		githubAuth.push(options.headers.Authorization);
		const parsed = new URL(url);
		if (parsed.pathname.endsWith("/pulls/7")) return Response.json(pr());
		if (parsed.pathname.endsWith("/pulls")) {
			const branch = parsed.searchParams.get("head")?.split(":")[1];
			const base = parsed.searchParams.get("base");
			return Response.json(
				branch === pr().head.ref && (!base || base === "main") ? [pr()] : [],
			);
		}
		return Response.json({ id: 42 });
	};
	const send = (event, body, { mode = "proxy", auth, conflictOnly } = {}) => {
		const raw = JSON.stringify(body);
		return originalFetch(
			`http://127.0.0.1:${app.server.address().port}/github-webhook`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-github-event": event,
					"x-github-delivery": `f1-${event}-${Date.now()}`,
					...(conflictOnly ? { "x-cyrus-merge-conflict-only": "1" } : {}),
					...(mode === "proxy"
						? {
								authorization: `Bearer ${auth ?? "f1-runtime-secret"}`,
								"x-github-installation-token": "f1-installation-token",
							}
						: {
								"x-hub-signature-256": `sha256=${createHmac(
									"sha256",
									auth ?? "f1-github-secret",
								)
									.update(raw)
									.digest("hex")}`,
							}),
				},
				body: raw,
			},
		);
	};
	const pullRequest = (action = "synchronize") => ({
		action,
		installation: { id: 9 },
		repository,
		sender: { id: 202, login: "octocat", type: "User" },
		pull_request: {
			number: 7,
			draft: false,
			head: { ref: pr().head.ref, sha: head },
		},
	});
	const push = {
		ref: "refs/heads/main",
		before: "c".repeat(40),
		after: baseSha,
		created: false,
		deleted: false,
		installation: { id: 9 },
		repository,
		sender: { id: 202, login: "octocat", type: "User" },
		commits: [],
	};

	// Hosted proxy, cold config: unauthorized never reads the payload.
	assert.equal(
		(await send("pull_request", pullRequest(), { auth: "wrong" })).status,
		401,
	);
	assert.deepEqual(await (await send("pull_request", pullRequest())).json(), {
		mergeConflictProtocol: 1,
		outcome: "queued",
	});
	await until(() => received.length === 1, "proxy pull_request dispatch");
	assert.equal(received[0].sessionId, "responsible");
	assert.ok(received[0].prompt.startsWith("<merge_conflict_notification>"));
	assert.ok(received[0].prompt.includes(`<base_sha>${baseSha}</base_sha>`));
	assert.ok(
		githubAuth.every((value) => value === "Bearer f1-installation-token"),
	);
	// Duplicate head/base: no second turn.
	await send("pull_request", pullRequest("reopened"));
	await new Promise((resolve) => setTimeout(resolve, 100));
	assert.equal(received.length, 1);

	// Hosted conflict-only push: no ordinary push handling, new base dispatches.
	baseSha = "d".repeat(40);
	assert.deepEqual(
		await (await send("push", push, { conflictOnly: true })).json(),
		{ mergeConflictProtocol: 1, outcome: "queued" },
	);
	await until(() => received.length === 2, "conflict-only push dispatch");
	assert.equal(legacyPushes, 0);

	// Direct GitHub delivery (signature mode, switched at request time).
	process.env.CYRUS_HOST_EXTERNAL = "true";
	process.env.GITHUB_WEBHOOK_SECRET = "f1-github-secret";
	githubAuth.length = 0;
	assert.equal(
		(
			await send("pull_request", pullRequest(), {
				mode: "signature",
				auth: "wrong",
			})
		).status,
		401,
	);
	baseSha = "e".repeat(40);
	assert.deepEqual(
		await (
			await send("pull_request", pullRequest(), { mode: "signature" })
		).json(),
		{ mergeConflictProtocol: 1, outcome: "queued" },
	);
	await until(() => received.length === 3, "signed pull_request dispatch");
	// Local credentials, no forwarded token.
	assert.ok(githubAuth.length > 0);
	assert.ok(githubAuth.every((value) => value === "Bearer f1-local-token"));
	// The Hosted-only selector is ignored here: an ordinary push, per-PR cap reached.
	baseSha = "f".repeat(40);
	assert.deepEqual(
		await (
			await send("push", push, { mode: "signature", conflictOnly: true })
		).json(),
		{ success: true },
	);
	await until(() => legacyPushes === 1, "ordinary push handling");
	await new Promise((resolve) => setTimeout(resolve, 150));
	assert.equal(received.length, 3, "attempt limit of 3 per PR");

	// Hot config: off, atomic replace, removal.
	process.env.CYRUS_HOST_EXTERNAL = "false";
	await flip(false, true);
	assert.equal(
		(await (await send("pull_request", pullRequest())).json()).outcome,
		"disabled",
	);
	await flip(true);
	assert.equal(
		(await (await send("pull_request", pullRequest())).json()).outcome,
		"queued",
	);
	await flip(undefined);
	assert.equal(
		(await (await send("pull_request", pullRequest())).json()).outcome,
		"disabled",
	);
	assert.equal(received.length, 3);
	assert.ok(received.every((entry) => entry.sessionId === "responsible"));
	console.log(
		"PASS: actual HTTP /github-webhook -> EdgeWorker -> responsible session stream for standard pull_request and push events, Hosted proxy (forwarded token, conflict-only push without the ordinary push handling) and direct signed delivery (local credentials, selector ignored). Unauthorized and duplicate deliveries do not dispatch; the per-PR cap holds. Cold opt-in, live off, atomic replacement and removal work without restarting the worker. Runner/API are fixtures.",
	);
} finally {
	globalThis.fetch = originalFetch;
	await worker.configManager.stop();
	if (app) await app.close();
	await rm(home, { recursive: true, force: true });
	for (const [key, value] of Object.entries(savedEnv)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}
