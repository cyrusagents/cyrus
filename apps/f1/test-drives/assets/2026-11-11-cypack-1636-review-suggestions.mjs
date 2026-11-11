import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { EdgeWorker } from "../../../../packages/edge-worker/dist/EdgeWorker.js";

const originalFetch = globalThis.fetch;
const prompts = [],
	acknowledgements = [],
	requests = [];
let worker, ready;
const started = new Promise((resolve) => {
	ready = resolve;
});
process.env.CYRUS_PORT = "3616";
process.env.CYRUS_REPO_PATH = fileURLToPath(
	new URL("../../../../", import.meta.url),
);
process.env.CYRUS_API_KEY = "f1-synthetic-review-key";
delete process.env.CYRUS_HOST_EXTERNAL;
delete process.env.GITHUB_WEBHOOK_SECRET;
delete process.env.CYRUS_DEFAULT_RUNNER;
delete process.env.CYRUS_TEAM_ID;
delete process.env.CYRUS_APP_URL;
let empty = false;
globalThis.fetch = async (url, options) => {
	const address = String(url);
	if (address.startsWith("http://localhost:3616/"))
		return originalFetch(url, options);
	requests.push(address);
	if (address === "https://api.github.com/graphql")
		return Response.json({
			data: {
				node: {
					__typename: "Bot",
					databaseId: 999,
					login: "reviewer",
					url: "https://github.com/apps/reviewer",
				},
			},
		});
	if (address === "https://api.github.com/apps/reviewer")
		return Response.json({ id: 42, slug: "reviewer" });
	if (address.includes("/reviews/") && address.includes("/comments?")) {
		const reviewId = Number(address.match(/reviews\/(\d+)/)[1]);
		return Response.json(
			empty
				? []
				: [1, 2].map((id) => ({
						id,
						pull_request_review_id: reviewId,
						user: { id: 999 },
						commit_id: "abc123",
						path: `file-${id}.ts`,
						line: 10,
						body: `Finding ${id}`,
						html_url: `https://github.com/f1-test/primary-repo/pull/42#discussion_r${id}`,
					})),
		);
	}
	if (address === "https://api.github.com/meta")
		return Response.json({ hooks: [] });
	throw new Error(`F1 blocked external fetch: ${address}`);
};
const start = EdgeWorker.prototype.start;
EdgeWorker.prototype.start = async function () {
	worker = this;
	this.config.prReviewTrigger = true;
	this.config.githubReviewAppPolicies = [
		{
			installationId: "55555",
			organization: "f1-test",
			appIds: [42],
			includeSuggestions: true,
		},
	];
	this.resolveGitHubToken = async () => "f1-synthetic-token";
	this.createGitHubWorkspace = async () => ({
		path: process.env.CYRUS_REPO_PATH,
		isGitWorktree: false,
	});
	this.gitHubCommentService.postIssueComment = async (data) => {
		acknowledgements.push(data.body);
	};
	this.postGitHubReply = async () => {};
	this.createRunnerForType = () =>
		Object.assign(new EventEmitter(), {
			start: async (prompt) => {
				prompts.push(prompt);
				return { sessionId: `f1-recording-${prompts.length}` };
			},
			isRunning: () => false,
			getMessages: () => [],
			getSessionId: () => null,
			stop: async () => {},
			supportsStreamingInput: false,
		});
	await start.call(this);
	ready();
};
await import("../../server.ts");
await started;
const event = (id) => ({
	action: "submitted",
	review: {
		id,
		node_id: `R${id}`,
		body: "Generic receipt",
		state: "commented",
		html_url: "https://github.com/f1-test/primary-repo/pull/42",
		user: { id: 999, node_id: "BOT_node", type: "Bot", login: "reviewer[bot]" },
		submitted_at: new Date().toISOString(),
		commit_id: "abc123",
	},
	pull_request: {
		id: 100,
		number: 42,
		title: "F1 review suggestions",
		body: "<!-- generated-by-cyrus -->",
		html_url: "https://github.com/f1-test/primary-repo/pull/42",
		user: { id: 111, type: "Bot", login: "cyrusagent[bot]" },
		head: { ref: "f1-suggestions", sha: "abc123" },
		base: { ref: "main", sha: "base" },
	},
	repository: {
		id: 101,
		name: "primary-repo",
		full_name: "f1-test/primary-repo",
		html_url: "https://github.com/f1-test/primary-repo",
		owner: { login: "f1-test", type: "Organization", id: 333 },
	},
	sender: { id: 999, login: "reviewer[bot]", type: "Bot" },
	installation: { id: 55555 },
});
async function deliver(payload, delivery) {
	const response = await originalFetch("http://localhost:3616/github-webhook", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: "Bearer f1-synthetic-review-key",
			"x-github-event": "pull_request_review",
			"x-github-delivery": delivery,
		},
		body: JSON.stringify(payload),
	});
	assert.equal(response.status, 200, await response.text());
	for (let i = 0; i < 100 && worker.activeWebhookCount; i++)
		await new Promise((r) => setTimeout(r, 20));
	assert.equal(worker.activeWebhookCount, 0);
}
try {
	await deliver(event(777), "accepted");
	assert.equal(prompts.length, 1);
	assert(prompts[0].includes("Finding 1") && prompts[0].includes("Finding 2"));
	assert(!prompts[0].includes("Generic receipt"));
	await deliver(event(777), "duplicate");
	assert.equal(prompts.length, 1);
	worker.config.githubReviewAppPolicies[0].includeSuggestions = false;
	await deliver(event(778), "disabled");
	assert.equal(prompts.length, 1);
	worker.config.githubReviewAppPolicies[0].includeSuggestions = true;
	worker.config.prReviewTrigger = false;
	await deliver(event(779), "master-off");
	assert.equal(prompts.length, 1);
	worker.config.prReviewTrigger = true;
	const other = event(780);
	other.repository.owner.login = "another-org";
	await deliver(other, "other-org");
	assert.equal(prompts.length, 1);
	empty = true;
	await deliver(event(781), "empty");
	assert.equal(prompts.length, 1);
	assert.equal(acknowledgements.length, 1);
	await writeFile(
		"/tmp/cypack1636-review-suggestions-result.json",
		JSON.stringify(
			{
				passed: true,
				scenarios: [
					"batch with two findings",
					"duplicate review",
					"suggestions off",
					"master trigger off",
					"org isolation",
					"empty findings",
				],
				prompts,
				acknowledgements,
				requests,
				limitations:
					"Synthetic GitHub provider and recording runner; no live GitHub delivery, model execution or repository changes.",
			},
			null,
			2,
		),
	);
	console.log("F1_SUGGESTIONS_PASS");
} finally {
	await worker.stop();
}
process.exit(0);
