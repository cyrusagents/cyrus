import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import {
	GitHubEventTransport,
	parseGitHubMergeConflictEvent,
} from "cyrus-github-event-transport";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubMergeConflictRouter } from "../src/GitHubMergeConflictRouter.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const repository = {
	id: 42,
	full_name: "grain/app",
	owner: { login: "grain", type: "Organization" },
};
const prEvent = (overrides: Record<string, unknown> = {}) => ({
	action: "synchronize",
	installation: { id: 9 },
	repository,
	sender: { id: 202, login: "octocat", type: "User" },
	pull_request: {
		number: 7,
		draft: false,
		head: { ref: "cyrus/task", sha: head },
	},
	...overrides,
});
const pushEvent = (overrides: Record<string, unknown> = {}) => ({
	ref: "refs/heads/main",
	before: "c".repeat(40),
	after: base,
	created: false,
	deleted: false,
	installation: { id: 9 },
	repository,
	sender: { id: 202, login: "octocat", type: "User" },
	commits: [],
	...overrides,
});

describe("merge conflicts on standard GitHub events", () => {
	let home: string;
	let enabled: boolean;
	let pulls: Record<number, any>;
	let sessions: CyrusAgentSession[];
	let repo: RepositoryConfig;
	let runner: ReturnType<typeof vi.fn>;
	let prepare: ReturnType<typeof vi.fn>;
	let checkError: ReturnType<typeof vi.fn>;
	let api: ReturnType<typeof vi.fn>;
	let router: GitHubMergeConflictRouter;
	let legacy: ReturnType<typeof vi.fn>;
	const servers: ReturnType<typeof Fastify>[] = [];
	const pull = (number: number, overrides: Record<string, unknown> = {}) => ({
		number,
		state: "open",
		draft: false,
		head: { sha: head, ref: "cyrus/task", repo: { id: 42 } },
		base: { sha: base, ref: "main", repo: { id: 42 } },
		mergeable: false,
		mergeable_state: "dirty",
		...overrides,
	});
	beforeEach(async () => {
		enabled = true;
		home = await mkdtemp(join(tmpdir(), "conflict-routing-"));
		pulls = { 7: pull(7) };
		repo = {
			id: "repo",
			githubUrl: "https://github.com/grain/app",
			isActive: true,
		} as RepositoryConfig;
		sessions = [
			{
				id: "responsible-session",
				repositories: [{ repositoryId: "repo", branchName: "cyrus/task" }],
			},
			{
				id: "unrelated-session",
				repositories: [{ repositoryId: "repo", branchName: "other" }],
			},
		] as CyrusAgentSession[];
		runner = vi.fn().mockResolvedValue(undefined);
		prepare = vi.fn().mockResolvedValue(runner);
		checkError = vi.fn();
		legacy = vi.fn();
		api = vi.fn(async (url: string) => {
			const parsed = new URL(url);
			const path = parsed.pathname;
			const one = path.match(/\/pulls\/(\d+)$/);
			if (one) {
				const value = pulls[Number(one[1])];
				return Response.json(typeof value === "function" ? value() : value);
			}
			if (path.endsWith("/pulls")) {
				const headFilter = parsed.searchParams.get("head")?.split(":")[1];
				const baseFilter = parsed.searchParams.get("base");
				return Response.json(
					Object.values(pulls)
						.map((value) => (typeof value === "function" ? value() : value))
						.filter(
							(pr) =>
								pr.state === "open" &&
								pr.head.ref === headFilter &&
								(!baseFilter || pr.base.ref === baseFilter),
						),
				);
			}
			return Response.json({ id: 42 });
		});
		router = new GitHubMergeConflictRouter({
			home,
			enabled: () => enabled,
			repositories: () => [repo],
			sessions: () => sessions,
			token: async (_repo, forwarded) => forwarded ?? "local-app-token",
			prepare,
			onDispatchError: vi.fn(),
			onCheckError: checkError,
			fetch: api as typeof fetch,
			sleep: async () => {},
		});
	});
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => s.close()));
		await settled();
		await rm(home, { recursive: true, force: true });
	});
	async function settled() {
		const root = join(home, "merge-conflict-dispatch");
		await vi.waitFor(
			async () => {
				for (const dir of await readdir(root).catch(() => [] as string[]))
					for (const file of await readdir(join(root, dir)))
						if (file.endsWith(".json"))
							expect(["completed", "failed"]).toContain(
								JSON.parse(await readFile(join(root, dir, file), "utf8")).state,
							);
			},
			{ timeout: 5000 },
		);
	}
	async function deliver(
		event: string,
		body: unknown,
		options: {
			mode?: "proxy" | "signature";
			authenticated?: boolean;
			conflictOnly?: boolean;
			handler?: boolean;
		} = {},
	) {
		const mode = options.mode ?? "proxy";
		const app = Fastify();
		servers.push(app);
		app.addHook("preValidation", async (request) => {
			(request as any).rawBody = JSON.stringify(request.body);
		});
		const transport = new GitHubEventTransport({
			fastifyServer: app,
			verificationMode: mode,
			secret: "test-secret",
			...(options.handler === false
				? {}
				: {
						handleMergeConflict: (parsed, context) =>
							router.receive(parsed, context.installationToken),
					}),
		});
		transport.on("event", legacy);
		transport.register();
		const raw = JSON.stringify(body);
		const authenticated = options.authenticated ?? true;
		return app.inject({
			method: "POST",
			url: "/github-webhook",
			payload: raw,
			headers: {
				"content-type": "application/json",
				"x-github-event": event,
				"x-github-delivery": "delivery-1",
				...(options.conflictOnly ? { "x-cyrus-merge-conflict-only": "1" } : {}),
				...(mode === "proxy"
					? {
							authorization: authenticated
								? "Bearer test-secret"
								: "Bearer wrong",
							"x-github-installation-token": "installation-token",
						}
					: {
							"x-hub-signature-256": `sha256=${createHmac(
								"sha256",
								authenticated ? "test-secret" : "wrong",
							)
								.update(raw)
								.digest("hex")}`,
						}),
			},
		});
	}
	const dispatched = async (count: number) =>
		vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(count));

	it.each([
		"proxy",
		"signature",
	] as const)("a signed or Hosted pull_request continues the owning session (%s)", async (mode) => {
		const response = await deliver("pull_request", prEvent(), { mode });
		expect(response.json()).toEqual({
			mergeConflictProtocol: 1,
			outcome: "queued",
		});
		await dispatched(1);
		expect(prepare.mock.calls[0]![0]).toBe(sessions[0]);
		const prompt = prepare.mock.calls[0]![2] as string;
		expect(prompt).toContain("<pull_request>7</pull_request>");
		expect(prompt).toContain(`<base_sha>${base}</base_sha>`);
		expect(prompt).toContain("Never force push");
		expect(prompt).not.toContain("cyrus/task");
		// Hosted's installation token in proxy mode; local credentials otherwise.
		expect(api.mock.calls[0]![1].headers.Authorization).toBe(
			mode === "proxy" ? "Bearer installation-token" : "Bearer local-app-token",
		);
		// pull_request has no other handling.
		expect(legacy).not.toHaveBeenCalled();
	});

	it("rejects unauthenticated deliveries before reading the payload", async () => {
		expect(
			(await deliver("pull_request", prEvent(), { authenticated: false }))
				.statusCode,
		).toBe(401);
		expect(
			(
				await deliver("pull_request", prEvent(), {
					mode: "signature",
					authenticated: false,
				})
			).statusCode,
		).toBe(401);
		expect(api).not.toHaveBeenCalled();
	});

	it("a base push checks only owned branches and keeps the ordinary push handling", async () => {
		pulls[8] = pull(8, {
			head: { sha: head, ref: "other", repo: { id: 42 } },
			mergeable: true,
		});
		pulls[9] = pull(9, {
			head: { sha: head, ref: "not-ours", repo: { id: 42 } },
		});
		const response = await deliver("push", pushEvent());
		// Ordinary push response and legacy event are unchanged.
		expect(response.json()).toEqual({ success: true });
		expect(legacy).toHaveBeenCalledTimes(1);
		await dispatched(1);
		const lists = api.mock.calls
			.map(([url]) => new URL(url as string))
			.filter((url) => url.pathname.endsWith("/pulls"));
		expect(lists.map((url) => url.searchParams.get("head")).sort()).toEqual(
			["grain:cyrus/task", "grain:cyrus/task", "grain:other"].sort(),
		);
		// A conflicted PR no session owns is never read.
		expect(
			api.mock.calls.some(([url]) => String(url).endsWith("/pulls/9")),
		).toBe(false);
	});

	it("a Hosted conflict-only push skips the ordinary push handling", async () => {
		const response = await deliver("push", pushEvent(), { conflictOnly: true });
		expect(response.json()).toEqual({
			mergeConflictProtocol: 1,
			outcome: "queued",
		});
		expect(legacy).not.toHaveBeenCalled();
		await dispatched(1);
	});

	it("the conflict-only selector is ignored outside authenticated proxy delivery", async () => {
		const response = await deliver("push", pushEvent(), {
			mode: "signature",
			conflictOnly: true,
		});
		// Direct GitHub delivery: treated as an ordinary push.
		expect(response.json()).toEqual({ success: true });
		expect(legacy).toHaveBeenCalledTimes(1);
	});

	it("runtimes without the handler keep ignoring pull_request and refuse conflict-only pushes", async () => {
		expect(
			(await deliver("pull_request", prEvent(), { handler: false })).json(),
		).toEqual({
			success: true,
			ignored: true,
		});
		expect(
			(
				await deliver("push", pushEvent(), {
					handler: false,
					conflictOnly: true,
				})
			).statusCode,
		).toBe(503);
		expect(legacy).not.toHaveBeenCalled();
	});

	it.each([
		["unknown mergeability never counts", { mergeable: null }],
		["mergeable PRs are left alone", { mergeable: true }],
		[
			"blocked-looking but mergeable",
			{ mergeable: true, mergeable_state: "blocked" },
		],
		["closed PRs", { state: "closed" }],
		["draft PRs", { draft: true }],
		[
			"fork heads",
			{ head: { sha: head, ref: "cyrus/task", repo: { id: 99 } } },
		],
		[
			"deleted fork heads",
			{ head: { sha: head, ref: "cyrus/task", repo: null } },
		],
	])("%s", async (_, change) => {
		Object.assign(pulls[7], change);
		await deliver("pull_request", prEvent());
		await vi.waitFor(() =>
			expect(
				api.mock.calls.some(([url]) => String(url).endsWith("/pulls/7")),
			).toBe(true),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(prepare).not.toHaveBeenCalled();
		expect(checkError).not.toHaveBeenCalled();
	});

	it("unknown mergeability is re-read a bounded number of times", async () => {
		let reads = 0;
		pulls[7] = () => ({ ...pull(7), mergeable: ++reads < 3 ? null : false });
		await deliver("pull_request", prEvent());
		await dispatched(1);
		expect(reads).toBeGreaterThanOrEqual(3);
		reads = 0;
		pulls[7] = () => ({
			...pull(7, {
				head: { sha: "d".repeat(40), ref: "cyrus/task", repo: { id: 42 } },
			}),
			mergeable: (reads++, null),
		});
		await deliver("pull_request", prEvent());
		await vi.waitFor(() => expect(reads).toBe(4));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it("no network work for disabled, unowned or unconfigured events", async () => {
		enabled = false;
		expect((await deliver("pull_request", prEvent())).json().outcome).toBe(
			"disabled",
		);
		enabled = true;
		const unowned = prEvent({
			pull_request: {
				number: 7,
				draft: false,
				head: { ref: "someone-else", sha: head },
			},
		});
		expect((await deliver("pull_request", unowned)).json().outcome).toBe(
			"not_owned",
		);
		sessions = [];
		expect((await deliver("pull_request", prEvent())).json().outcome).toBe(
			"session_not_found",
		);
		repo.isActive = false;
		expect((await deliver("pull_request", prEvent())).json().outcome).toBe(
			"repository_not_unique",
		);
		for (const ignored of [
			prEvent({ action: "labeled" }),
			prEvent({ action: "edited", changes: { title: { from: "x" } } }),
			prEvent({
				pull_request: { number: 7, draft: true, head: { ref: "cyrus/task" } },
			}),
		])
			expect((await deliver("pull_request", ignored)).json().outcome).toBe(
				"ignored",
			);
		expect(api).not.toHaveBeenCalled();
	});

	it("a retarget qualifies", async () => {
		const retarget = prEvent({
			action: "edited",
			changes: { base: { ref: { from: "dev" } } },
		});
		expect((await deliver("pull_request", retarget)).json().outcome).toBe(
			"queued",
		);
		await dispatched(1);
	});

	it("never guesses between sessions or same-branch PRs", async () => {
		sessions = [
			{
				id: "a",
				repositories: [{ repositoryId: "repo", branchName: "cyrus/task" }],
			},
			{
				id: "b",
				repositories: [{ repositoryId: "repo", branchName: "cyrus/task" }],
			},
		] as CyrusAgentSession[];
		await deliver("pull_request", prEvent());
		await vi.waitFor(() => expect(api).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(prepare).not.toHaveBeenCalled();
		sessions = [sessions[0]!];
		// A second open PR from the same branch, to another base.
		pulls[11] = pull(11, {
			base: { sha: base, ref: "release", repo: { id: 42 } },
		});
		await deliver("pull_request", prEvent());
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(prepare).not.toHaveBeenCalled();
	});

	it("checks the repository identity with GitHub", async () => {
		api.mockImplementation(async () => Response.json({ id: 43 }));
		await deliver("pull_request", prEvent());
		await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(prepare).not.toHaveBeenCalled();
	});

	it("redeliveries, push/PR races and new bases dispatch once per head and base, within a per-PR limit", async () => {
		await deliver("pull_request", prEvent());
		await deliver("push", pushEvent());
		await dispatched(1);
		await settled();
		await deliver("pull_request", prEvent());
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(runner).toHaveBeenCalledTimes(1);
		for (const next of ["c", "d", "e"]) {
			pulls[7] = pull(7, {
				base: { sha: next.repeat(40), ref: "main", repo: { id: 42 } },
			});
			await deliver("push", pushEvent());
			await new Promise((resolve) => setTimeout(resolve, 30));
			await settled();
		}
		expect(runner).toHaveBeenCalledTimes(3);
	});

	it("rechecks GitHub after preparing and does not dispatch a resolved conflict", async () => {
		prepare.mockImplementation(async () => {
			pulls[7] = pull(7, { mergeable: true });
			return runner;
		});
		await deliver("pull_request", prEvent());
		await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(runner).not.toHaveBeenCalled();
	});

	it("GitHub read failures are reported, not dispatched", async () => {
		api.mockResolvedValue(new Response(null, { status: 502 }));
		await deliver("pull_request", prEvent());
		await vi.waitFor(() => expect(checkError).toHaveBeenCalledTimes(1));
		expect(prepare).not.toHaveBeenCalled();
	});

	it("parses identifiers only and rejects unsafe repository paths", () => {
		expect(parseGitHubMergeConflictEvent("pull_request", prEvent())).toEqual({
			kind: "pull_request",
			action: "synchronize",
			number: 7,
			headRef: "cyrus/task",
			installationId: 9,
			repository: { id: 42, fullName: "grain/app" },
		});
		for (const [event, body] of [
			[
				"pull_request",
				prEvent({ repository: { ...repository, full_name: "../x" } }),
			],
			["push", pushEvent({ ref: "refs/tags/v1" })],
			["push", pushEvent({ deleted: true })],
			["push", pushEvent({ created: true })],
			["status", prEvent()],
		] as const)
			expect(parseGitHubMergeConflictEvent(event, body)).toBeNull();
	});
});
