import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JiraAgentJournal } from "../src/jira-agent/JiraAgentJournal.js";
import {
	JiraAgentTaskService,
	type JiraRunnerBuildInput,
	type JiraSendRequest,
	REPOSITORY_GONE_MESSAGE,
	REVOKED_MESSAGE,
	SCOPE_CHANGED_MESSAGE,
	UNPINNED_HISTORY_MESSAGE,
} from "../src/jira-agent/JiraAgentTaskService.js";
import { standardJiraRouting } from "./jira-routing-fixture.js";

/**
 * Standard Cyrus repository routing for Jira tasks, through the real
 * RepositoryRouter (any Linear call would throw): selectors, labels, project
 * key, catch-all, ask-the-user, and the routing a context keeps for life.
 */

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => logger,
} as unknown as ILogger;

const CTX = "11111111-1111-4111-8111-111111111111";
const TASK_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TASK_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const binding = {
	teamId: "33333333-3333-4333-8333-333333333333",
	installationLinkId: "44444444-4444-4444-8444-444444444444",
	accountLinkId: "55555555-5555-4555-8555-555555555555",
};

const repo = (id: string, extra: Partial<RepositoryConfig> = {}) =>
	({
		id,
		name: id,
		repositoryPath: `/repos/${id}`,
		baseBranch: "main",
		workspaceBaseDir: "/ws",
		linearWorkspaceId: "linear-org",
		githubUrl: `https://github.com/acme/${id}`,
		...extra,
	}) as RepositoryConfig;

let home: string;
let configured: Map<string, RepositoryConfig>;
let builds: JiraRunnerBuildInput[];
let workspaces: { ids: string[]; baseBranches: Record<string, string> }[];

function request(over: Partial<JiraSendRequest> = {}): JiraSendRequest {
	return {
		version: 2,
		kind: "create",
		taskId: TASK_A,
		contextId: CTX,
		messageId: "m1",
		binding,
		issue: {
			id: "10001",
			key: "QA-7",
			summary: "Fix login",
			description: "The login form is broken.",
			labels: [],
			projectKey: "QA",
		},
		authorizedRepositoryIds: [...configured.keys()],
		text: "Please fix this.",
		...over,
	};
}

/** When set, runs stay live until stopped (for revocation while running). */
let holdRuns = false;

/** Runner that answers every turn at once with a successful result. */
function instantRunner(input: JiraRunnerBuildInput) {
	let release: () => void = () => {};
	const held = new Promise<void>((r) => {
		release = r;
	});
	return {
		supportsStreamingInput: false,
		start: async () => {
			if (holdRuns) {
				await held;
				return { sessionId: "sess-1" };
			}
			input.onMessage({
				type: "result",
				subtype: "success",
				result: "done",
				session_id: "sess-1",
			} as never);
			return { sessionId: "sess-1" };
		},
		stop: () => release(),
		isRunning: () => false,
	};
}

async function service() {
	const journal = new JiraAgentJournal(home, logger);
	await journal.load();
	return new JiraAgentTaskService({
		journal,
		logger,
		getRepository: (id) => configured.get(id),
		...standardJiraRouting(() => [...configured.values()]),
		// Same rule the shared RunnerSelectionService applies to descriptions.
		resolveRunnerType: (_repos, issue) =>
			/\[agent=(\w+)\]/.exec(issue.description)?.[1] ?? "claude",
		createWorkspace: async (repositories, target, baseBranches) => {
			workspaces.push({ ids: repositories.map((r) => r.id), baseBranches });
			const base = (repositories[0] as RepositoryConfig).workspaceBaseDir;
			return { path: join(base, target.identifier), isGitWorktree: true };
		},
		buildRunner: async (input) => {
			builds.push(input);
			return { runner: instantRunner(input) as never, runnerType: "claude" };
		},
		cancelWaitMs: 50,
	});
}

const journalFile = () =>
	JSON.parse(
		readFileSync(join(home, "jira-agent", "contexts", `${CTX}.json`), "utf8"),
	);

async function completed(svc: JiraAgentTaskService, taskId = TASK_A) {
	await vi.waitFor(async () => {
		const s = await svc.get({
			authorizedRepositoryIds: [...configured.keys()],
			version: 2,
			taskId,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("completed");
		expect(svc.liveCount()).toBe(0);
	});
}

beforeEach(() => {
	holdRuns = false;
	home = mkdtempSync(join(tmpdir(), "jira-routing-"));
	builds = [];
	workspaces = [];
	configured = new Map(
		[
			repo("web", { teamKeys: ["WEB"], routingLabels: ["frontend"] }),
			repo("api", { teamKeys: ["API"], routingLabels: ["backend"] }),
		].map((r) => [r.id, r]),
	);
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("standard routing selects the repositories", () => {
	it("an explicit [repo=...] selector in the description wins", async () => {
		const svc = await service();
		const issue = {
			...request().issue,
			description: "Broken. [repo=api]",
			labels: ["frontend"],
		};
		const s = await svc.send(request({ issue }));
		expect(s.state).toBe("submitted");
		expect(s.progress[0]?.text).toBe(
			"Working in api, chosen by the [repo=…] selector.",
		);
		await completed(svc);
		expect(builds.map((b) => b.repositories.map((r) => r.id))).toEqual([
			["api"],
		]);
		expect(journalFile().routing).toEqual({
			repositoryIds: ["api"],
			baseBranches: {},
			method: "description-tag",
		});
	});

	it("a selector in the Jira request text (an @mention) routes too", async () => {
		const svc = await service();
		await svc.send(request({ text: "@Cyrus repo=web please" }));
		await completed(svc);
		expect(workspaces).toEqual([{ ids: ["web"], baseBranches: {} }]);
	});

	it("multi-repository selectors with a base branch build one multi-repo workspace", async () => {
		const svc = await service();
		const issue = {
			...request().issue,
			description: "Spans both.\nrepo=web,api#release",
		};
		await svc.send(request({ issue }));
		await completed(svc);
		expect(workspaces).toEqual([
			{ ids: ["web", "api"], baseBranches: { web: "release", api: "release" } },
		]);
		expect(builds[0]?.repositories.map((r) => r.id)).toEqual(["web", "api"]);
	});

	it("routing labels match the work item's Jira labels", async () => {
		const svc = await service();
		const issue = { ...request().issue, labels: ["backend"] };
		const s = await svc.send(request({ issue }));
		expect(s.progress[0]?.text).toBe(
			"Working in api, chosen by a routing label.",
		);
		await completed(svc);
		expect(journalFile().routing.method).toBe("label-based");
	});

	it("the Jira project key matches team keys through the issue-key prefix", async () => {
		const svc = await service();
		const issue = { ...request().issue, key: "WEB-3", projectKey: "WEB" };
		await svc.send(request({ issue }));
		await completed(svc);
		expect(journalFile().routing).toMatchObject({
			repositoryIds: ["web"],
			method: "team-prefix",
		});
	});

	it("ordinary automatic routing uses the workspace's catch-all repository", async () => {
		configured.set("mono", repo("mono"));
		const svc = await service();
		await svc.send(request());
		await completed(svc);
		expect(journalFile().routing).toMatchObject({
			repositoryIds: ["mono"],
			method: "catch-all",
		});
	});
});

describe("no match: ask the Jira user, never pick arbitrarily", () => {
	it("answers input-required with the choices and runs nothing", async () => {
		const svc = await service();
		const s = await svc.send(request());
		expect(s).toMatchObject({
			state: "input-required",
			settled: true,
			admitted: true,
			error: null,
		});
		expect(s.result).toContain("Which repository should I work in?");
		expect(s.result).toContain("- web\n- api");
		expect(s.result).toContain("[repo=name]");
		expect(s.result).toContain("repo=a,b for several");
		expect(builds).toHaveLength(0);
		expect(journalFile().routing).toBeNull();
		// A follow-up to a task waiting for a choice is not queued anywhere.
		await expect(
			svc.send(request({ kind: "followup", messageId: "m2", text: "web" })),
		).rejects.toMatchObject({ code: "task_terminal" });
	});

	it("a reply naming a repository selects it and runs the ORIGINAL request", async () => {
		const svc = await service();
		await svc.send(request());
		const s = await svc.send(
			request({ taskId: TASK_B, messageId: "m2", text: "`api`" }),
		);
		expect(s.progress[0]?.text).toBe("Working in api, chosen by your reply.");
		await completed(svc, TASK_B);
		expect(builds[0]?.repositories.map((r) => r.id)).toEqual(["api"]);
		expect(journalFile().tasks[1].initialText).toBe("Please fix this.");
		expect(journalFile().routing.method).toBe("user-selected");
	});

	it("a reply that names nothing asks again; a selector reply routes with both texts", async () => {
		const svc = await service();
		await svc.send(request());
		const again = await svc.send(
			request({ taskId: TASK_B, messageId: "m2", text: "whichever" }),
		);
		expect(again.state).toBe("input-required");
		const s = await svc.send(
			request({ taskId: TASK_C, messageId: "m3", text: "use [repo=web]" }),
		);
		expect(s.state).toBe("submitted");
		await completed(svc, TASK_C);
		expect(journalFile().tasks[2].initialText).toBe(
			"Please fix this.\n\nwhichever\n\nuse [repo=web]",
		);
	});
});

describe("workspace authorization", () => {
	it("never routes to or offers a repository Hosted did not authorize", async () => {
		configured.set("other-team", repo("other-team"));
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=other-team]" };
		const s = await svc.send(
			request({ issue, authorizedRepositoryIds: ["web", "api"] }),
		);
		// other-team is a configured catch-all here, but not this workspace's:
		// the selector is reported unresolved and never offered as a choice.
		expect(s.state).toBe("input-required");
		expect(s.result).toContain('I couldn\'t match "other-team"');
		expect(s.result).toContain("- web\n- api");
		expect(s.result).not.toContain("- other-team");
		expect(builds).toHaveLength(0);
	});

	it("refuses when nothing authorized is configured on this runtime", async () => {
		const svc = await service();
		await expect(
			svc.send(request({ authorizedRepositoryIds: ["somewhere-else"] })),
		).rejects.toMatchObject({ code: "no_repository", status: 409 });
	});
});

describe("a context keeps its routing for life", () => {
	async function routedToApi() {
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=api]" };
		await svc.send(request({ issue }));
		await completed(svc);
		return svc;
	}

	it("later tasks reuse the routing even if the work item now says otherwise", async () => {
		const svc = await routedToApi();
		const issue = { ...request().issue, description: "[repo=web]" };
		await svc.send(request({ taskId: TASK_B, messageId: "m2", issue }));
		await completed(svc, TASK_B);
		expect(builds.map((b) => b.repositories[0]?.id)).toEqual(["api", "api"]);
	});

	it("a duplicate create returns the same task without routing again", async () => {
		const svc = await routedToApi();
		const issue = { ...request().issue, description: "[repo=api]" };
		const again = await svc.send(request({ issue }));
		expect(again.state).toBe("completed");
		expect(builds).toHaveLength(1);
	});

	it("a removed repository refuses the context instead of re-routing", async () => {
		const svc = await routedToApi();
		configured.delete("api");
		configured.set("mono", repo("mono"));
		await expect(
			svc.send(
				request({
					taskId: TASK_B,
					messageId: "m2",
					authorizedRepositoryIds: ["web", "mono"],
				}),
			),
		).rejects.toMatchObject({
			code: "repository_unavailable",
			message: REPOSITORY_GONE_MESSAGE,
		});
		expect(builds).toHaveLength(1);
	});

	it("a repository Hosted no longer authorizes refuses the context too", async () => {
		const svc = await routedToApi();
		await expect(
			svc.send(
				request({
					taskId: TASK_B,
					messageId: "m2",
					authorizedRepositoryIds: ["web"],
				}),
			),
		).rejects.toMatchObject({ code: "repository_unavailable" });
	});

	it("survives a restart: the journal keeps the routing", async () => {
		await routedToApi();
		const after = await service();
		const issue = { ...request().issue, labels: ["frontend"] };
		await after.send(request({ taskId: TASK_B, messageId: "m2", issue }));
		await completed(after, TASK_B);
		expect(builds.map((b) => b.repositories[0]?.id)).toEqual(["api", "api"]);
	});

	it("a waiting choice survives a restart and is not treated as interrupted", async () => {
		const svc = await service();
		await svc.send(request());
		const after = await service();
		const s = await after.get({
			authorizedRepositoryIds: [...configured.keys()],
			version: 2,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("input-required");
		expect(journalFile().closed).toBe(false);
		await after.send(request({ taskId: TASK_B, messageId: "m2", text: "web" }));
		await completed(after, TASK_B);
		expect(builds[0]?.repositories[0]?.id).toBe("web");
	});

	it("cancel of a task waiting for a choice cancels its request for good", async () => {
		const svc = await service();
		await svc.send(request({ text: "Carry out the original work." }));
		const ref = {
			version: 2 as const,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		};
		expect((await svc.cancel(ref)).state).toBe("canceled");
		// Repeated cancel answers the same.
		expect((await svc.cancel(ref)).state).toBe("canceled");
		// A later message naming a repository is an independent request: the
		// canceled request is never carried into it.
		const later = await svc.send(
			request({ taskId: TASK_B, messageId: "m2", text: "api" }),
		);
		expect(later.state).toBe("input-required");
		expect(journalFile().tasks[1].initialText).toBe("api");
		expect(builds).toHaveLength(0);
	});
});

describe("legacy journal", () => {
	it("a v1 context (one site-bound repository) keeps that repository as its routing", async () => {
		const dir = join(home, "jira-agent", "contexts");
		mkdirSync(dir, { recursive: true });
		writeFileSync(
			join(dir, `${CTX}.json`),
			JSON.stringify({
				version: 1,
				contextId: CTX,
				binding: { ...binding, repositoryId: "web" },
				issue: { id: "10001", key: "QA-7", summary: "s", description: "d" },
				workspacePath: null,
				runnerType: null,
				runnerSessionId: null,
				closed: false,
				ownedProcesses: [],
				tasks: [],
				retired: {},
			}),
		);
		const svc = await service();
		await svc.send(request());
		await completed(svc);
		expect(builds[0]?.repositories[0]?.id).toBe("web");
		expect(journalFile()).toMatchObject({
			version: 2,
			binding,
			routing: { repositoryIds: ["web"], method: "site-repository" },
		});
	});
});

describe("strict routing never picks arbitrarily (RR1, RR2)", () => {
	it("two default repositories ask instead of running the first", async () => {
		configured = new Map([repo("first"), repo("second")].map((r) => [r.id, r]));
		const svc = await service();
		const s = await svc.send(request());
		expect(s.state).toBe("input-required");
		expect(s.result).toContain("- first\n- second");
		expect(builds).toHaveLength(0);
		expect(workspaces).toHaveLength(0);
	});

	it("an issue-key prefix shared by two repositories asks", async () => {
		configured = new Map(
			[repo("a", { teamKeys: ["QA"] }), repo("b", { teamKeys: ["QA"] })].map(
				(r) => [r.id, r],
			),
		);
		const svc = await service();
		expect((await svc.send(request())).state).toBe("input-required");
		expect(builds).toHaveLength(0);
	});

	it("an explicit selector naming no repository never falls back to the default", async () => {
		configured.set("mono", repo("mono"));
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=missing]" };
		const s = await svc.send(request({ issue }));
		expect(s.state).toBe("input-required");
		expect(s.result).toContain('I couldn\'t match "missing"');
		expect(builds).toHaveLength(0);
	});

	it("a partly unknown selector list runs nothing, not the known part", async () => {
		const svc = await service();
		const issue = {
			...request().issue,
			description: "Both, please.\nrepos=web,missing",
		};
		const s = await svc.send(request({ issue }));
		expect(s.state).toBe("input-required");
		expect(s.result).toContain('"missing"');
		expect(builds).toHaveLength(0);
	});

	it("a selector matching two repositories is ambiguous", async () => {
		configured = new Map(
			[
				repo("web", { routingLabels: ["x"] }),
				repo("Web-2", { name: "web", routingLabels: ["y"] }),
			].map((r) => [r.id, r]),
		);
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=web]" };
		expect((await svc.send(request({ issue }))).state).toBe("input-required");
		expect(builds).toHaveLength(0);
	});
});

describe("a context's physical scope is pinned (RR4)", () => {
	async function completedOnce() {
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=api]" };
		await svc.send(request({ issue }));
		await completed(svc);
		expect(journalFile().scope).toMatchObject({
			workspacePath: `/ws/jira-${CTX}`,
			entries: [{ repositoryId: "api", configuredPath: "/repos/api" }],
		});
		return svc;
	}

	it("a repository moved under the same id refuses instead of resuming elsewhere", async () => {
		const svc = await completedOnce();
		configured.set("api", repo("api", { repositoryPath: "/elsewhere/api" }));
		await expect(
			svc.send(request({ taskId: TASK_B, messageId: "m2" })),
		).rejects.toMatchObject({
			code: "repository_unavailable",
			message: SCOPE_CHANGED_MESSAGE,
		});
		expect(builds).toHaveLength(1);
	});

	it("a changed worktree location fails before any resumed run", async () => {
		const svc = await completedOnce();
		configured.set(
			"api",
			repo("api", {
				teamKeys: ["API"],
				routingLabels: ["backend"],
				workspaceBaseDir: "/other-ws",
			}),
		);
		await svc.send(request({ taskId: TASK_B, messageId: "m2" }));
		await vi.waitFor(async () => {
			const s = await svc.get({
				authorizedRepositoryIds: [...configured.keys()],
				version: 2,
				taskId: TASK_B,
				contextId: CTX,
				binding,
			});
			expect(s).toMatchObject({
				state: "failed",
				settled: true,
				error: SCOPE_CHANGED_MESSAGE,
			});
		});
		// The earlier session was never resumed in the new location.
		expect(builds).toHaveLength(1);
		expect(journalFile().scope.workspacePath).toBe(`/ws/jira-${CTX}`);
	});

	it("unrelated repositories added later don't disturb the context", async () => {
		const svc = await completedOnce();
		configured.set("new", repo("new"));
		await svc.send(
			request({
				taskId: TASK_B,
				messageId: "m2",
				authorizedRepositoryIds: [...configured.keys()],
			}),
		);
		await completed(svc, TASK_B);
		expect(builds.map((b) => b.resume)).toEqual([
			null,
			{ runnerType: "claude", sessionId: "sess-1" },
		]);
	});
});

describe("one set of issue facts for admission and execution (RR6)", () => {
	it("correcting an unsupported [agent=...] while choosing a repository runs with the correction", async () => {
		const svc = await service();
		const wrong = { ...request().issue, description: "Fix it. [agent=codex]" };
		expect((await svc.send(request({ issue: wrong }))).state).toBe(
			"input-required",
		);
		const fixed = { ...request().issue, description: "Fix it. [agent=claude]" };
		await svc.send(
			request({ taskId: TASK_B, messageId: "m2", text: "api", issue: fixed }),
		);
		await completed(svc, TASK_B);
		expect(builds[0]?.issue.description).toBe("Fix it. [agent=claude]");
	});

	it("an unsupported selector added after a Claude session exists doesn't block resuming it", async () => {
		const svc = await service();
		const first = { ...request().issue, description: "[repo=api]" };
		await svc.send(request({ issue: first }));
		await completed(svc);
		const later = {
			...request().issue,
			description: "[repo=api] [agent=codex]",
		};
		await svc.send(request({ taskId: TASK_B, messageId: "m2", issue: later }));
		await completed(svc, TASK_B);
		// The pinned session's facts are used, not the later selector.
		expect(builds[1]?.issue.description).toBe("[repo=api]");
		expect(builds[1]?.resume).toEqual({
			runnerType: "claude",
			sessionId: "sess-1",
		});
	});

	it("an unsupported selector on a first run is still refused before admission", async () => {
		const svc = await service();
		const issue = {
			...request().issue,
			description: "[repo=api] [agent=codex]",
		};
		await expect(svc.send(request({ issue }))).rejects.toMatchObject({
			code: "unsupported_runner",
		});
	});
});

describe("output and work follow the CURRENT authorization (two-sided contract)", () => {
	const ref = (taskId = TASK_A, ids?: string[]) => ({
		version: 2 as const,
		taskId,
		contextId: CTX,
		binding,
		authorizedRepositoryIds: ids,
	});
	async function routedToApi() {
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=api]" };
		const s = await svc.send(request({ issue }));
		expect(s.repositoryIds).toEqual(["api"]);
		await completed(svc);
		return { svc, issue };
	}

	it("snapshots carry the route; output is withheld once a routed repository is deauthorized", async () => {
		const { svc } = await routedToApi();
		const ok = await svc.get(ref(TASK_A, ["web", "api"]));
		expect(ok).toMatchObject({
			state: "completed",
			result: "done",
			repositoryIds: ["api"],
			contentWithheld: false,
		});
		const hidden = await svc.get(ref(TASK_A, ["web"]));
		expect(hidden).toMatchObject({
			state: "completed",
			result: null,
			progress: [],
			repositoryIds: ["api"],
			contentWithheld: true,
		});
		// Unrelated changes to the authorized set don't matter.
		expect((await svc.get(ref(TASK_A, ["api"]))).contentWithheld).toBe(false);
	});

	it("a duplicate send never replays output after deauthorization; authority isn't identity", async () => {
		const { svc, issue } = await routedToApi();
		// Same message with a different (fresh) authorization: same identity,
		// so a duplicate, not a conflict; but the route is no longer covered.
		await expect(
			svc.send(request({ issue, authorizedRepositoryIds: ["web"] })),
		).rejects.toMatchObject({ code: "repository_unavailable" });
		const again = await svc.send(
			request({ issue, authorizedRepositoryIds: ["api", "web", "x"] }),
		);
		expect(again).toMatchObject({ state: "completed", result: "done" });
	});

	it("losing authorization stops a running task (fence), without output", async () => {
		holdRuns = true;
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=api]" };
		await svc.send(request({ issue }));
		await vi.waitFor(() => expect(builds).toHaveLength(1));
		const s = await svc.get(ref(TASK_A, ["web"]));
		expect(s.contentWithheld).toBe(true);
		await vi.waitFor(async () => {
			const after = await svc.get(ref(TASK_A, ["api"]));
			expect(after).toMatchObject({
				state: "canceled",
				settled: true,
				error: REVOKED_MESSAGE,
			});
			expect(svc.liveCount()).toBe(0);
		});
	});

	it("a get without any authorization withholds output", async () => {
		const { svc } = await routedToApi();
		expect((await svc.get(ref(TASK_A))).contentWithheld).toBe(true);
	});

	it("cancel needs no authorization to stop, and returns no output without it (RR7)", async () => {
		holdRuns = true;
		const svc = await service();
		const issue = { ...request().issue, description: "[repo=api]" };
		const sent = await svc.send(request({ issue }));
		// Persisted progress exists before the stop (the routing line).
		expect(sent.progress.length).toBeGreaterThan(0);
		await vi.waitFor(() => expect(builds).toHaveLength(1));
		const s = await svc.cancel(ref(TASK_A));
		expect(s.state === "canceled" || s.state === "canceling").toBe(true);
		expect(s).toMatchObject({
			contentWithheld: true,
			progress: [],
			result: null,
		});
		// The stop itself still happened.
		await vi.waitFor(() => expect(svc.liveCount()).toBe(0));
		const after = await svc.get(ref(TASK_A, ["api"]));
		expect(after.state).toBe("canceled");
	});

	it.each([
		["omitted", undefined],
		["empty", []],
		["incomplete", ["web"]],
	])("cancel of a completed task with %s authorization returns no output (RR7)", async (_name, ids) => {
		const { svc } = await routedToApi();
		const s = await svc.cancel(ref(TASK_A, ids as string[] | undefined));
		expect(s).toMatchObject({
			state: "completed",
			contentWithheld: true,
			result: null,
			progress: [],
			repositoryIds: ["api"],
		});
	});

	it("cancel with covering authorization keeps the normal answer", async () => {
		const { svc } = await routedToApi();
		const s = await svc.cancel(ref(TASK_A, ["api", "web"]));
		expect(s).toMatchObject({
			state: "completed",
			contentWithheld: false,
			result: "done",
		});
		expect(s.progress.length).toBeGreaterThan(0);
	});
});

describe("journals that ran before scopes were pinned (RR8)", () => {
	const legacyIssue = {
		id: "10001",
		key: "QA-7",
		summary: "Fix login",
		description: "The login form is broken.",
		labels: [],
		projectKey: "QA",
	};
	const dir = () => join(home, "jira-agent", "contexts");
	function seed(record: Record<string, unknown>) {
		mkdirSync(dir(), { recursive: true });
		writeFileSync(join(dir(), `${CTX}.json`), JSON.stringify(record));
	}
	const completedTask = {
		taskId: TASK_A,
		messageHashes: {},
		state: "completed",
		settled: true,
		admitted: true,
		initialText: "old work",
		pendingFollowups: [],
		progress: [],
		nextSeq: 1,
		result: "old result",
		error: null,
		createdAt: "2026-10-30T00:00:00Z",
		updatedAt: "2026-10-30T00:00:00Z",
	};
	const executedHistory = {
		workspacePath: "/old/workspace",
		runnerType: "claude",
		runnerSessionId: "old-session-in-original-repo",
		closed: false,
		ownedProcesses: [],
		tasks: [completedTask],
		retired: {},
	};

	it.each([
		[
			"v2",
			{
				version: 2,
				contextId: CTX,
				binding,
				issue: { ...legacyIssue },
				routing: {
					repositoryIds: ["web"],
					baseBranches: {},
					method: "description-tag",
				},
				...executedHistory,
			},
		],
		[
			"v1",
			{
				version: 1,
				contextId: CTX,
				binding: { ...binding, repositoryId: "web" },
				issue: { id: "10001", key: "QA-7", summary: "s", description: "d" },
				...executedHistory,
			},
		],
	])("an executed %s context without a scope never resumes in a same-id replacement", async (_v, record) => {
		seed(record);
		configured.set(
			"web",
			repo("web", {
				repositoryPath: "/replacement/repository",
				workspaceBaseDir: "/replacement/workspaces",
			}),
		);
		const svc = await service();
		await expect(
			svc.send(request({ taskId: TASK_B, messageId: "m2" })),
		).rejects.toMatchObject({
			code: "repository_unavailable",
			message: UNPINNED_HISTORY_MESSAGE,
		});
		expect(builds).toHaveLength(0);
		expect(workspaces).toHaveLength(0);
		// Nothing was adopted as the old session's scope.
		expect(journalFile().scope ?? null).toBeNull();
		// A new conversation still works.
		await svc.send(
			request({
				taskId: TASK_B,
				contextId: "22222222-2222-4222-8222-222222222222",
				messageId: "m3",
				issue: { ...request().issue, description: "[repo=web]" },
			}),
		);
		await vi.waitFor(() => expect(builds).toHaveLength(1));
		expect(builds[0]?.resume).toBeNull();
	});

	it("a context that only waited for a choice (never ran) stays usable", async () => {
		seed({
			version: 2,
			contextId: CTX,
			binding,
			issue: { ...legacyIssue },
			routing: null,
			workspacePath: null,
			runnerType: null,
			runnerSessionId: null,
			closed: false,
			ownedProcesses: [],
			tasks: [
				{
					...completedTask,
					state: "input-required",
					result: "Which repository should I work in?",
					initialText: "Please fix this.",
				},
			],
			retired: {},
		});
		const svc = await service();
		await svc.send(request({ taskId: TASK_B, messageId: "m2", text: "api" }));
		await completed(svc, TASK_B);
		expect(builds[0]?.resume).toBeNull();
		expect(builds[0]?.repositories[0]?.id).toBe("api");
	});
});
