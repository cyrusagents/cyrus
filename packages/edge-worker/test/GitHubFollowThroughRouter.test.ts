import { createHmac } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	CyrusAgentSession,
	PullRequestBranchFreshness,
	RepositoryConfig,
} from "cyrus-core";
import {
	GitHubEventTransport,
	parseFollowThroughAdmission,
	parseGitHubFollowThroughEvent,
} from "cyrus-github-event-transport";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubFollowThroughRouter } from "../src/GitHubFollowThroughRouter.js";

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
	compare: "https://github.com/grain/app/compare/x...y",
	commits: [{ message: "Upstream change" }],
	...overrides,
});

describe("PR follow-through on standard GitHub events", () => {
	let home: string;
	let conflicts: boolean;
	let freshness: PullRequestBranchFreshness;
	let pulls: Record<number, any>;
	let behindBy: number;
	let sessions: CyrusAgentSession[];
	let repo: RepositoryConfig;
	let runner: ReturnType<typeof vi.fn>;
	let prepare: ReturnType<typeof vi.fn>;
	let checkError: ReturnType<typeof vi.fn>;
	let api: ReturnType<typeof vi.fn>;
	let router: GitHubFollowThroughRouter;
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
		conflicts = true;
		freshness = "off";
		behindBy = 3;
		home = await mkdtemp(join(tmpdir(), "follow-through-"));
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
			const read = (value: any) =>
				typeof value === "function" ? value() : value;
			if (one) return Response.json(read(pulls[Number(one[1])]));
			if (path.includes("/compare/"))
				return Response.json({ ahead_by: behindBy, status: "behind" });
			if (path.endsWith("/pulls")) {
				const headFilter = parsed.searchParams.get("head")?.split(":")[1];
				const baseFilter = parsed.searchParams.get("base");
				return Response.json(
					Object.values(pulls)
						.map(read)
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
		router = new GitHubFollowThroughRouter({
			home,
			conflictsEnabled: () => conflicts,
			freshness: () => freshness,
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
			admission?: string | null;
			handler?: boolean;
			token?: string;
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
						handleFollowThrough: (parsed, context) =>
							router.receive(parsed, context),
					}),
		});
		transport.on("event", legacy);
		transport.register();
		const raw = JSON.stringify(body);
		const authenticated = options.authenticated ?? true;
		const admission =
			options.admission === undefined
				? `conflicts=on; freshness=${freshness}`
				: options.admission;
		return app.inject({
			method: "POST",
			url: "/github-webhook",
			payload: raw,
			headers: {
				"content-type": "application/json",
				"x-github-event": event,
				"x-github-delivery": "delivery-1",
				"x-github-installation-token": options.token ?? "installation-token",
				...(admission ? { "x-cyrus-follow-through": admission } : {}),
				...(mode === "proxy"
					? {
							authorization: authenticated
								? "Bearer test-secret"
								: "Bearer wrong",
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
	const quiet = () => new Promise((resolve) => setTimeout(resolve, 40));
	const prompts = () => prepare.mock.calls.map((call) => call[2] as string);

	it("treats a missing mergeability value as unknown", async () => {
		conflicts = false;
		freshness = "merge";
		pulls[7] = pull(7, { mergeable: undefined });
		const event = parseGitHubFollowThroughEvent("push", pushEvent())!;
		expect(await router.check(event, repo, {})).toEqual({
			7: "mergeability_unknown",
		});
		expect(prepare).not.toHaveBeenCalled();
	});

	it("does not schedule a previously prepared rebase after the strategy changes", async () => {
		freshness = "rebase";
		prepare.mockImplementationOnce(async () => {
			freshness = "off";
			return runner;
		});
		const event = parseGitHubFollowThroughEvent("pull_request", prEvent())!;
		expect(await router.check(event, repo, {})).toEqual({ 7: "superseded" });
		expect(runner).not.toHaveBeenCalled();
	});

	it("continues freshness past three distinct safe base advances", async () => {
		conflicts = false;
		freshness = "merge";
		for (const nextBase of ["b", "c", "d", "e"].map((value) =>
			value.repeat(40),
		)) {
			pulls[7] = pull(7, {
				mergeable: true,
				base: { sha: nextBase, ref: "main", repo: { id: 42 } },
			});
			const event = parseGitHubFollowThroughEvent(
				"push",
				pushEvent({ after: nextBase }),
			)!;
			expect(await router.check(event, repo, {})).toEqual({ 7: "accepted" });
			await settled();
		}
		expect(runner).toHaveBeenCalledTimes(4);
	});

	it("does not let a stale runtime authorize a different Hosted strategy", async () => {
		freshness = "merge";
		const response = await deliver("push", pushEvent(), {
			admission: "conflicts=on; freshness=rebase",
		});
		expect(response.json().outcome).toBe("disabled");
		expect(prepare).not.toHaveBeenCalled();
	});

	describe("merge conflicts", () => {
		it.each([
			"proxy",
			"signature",
		] as const)("a pull_request conflict continues the owning session (%s)", async (mode) => {
			const response = await deliver("pull_request", prEvent(), { mode });
			expect(response.json()).toEqual({
				followThroughProtocol: 1,
				outcome: "queued",
			});
			await dispatched(1);
			expect(prepare.mock.calls[0]![0]).toBe(sessions[0]);
			const prompt = prompts()[0]!;
			expect(prompt.startsWith("<merge_conflict_notification>")).toBe(true);
			expect(prompt).toContain("<pull_request>7</pull_request>");
			expect(prompt).toContain(`<base_sha>${base}</base_sha>`);
			// Freshness off: a safe merge, no force push.
			expect(prompt).toContain("<strategy>merge</strategy>");
			expect(prompt).toContain("Do not rebase or force push");
			expect(prompt).not.toContain("cyrus/task");
			// Hosted's token when proxied; never a header token in signature mode.
			expect(api.mock.calls[0]![1].headers.Authorization).toBe(
				mode === "proxy"
					? "Bearer installation-token"
					: "Bearer local-app-token",
			);
			expect(legacy).not.toHaveBeenCalled();
		});

		it("uses the rebase strategy with a pinned force-with-lease", async () => {
			freshness = "rebase";
			await deliver("pull_request", prEvent(), {
				admission: "conflicts=on; freshness=rebase",
			});
			await dispatched(1);
			expect(prompts()[0]).toContain("<strategy>rebase</strategy>");
			expect(prompts()[0]).toContain(
				"--force-with-lease=refs/heads/<pr-branch>:<head_sha>",
			);
			expect(prompts()[0]).toContain("Never use an unconditional force push");
		});

		it.each([
			["unknown mergeability never counts", { mergeable: null }],
			["mergeable PRs are left alone", { mergeable: true }],
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
			[
				"malformed SHAs",
				{ head: { sha: "../../x", ref: "cyrus/task", repo: { id: 42 } } },
			],
		])("%s", async (_, change) => {
			Object.assign(pulls[7], change);
			await deliver("pull_request", prEvent());
			await vi.waitFor(() =>
				expect(
					api.mock.calls.some(([url]) => String(url).endsWith("/pulls/7")),
				).toBe(true),
			);
			await quiet();
			expect(prepare).not.toHaveBeenCalled();
			expect(checkError).not.toHaveBeenCalled();
		});

		it("unknown mergeability is re-read a bounded number of times", async () => {
			let reads = 0;
			pulls[7] = () => ({ ...pull(7), mergeable: ++reads < 3 ? null : false });
			await deliver("pull_request", prEvent());
			await dispatched(1);
			reads = 0;
			pulls[7] = () => ({
				...pull(7, {
					base: { sha: "d".repeat(40), ref: "main", repo: { id: 42 } },
				}),
				mergeable: (reads++, null),
			});
			await deliver("pull_request", prEvent());
			await vi.waitFor(() => expect(reads).toBe(4));
			await quiet();
			expect(runner).toHaveBeenCalledTimes(1);
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
			await quiet();
			expect(prepare).not.toHaveBeenCalled();
			sessions = [sessions[0]!];
			pulls[11] = pull(11, {
				base: { sha: base, ref: "release", repo: { id: 42 } },
			});
			await deliver("pull_request", prEvent());
			await quiet();
			expect(prepare).not.toHaveBeenCalled();
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
	});

	describe("branch freshness", () => {
		it("off sends no base-moved prompt, even with a running session", async () => {
			conflicts = false;
			pulls[7] = pull(7, { mergeable: true });
			const response = await deliver("push", pushEvent());
			expect(response.json()).toEqual({
				success: true,
				followThroughProtocol: 1,
				outcome: "disabled",
			});
			// The legacy event is still emitted for other listeners.
			expect(legacy).toHaveBeenCalledTimes(1);
			await quiet();
			expect(api).not.toHaveBeenCalled();
			expect(prepare).not.toHaveBeenCalled();
		});

		it.each([
			"merge",
			"rebase",
		] as const)("%s: a behind, mergeable PR gets one freshness prompt", async (strategy) => {
			freshness = strategy;
			conflicts = false;
			pulls[7] = pull(7, { mergeable: true });
			await deliver("push", pushEvent(), {
				admission: `conflicts=off; freshness=${strategy}`,
			});
			await dispatched(1);
			const prompt = prompts()[0]!;
			expect(prompt.startsWith("<branch_freshness_notification>")).toBe(true);
			expect(prompt).toContain(`<strategy>${strategy}</strategy>`);
			expect(prompt).toContain("<commits_behind>3</commits_behind>");
			expect(prompt).toContain(
				"Never merge the pull request, push to its base branch",
			);
			// The behind check is pinned to the exact head and base revisions.
			expect(
				api.mock.calls.some(([url]) =>
					String(url).endsWith(`/compare/${head}...${base}`),
				),
			).toBe(true);
		});

		it("an up-to-date PR gets nothing", async () => {
			freshness = "merge";
			pulls[7] = pull(7, { mergeable: true });
			behindBy = 0;
			await deliver("push", pushEvent());
			await vi.waitFor(() =>
				expect(
					api.mock.calls.some(([url]) => String(url).includes("/compare/")),
				).toBe(true),
			);
			await quiet();
			expect(prepare).not.toHaveBeenCalled();
		});

		it("never uses freshness to resolve a conflict or an unknown state", async () => {
			freshness = "merge";
			conflicts = false;
			for (const mergeable of [false, null]) {
				pulls[7] = pull(7, { mergeable });
				await deliver("push", pushEvent(), {
					admission: "conflicts=off; freshness=merge",
				});
				await quiet();
			}
			expect(prepare).not.toHaveBeenCalled();
			expect(
				api.mock.calls.some(([url]) => String(url).includes("/compare/")),
			).toBe(false);
		});

		it("with both on, a conflicted base push sends one conflict prompt using the chosen strategy", async () => {
			freshness = "rebase";
			await deliver("push", pushEvent(), {
				admission: "conflicts=on; freshness=rebase",
			});
			await deliver("pull_request", prEvent(), {
				admission: "conflicts=on; freshness=rebase",
			});
			await dispatched(1);
			await quiet();
			expect(runner).toHaveBeenCalledTimes(1);
			expect(prompts()[0]!.startsWith("<merge_conflict_notification>")).toBe(
				true,
			);
			expect(prompts()[0]).toContain("<strategy>rebase</strategy>");
		});

		it("pull_request events never send freshness prompts", async () => {
			freshness = "merge";
			conflicts = true;
			pulls[7] = pull(7, { mergeable: true });
			await deliver("pull_request", prEvent());
			await quiet();
			expect(prepare).not.toHaveBeenCalled();
			conflicts = false;
			expect((await deliver("pull_request", prEvent())).json().outcome).toBe(
				"disabled",
			);
		});

		it("a base push checks only owned branches into the pushed base", async () => {
			freshness = "merge";
			pulls[8] = pull(8, {
				head: { sha: head, ref: "other", repo: { id: 42 } },
				mergeable: true,
			});
			pulls[9] = pull(9, {
				head: { sha: head, ref: "not-ours", repo: { id: 42 } },
			});
			pulls[10] = pull(10, {
				head: { sha: head, ref: "other", repo: { id: 42 } },
				base: { sha: base, ref: "release", repo: { id: 42 } },
			});
			await deliver("push", pushEvent());
			await dispatched(1);
			await quiet();
			const lists = api.mock.calls
				.map(([url]) => new URL(url as string))
				.filter((url) => url.pathname.endsWith("/pulls"));
			for (const url of lists.filter((u) => u.searchParams.get("base")))
				expect(url.searchParams.get("base")).toBe("main");
			expect(
				api.mock.calls.some(([url]) => String(url).endsWith("/pulls/9")),
			).toBe(false);
			expect(
				api.mock.calls.some(([url]) => String(url).endsWith("/pulls/10")),
			).toBe(false);
		});
	});

	describe("admission", () => {
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

		it("a proxied delivery needs Hosted's admission for each feature", async () => {
			freshness = "merge";
			expect(
				(await deliver("pull_request", prEvent(), { admission: null })).json(),
			).toEqual({ followThroughProtocol: 1, outcome: "not_authorized" });
			// A push without admission keeps its old reply and triggers nothing.
			expect(
				(await deliver("push", pushEvent(), { admission: null })).json(),
			).toEqual({
				success: true,
			});
			expect(
				(
					await deliver("pull_request", prEvent(), {
						admission: "conflicts=yes",
					})
				).json().outcome,
			).toBe("not_authorized");
			expect(
				(
					await deliver("pull_request", prEvent(), {
						admission: "conflicts=off; freshness=merge",
					})
				).json().outcome,
			).toBe("disabled");
			await quiet();
			expect(api).not.toHaveBeenCalled();
		});

		it("Hosted admission cannot enable a feature the local config has off", async () => {
			conflicts = false;
			freshness = "off";
			for (const event of ["pull_request", "push"])
				await deliver(event, event === "push" ? pushEvent() : prEvent(), {
					admission: "conflicts=on; freshness=rebase",
				});
			await quiet();
			expect(api).not.toHaveBeenCalled();
		});

		it("direct delivery ignores Hosted headers and uses the local config", async () => {
			conflicts = false;
			const response = await deliver("pull_request", prEvent(), {
				mode: "signature",
				admission: "conflicts=on; freshness=merge",
			});
			expect(response.json().outcome).toBe("disabled");
		});

		it("runtimes without the handler keep ignoring pull_request", async () => {
			expect(
				(await deliver("pull_request", prEvent(), { handler: false })).json(),
			).toEqual({ success: true, ignored: true });
			expect(
				(await deliver("push", pushEvent(), { handler: false })).json(),
			).toEqual({
				success: true,
			});
		});
	});

	describe("dedupe and races", () => {
		it("redeliveries, push/PR races and new bases dispatch once per head and base, with a conflict recovery limit", async () => {
			freshness = "merge";
			await deliver("pull_request", prEvent());
			await deliver("push", pushEvent());
			await dispatched(1);
			await settled();
			await deliver("pull_request", prEvent());
			await quiet();
			expect(runner).toHaveBeenCalledTimes(1);
			for (const next of ["c", "d", "e", "f"]) {
				pulls[7] = pull(7, {
					base: { sha: next.repeat(40), ref: "main", repo: { id: 42 } },
					// One freshness prompt and at most three conflict prompts.
					mergeable: next === "d",
				});
				await deliver("push", pushEvent());
				await quiet();
				await settled();
			}
			expect(runner).toHaveBeenCalledTimes(4);
		});

		it("a newer event during a running check is checked afterwards, not dropped", async () => {
			let release!: () => void;
			let first = true;
			pulls[7] = () => pull(7);
			const original = api.getMockImplementation()!;
			api.mockImplementation(async (url: string, init: unknown) => {
				if (first && String(url).endsWith("/pulls/7")) {
					first = false;
					await new Promise<void>((resolve) => (release = resolve));
					return Response.json(pull(7, { mergeable: true }));
				}
				return original(url, init);
			});
			await deliver("pull_request", prEvent());
			await vi.waitFor(() => expect(first).toBe(false));
			// The newer revision arrives while the stale check is blocked.
			await deliver("pull_request", prEvent());
			release();
			await dispatched(1);
		});

		it("rechecks GitHub after preparing and does not dispatch a resolved conflict", async () => {
			prepare.mockImplementation(async () => {
				pulls[7] = pull(7, { mergeable: true });
				return runner;
			});
			await deliver("pull_request", prEvent());
			await vi.waitFor(() => expect(prepare).toHaveBeenCalled());
			await quiet();
			expect(runner).not.toHaveBeenCalled();
		});

		it("GitHub read failures are reported, not dispatched", async () => {
			api.mockResolvedValue(new Response(null, { status: 502 }));
			await deliver("pull_request", prEvent());
			await vi.waitFor(() => expect(checkError).toHaveBeenCalledTimes(1));
			expect(prepare).not.toHaveBeenCalled();
		});

		it("checks the repository identity with GitHub", async () => {
			api.mockImplementation(async () => Response.json({ id: 43 }));
			await deliver("pull_request", prEvent());
			await vi.waitFor(() => expect(api).toHaveBeenCalledTimes(1));
			await quiet();
			expect(prepare).not.toHaveBeenCalled();
		});
	});

	it("parses identifiers and admission strictly", () => {
		expect(parseGitHubFollowThroughEvent("pull_request", prEvent())).toEqual({
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
			["pull_request", prEvent({ action: "labeled" })],
			["push", pushEvent({ ref: "refs/tags/v1" })],
			["push", pushEvent({ deleted: true })],
			["push", pushEvent({ created: true })],
			["status", prEvent()],
		] as const)
			expect(parseGitHubFollowThroughEvent(event, body)).toBeNull();
		expect(
			parseFollowThroughAdmission("conflicts=on; freshness=rebase"),
		).toEqual({
			conflicts: true,
			freshness: "rebase",
		});
		for (const bad of [
			undefined,
			"",
			"conflicts=on",
			"conflicts=on; freshness=squash",
			["x"],
		])
			expect(parseFollowThroughAdmission(bad)).toBeNull();
	});
});
