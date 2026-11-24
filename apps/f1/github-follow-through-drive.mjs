/** Deterministic F1 drive of PR follow-through (merge conflicts and branch
 * freshness) through the actual EdgeWorker /github-webhook transport and
 * session delivery, with standard signed GitHub `pull_request` and `push`
 * payloads: direct signature mode and Hosted Bearer proxy mode, cold and hot
 * config. GitHub API and agent runner are fixtures; no provider delivery or
 * LLM execution.
 * Run after pnpm build: node apps/f1/github-follow-through-drive.mjs
 */
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EdgeWorker } from "cyrus-edge-worker";

const home = await mkdtemp(join(tmpdir(), "cyrus-follow-through-f1-"));
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
let mergeable = false;
let behindBy = 2;
const pr = () => ({
	number: 7,
	state: "open",
	draft: false,
	head: { sha: head, ref: "cyrus/follow-through-task", repo: { id: 42 } },
	base: { sha: baseSha, ref: "main", repo: { id: 42 } },
	mergeable,
});
const repo = {
	id: "f1-follow-through-repo",
	name: "Follow-through fixture",
	repositoryPath: home,
	workspaceBaseDir: home,
	githubUrl: "https://github.com/f1-test/follow-through-repo",
	baseBranch: "main",
	isActive: true,
};
const repository = {
	id: 42,
	full_name: "f1-test/follow-through-repo",
	owner: { login: "f1-test", type: "Organization" },
};
const received = [];
const githubAuth = [];
// Cold start: conflicts opted in, freshness off, before the worker exists.
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
async function configure(settings, atomic = false) {
	const config = { repositories: [repo], ...settings };
	const target = atomic ? `${configPath}.tmp` : configPath;
	await writeFile(target, JSON.stringify(config));
	if (atomic) await rename(target, configPath);
	const deadline = Date.now() + 5000;
	while (
		worker.config.mergeConflictTrigger !==
			(settings.mergeConflictTrigger === true) ||
		(worker.config.prBranchFreshness ?? "off") !==
			(settings.prBranchFreshness ?? "off")
	) {
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
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));
let app;
try {
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
				title: "Follow-through fixture",
				branchName,
			},
			{ path: home, isGitWorktree: false },
			"linear",
			[{ repositoryId: repo.id, branchName }],
		);
		// Both sessions track main as their base, as the old generic base
		// notice did: neither may get an unrequested base-moved prompt.
		session.workspace.resolvedBaseBranches = {
			[repo.id]: { branch: "main", source: "default" },
		};
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
				"https://api.github.com/repos/f1-test/follow-through-repo",
			)
		)
			throw new Error("Unexpected network request");
		githubAuth.push(options.headers.Authorization);
		const parsed = new URL(url);
		if (parsed.pathname.endsWith("/pulls/7")) return Response.json(pr());
		if (parsed.pathname.includes("/compare/")) {
			assert.equal(
				parsed.pathname.split("/compare/")[1],
				`${head}...${baseSha}`,
			);
			return Response.json({ ahead_by: behindBy });
		}
		if (parsed.pathname.endsWith("/pulls")) {
			const branch = parsed.searchParams.get("head")?.split(":")[1];
			const base = parsed.searchParams.get("base");
			return Response.json(
				branch === pr().head.ref && (!base || base === "main") ? [pr()] : [],
			);
		}
		return Response.json({ id: 42 });
	};
	const send = (event, body, { mode = "proxy", auth, admission } = {}) => {
		const raw = JSON.stringify(body);
		return originalFetch(
			`http://127.0.0.1:${app.server.address().port}/github-webhook`,
			{
				method: "POST",
				headers: {
					"content-type": "application/json",
					"x-github-event": event,
					"x-github-delivery": `f1-${event}-${Date.now()}`,
					"x-github-installation-token": "f1-installation-token",
					...(admission ? { "x-cyrus-follow-through": admission } : {}),
					...(mode === "proxy"
						? { authorization: `Bearer ${auth ?? "f1-runtime-secret"}` }
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
	const push = () => ({
		ref: "refs/heads/main",
		before: "c".repeat(40),
		after: baseSha,
		created: false,
		deleted: false,
		installation: { id: 9 },
		repository,
		sender: { id: 202, login: "octocat", type: "User" },
		compare: "https://github.com/f1-test/follow-through-repo/compare/x...y",
		commits: [{ message: "Upstream change" }],
	});
	const conflictsOnly = "conflicts=on; freshness=off";

	// 1. Hosted proxy, cold config: unauthorized, then no admission.
	assert.equal(
		(
			await send("pull_request", pullRequest(), {
				auth: "wrong",
				admission: conflictsOnly,
			})
		).status,
		401,
	);
	assert.equal(
		(await (await send("pull_request", pullRequest())).json()).outcome,
		"not_authorized",
	);
	// Conflict on a PR event: one conflict prompt, safe merge.
	assert.deepEqual(
		await (
			await send("pull_request", pullRequest(), { admission: conflictsOnly })
		).json(),
		{ followThroughProtocol: 1, outcome: "queued" },
	);
	await until(() => received.length === 1, "proxy conflict dispatch");
	assert.equal(received[0].sessionId, "responsible");
	assert.ok(received[0].prompt.startsWith("<merge_conflict_notification>"));
	assert.ok(received[0].prompt.includes("<strategy>merge</strategy>"));
	assert.ok(
		githubAuth.every((value) => value === "Bearer f1-installation-token"),
	);
	// Duplicate head/base: no second turn.
	await send("pull_request", pullRequest("reopened"), {
		admission: conflictsOnly,
	});
	await settle();
	assert.equal(received.length, 1);

	// 2. Freshness off: a healthy base push sends no base-moved prompt at all,
	// even though both running sessions track main.
	mergeable = true;
	baseSha = "d".repeat(40);
	assert.equal(
		(await (await send("push", push(), { admission: conflictsOnly })).json())
			.outcome,
		"queued",
	);
	await settle();
	assert.equal(received.length, 1, "off sends no freshness prompt");

	// 3. Hot config: freshness merge, admitted by Hosted.
	await configure({ mergeConflictTrigger: true, prBranchFreshness: "merge" });
	await send("push", push(), { admission: "conflicts=on; freshness=merge" });
	await until(() => received.length === 2, "freshness merge dispatch");
	assert.ok(received[1].prompt.startsWith("<branch_freshness_notification>"));
	assert.ok(received[1].prompt.includes("<strategy>merge</strategy>"));
	assert.ok(received[1].prompt.includes("<commits_behind>2</commits_behind>"));
	// Up to date: nothing.
	baseSha = "e".repeat(40);
	behindBy = 0;
	await send("push", push(), { admission: "conflicts=on; freshness=merge" });
	await settle();
	assert.equal(received.length, 2);

	// 4. Direct GitHub delivery (signature mode): local config only, local
	// credentials, Hosted headers ignored. Rebase + conflict: one conflict
	// prompt with the rebase strategy.
	await configure(
		{ mergeConflictTrigger: true, prBranchFreshness: "rebase" },
		true,
	);
	process.env.CYRUS_HOST_EXTERNAL = "true";
	process.env.GITHUB_WEBHOOK_SECRET = "f1-github-secret";
	githubAuth.length = 0;
	assert.equal(
		(await send("push", push(), { mode: "signature", auth: "wrong" })).status,
		401,
	);
	mergeable = false;
	behindBy = 3;
	assert.deepEqual(
		await (await send("push", push(), { mode: "signature" })).json(),
		{
			success: true,
		},
	);
	await until(() => received.length === 3, "signed conflict dispatch");
	assert.ok(received[2].prompt.startsWith("<merge_conflict_notification>"));
	assert.ok(received[2].prompt.includes("<strategy>rebase</strategy>"));
	assert.ok(
		received[2].prompt.includes(
			"--force-with-lease=refs/heads/<pr-branch>:<head_sha>",
		),
	);
	assert.ok(githubAuth.length > 0);
	assert.ok(githubAuth.every((value) => value === "Bearer f1-local-token"));
	// A previous freshness prompt does not consume a conflict attempt.
	baseSha = "f".repeat(40);
	await send("pull_request", pullRequest(), { mode: "signature" });
	await until(() => received.length === 4, "third conflict dispatch");
	baseSha = "1".repeat(40);
	await send("pull_request", pullRequest(), { mode: "signature" });
	await settle();
	assert.equal(received.length, 4, "limit of three conflicts per PR");

	// 5. Hot config: off, removal.
	process.env.CYRUS_HOST_EXTERNAL = "false";
	await configure({ mergeConflictTrigger: false, prBranchFreshness: "off" });
	assert.equal(
		(
			await (
				await send("pull_request", pullRequest(), {
					admission: "conflicts=on; freshness=merge",
				})
			).json()
		).outcome,
		"disabled",
	);
	await configure({});
	assert.equal(
		(
			await (
				await send("push", push(), {
					admission: "conflicts=on; freshness=rebase",
				})
			).json()
		).outcome,
		"disabled",
	);
	assert.equal(received.length, 4);
	assert.ok(received.every((entry) => entry.sessionId === "responsible"));
	console.log(
		"PASS: actual HTTP /github-webhook -> EdgeWorker -> responsible session stream for standard pull_request and push events. Proxy needs Hosted admission (unauthorized and unadmitted send nothing) and uses the forwarded token; direct signed delivery uses local config and credentials. Freshness off sends no base-moved prompt to running sessions; merge freshness prompts a behind PR, not an up-to-date one; with rebase, a conflict sends one conflict prompt using rebase. Duplicates and the per-PR cap hold. Cold opt-in, live changes, atomic replacement and removal work without restarting the worker. Runner/API are fixtures.",
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
