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
		repositoryIds: [...configured.keys()],
		text: "Please fix this.",
		...over,
	};
}

/** Runner that answers every turn at once with a successful result. */
function instantRunner(input: JiraRunnerBuildInput) {
	return {
		supportsStreamingInput: false,
		start: async () => {
			input.onMessage({
				type: "result",
				subtype: "success",
				result: "done",
				session_id: "sess-1",
			} as never);
			return { sessionId: "sess-1" };
		},
		stop: () => {},
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
		resolveRunnerType: () => "claude",
		createWorkspace: async (repositories, target, baseBranches) => {
			workspaces.push({ ids: repositories.map((r) => r.id), baseBranches });
			return { path: join("/ws", target.identifier), isGitWorktree: true };
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
		const s = await svc.get({ version: 2, taskId, contextId: CTX, binding });
		expect(s.state).toBe("completed");
		expect(svc.liveCount()).toBe(0);
	});
}

beforeEach(() => {
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
		const s = await svc.send(request({ issue, repositoryIds: ["web", "api"] }));
		// other-team is a configured catch-all here, but not this workspace's.
		expect(s.state).toBe("input-required");
		expect(s.result).not.toContain("other-team");
		expect(builds).toHaveLength(0);
	});

	it("refuses when nothing authorized is configured on this runtime", async () => {
		const svc = await service();
		await expect(
			svc.send(request({ repositoryIds: ["somewhere-else"] })),
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
					repositoryIds: ["web", "mono"],
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
				request({ taskId: TASK_B, messageId: "m2", repositoryIds: ["web"] }),
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

	it("cancel of a task waiting for a choice changes nothing", async () => {
		const svc = await service();
		await svc.send(request());
		const s = await svc.cancel({
			version: 2,
			taskId: TASK_A,
			contextId: CTX,
			binding,
		});
		expect(s.state).toBe("input-required");
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
