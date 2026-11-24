import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import {
	GitHubEventTransport,
	parseGitHubMergeConflictHint,
} from "cyrus-github-event-transport";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitHubMergeConflictRouter } from "../src/GitHubMergeConflictRouter.js";

const head = "a".repeat(40);
const base = "b".repeat(40);
const hintBody = (overrides: Record<string, unknown> = {}) => ({
	conflictProtocol: 1,
	repository: { id: 42, fullName: "grain/app" },
	pullRequest: { number: 7, headSha: head, baseSha: base },
	...overrides,
});

describe("merge conflict hints reach only the existing PR session", () => {
	let home: string;
	let enabled: boolean;
	let pr: any;
	let sessions: CyrusAgentSession[];
	let repository: RepositoryConfig;
	let runner: ReturnType<typeof vi.fn>;
	let prepare: ReturnType<typeof vi.fn>;
	let error: ReturnType<typeof vi.fn>;
	let api: ReturnType<typeof vi.fn>;
	let router: GitHubMergeConflictRouter;
	const servers: ReturnType<typeof Fastify>[] = [];
	beforeEach(async () => {
		enabled = true;
		home = await mkdtemp(join(tmpdir(), "conflict-routing-"));
		pr = {
			number: 7,
			state: "open",
			draft: false,
			head: { sha: head, ref: "cyrus/task", repo: { id: 42 } },
			base: { sha: base, ref: "main", repo: { id: 42 } },
			mergeable: false,
			mergeable_state: "dirty",
		};
		repository = {
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
		error = vi.fn();
		api = vi.fn(async (url: string) => {
			const path = new URL(url).pathname;
			if (path.endsWith("/pulls/7")) return Response.json(pr);
			return Response.json({ id: 42 });
		});
		router = new GitHubMergeConflictRouter({
			home,
			enabled: () => enabled,
			repositories: () => [repository],
			sessions: () => sessions,
			token: async (_repo, forwarded) => forwarded ?? "private-token",
			prepare,
			onDispatchError: error,
			fetch: api as typeof fetch,
		});
	});
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((s) => s.close()));
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
		await rm(home, { recursive: true, force: true });
	});
	async function deliver(
		body: unknown = hintBody(),
		options: {
			mode?: "proxy" | "signature";
			authorization?: string;
			delivery?: string;
			handler?: boolean;
		} = {},
	) {
		const app = Fastify();
		servers.push(app);
		new GitHubEventTransport({
			fastifyServer: app,
			verificationMode: options.mode ?? "proxy",
			secret: "test-secret",
			...(options.handler === false
				? {}
				: {
						handleMergeConflict: (hint, context) =>
							router.handle(hint, context.installationToken),
					}),
		}).register();
		return app.inject({
			method: "POST",
			url: "/github-merge-conflict",
			payload: JSON.stringify(body),
			headers: {
				"content-type": "application/json",
				"x-github-delivery": options.delivery ?? "delivery-1",
				"x-github-installation-token": "installation-token",
				authorization: options.authorization ?? "Bearer test-secret",
			},
		});
	}

	it("continues exactly the session that owns the PR branch, with a safe prompt", async () => {
		const response = await deliver();
		expect(response.json()).toEqual({
			conflictProtocol: 1,
			outcome: "accepted",
			sessionId: "responsible-session",
		});
		expect(prepare).toHaveBeenCalledTimes(1);
		expect(prepare.mock.calls[0]![0]).toBe(sessions[0]);
		const prompt = prepare.mock.calls[0]![2] as string;
		expect(prompt).toContain("<pull_request>7</pull_request>");
		expect(prompt).toContain(`<head_sha>${head}</head_sha>`);
		expect(prompt).toContain(`<base_sha>${base}</base_sha>`);
		expect(prompt).toContain("Never force push");
		expect(prompt).toContain("Do not rebase");
		expect(prompt).toContain('trust="untrusted"');
		// Branch names and other provider text stay out of the prompt.
		expect(prompt).not.toContain("cyrus/task");
		expect(prompt).not.toContain("installation-token");
		// The forwarded App installation token is used for GitHub reads.
		expect(api.mock.calls[0]![1].headers.Authorization).toBe(
			"Bearer installation-token",
		);
		expect(runner).toHaveBeenCalledTimes(1);
	});

	it.each([
		[
			"unknown mergeability never counts",
			{ mergeable: null },
			"mergeability_unknown",
		],
		["mergeable PRs are left alone", { mergeable: true }, "not_conflicted"],
		[
			"a blocked-looking state is not a conflict",
			{ mergeable: true, mergeable_state: "blocked" },
			"not_conflicted",
		],
		["closed PRs", { state: "closed" }, "not_open_or_fork"],
		["draft PRs", { draft: true }, "not_open_or_fork"],
		[
			"fork heads",
			{ head: { sha: head, ref: "cyrus/task", repo: { id: 99 } } },
			"not_open_or_fork",
		],
		[
			"deleted fork heads",
			{ head: { sha: head, ref: "cyrus/task", repo: null } },
			"not_open_or_fork",
		],
		[
			"a moved head",
			{ head: { sha: "c".repeat(40), ref: "cyrus/task", repo: { id: 42 } } },
			"superseded",
		],
		[
			"a moved base",
			{ base: { sha: "c".repeat(40), ref: "main", repo: { id: 42 } } },
			"superseded",
		],
	])("%s", async (_, change, outcome) => {
		Object.assign(pr, change);
		expect((await deliver()).json()).toEqual({ conflictProtocol: 1, outcome });
		expect(prepare).not.toHaveBeenCalled();
	});

	it("never starts a session and refuses ambiguity", async () => {
		sessions = [sessions[1]!];
		expect((await deliver()).json().outcome).toBe("session_not_found");
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
		expect((await deliver()).json().outcome).toBe("ambiguous_session");
		expect(prepare).not.toHaveBeenCalled();
	});

	it("is off unless the runtime config opts in, and checks repository identity", async () => {
		enabled = false;
		expect((await deliver()).json().outcome).toBe("disabled");
		enabled = true;
		api.mockImplementation(async (url: string) =>
			new URL(url).pathname.endsWith("/pulls/7")
				? Response.json(pr)
				: Response.json({ id: 43 }),
		);
		expect((await deliver()).json().outcome).toBe(
			"repository_identity_mismatch",
		);
		repository.isActive = false;
		expect((await deliver()).json().outcome).toBe("repository_not_unique");
		expect(prepare).not.toHaveBeenCalled();
	});

	it("redeliveries and races dispatch once per head and base, within a per-PR limit", async () => {
		let release!: () => void;
		runner.mockImplementationOnce(
			() => new Promise<void>((resolve) => (release = resolve)),
		);
		expect((await deliver()).json().outcome).toBe("accepted");
		await vi.waitFor(() => expect(runner).toHaveBeenCalledTimes(1));
		// A racing delivery while the turn is still running never dispatches again.
		const racing = await deliver(hintBody(), { delivery: "delivery-2" });
		release();
		expect(racing.json().outcome).toBe("duplicate_revision");
		const journal = async (baseSha: string) => {
			const root = join(home, "merge-conflict-dispatch");
			const [dir] = await readdir(root);
			return JSON.parse(
				await readFile(join(root, dir!, `${head}-${baseSha}.json`), "utf8"),
			).state;
		};
		await vi.waitFor(async () => expect(await journal(base)).toBe("completed"));
		expect(
			(await deliver(hintBody(), { delivery: "delivery-3" })).json().outcome,
		).toBe("duplicate_revision");
		// Later base pushes conflict again: each head/base pair counts once.
		for (const next of ["c", "d"]) {
			pr.base.sha = next.repeat(40);
			const body = hintBody({
				pullRequest: { number: 7, headSha: head, baseSha: pr.base.sha },
			});
			expect((await deliver(body)).json().outcome).toBe("accepted");
			await vi.waitFor(async () =>
				expect(await journal(pr.base.sha)).toBe("completed"),
			);
		}
		pr.base.sha = "e".repeat(40);
		const fourth = hintBody({
			pullRequest: { number: 7, headSha: head, baseSha: pr.base.sha },
		});
		expect((await deliver(fourth)).json().outcome).toBe(
			"automatic_attempt_limit",
		);
		expect(runner).toHaveBeenCalledTimes(3);
	});

	it("rechecks GitHub after preparing and does not dispatch a resolved conflict", async () => {
		prepare.mockImplementation(async () => {
			pr.mergeable = true;
			return runner;
		});
		expect((await deliver()).json().outcome).toBe("not_conflicted");
		expect(runner).not.toHaveBeenCalled();
	});

	it("a failed GitHub read is a retryable 503, not success", async () => {
		api.mockResolvedValue(new Response(null, { status: 502 }));
		const response = await deliver();
		expect(response.statusCode).toBe(503);
		expect(prepare).not.toHaveBeenCalled();
	});

	it("accepts only authenticated, well-formed Hosted hints", async () => {
		expect(
			(await deliver(hintBody(), { authorization: "Bearer wrong" })).statusCode,
		).toBe(401);
		expect((await deliver(hintBody({ conflictProtocol: 2 }))).statusCode).toBe(
			400,
		);
		expect((await deliver(hintBody({ extra: true }))).statusCode).toBe(400);
		expect(
			(
				await deliver(
					hintBody({ pullRequest: { number: 7, headSha: "x", baseSha: base } }),
				)
			).statusCode,
		).toBe(400);
		expect((await deliver(hintBody(), { delivery: "" })).statusCode).toBe(400);
		// Direct GitHub delivery (signature mode) never carries these hints.
		expect((await deliver(hintBody(), { mode: "signature" })).statusCode).toBe(
			404,
		);
		// Without a handler the route does not exist, as on older runtimes.
		expect((await deliver(hintBody(), { handler: false })).statusCode).toBe(
			404,
		);
		expect(prepare).not.toHaveBeenCalled();
	});

	it("parses identifiers only", () => {
		expect(parseGitHubMergeConflictHint(hintBody())).toEqual({
			repository: { id: 42, fullName: "grain/app" },
			pullRequest: { number: 7, headSha: head, baseSha: base },
		});
		expect(
			parseGitHubMergeConflictHint(
				hintBody({ repository: { id: 42, fullName: "../x" } }),
			),
		).toBeNull();
	});
});
