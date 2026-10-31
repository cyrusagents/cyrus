import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ILogger, RepositoryConfig } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitService } from "../src/GitService.js";
import { JiraAgentJournal } from "../src/jira-agent/JiraAgentJournal.js";
import {
	JiraAgentTaskService,
	type JiraRunnerBuildInput,
} from "../src/jira-agent/JiraAgentTaskService.js";
import { inspectJiraWorkspace } from "../src/jira-agent/JiraWorkspaceScope.js";
import { standardJiraRouting } from "./jira-routing-fixture.js";

/**
 * Real local git (no network, no model): a Jira task's workspace is accepted
 * only when every routed repository has its own worktree of THAT repository.
 * GitService's multi-repository layout falls back to a plain directory for a
 * child it couldn't check out and still reports the parent as a worktree.
 */

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext: () => logger,
} as unknown as ILogger;

const CTX = "11111111-1111-4111-8111-111111111111";
const TASK = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const binding = {
	teamId: "33333333-3333-4333-8333-333333333333",
	installationLinkId: "44444444-4444-4444-8444-444444444444",
	accountLinkId: "55555555-5555-4555-8555-555555555555",
};

let root: string;
let builds: JiraRunnerBuildInput[];

function gitRepo(name: string): string {
	const path = join(root, "repos", name);
	mkdirSync(path, { recursive: true });
	const git = (...args: string[]) =>
		execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
			cwd: path,
			stdio: "pipe",
		});
	git("init", "-b", "main");
	git("config", "user.email", "fixture@example.invalid");
	git("config", "user.name", "Fixture");
	writeFileSync(join(path, "README.md"), name);
	git("add", "README.md");
	git("commit", "-m", "fixture");
	return path;
}

const repo = (id: string, repositoryPath: string) =>
	({
		id,
		name: id,
		repositoryPath,
		baseBranch: "main",
		workspaceBaseDir: join(root, "worktrees"),
	}) as RepositoryConfig;

async function service(configured: Map<string, RepositoryConfig>) {
	const journal = new JiraAgentJournal(join(root, "home"), logger);
	await journal.load();
	const git = new GitService({ cyrusHome: join(root, "home") }, logger);
	return new JiraAgentTaskService({
		journal,
		logger,
		getRepository: (id) => configured.get(id),
		...standardJiraRouting(() => [...configured.values()]),
		// The production check, not the fake one.
		inspectWorkspace: inspectJiraWorkspace,
		resolveRunnerType: () => "claude",
		createWorkspace: (repositories, target, baseBranches) =>
			git.createGitWorktree(
				{
					id: target.identifier,
					identifier: target.identifier,
					title: target.title,
					branchName: target.branchName,
					parent: Promise.resolve(undefined),
					inverseRelations: () => Promise.resolve({ nodes: [] }),
					labels: () => Promise.resolve({ nodes: [] }),
				} as never,
				repositories,
				{ baseBranchOverrides: new Map(Object.entries(baseBranches)) },
			),
		buildRunner: async (input) => {
			builds.push(input);
			return {
				runnerType: "claude",
				runner: {
					supportsStreamingInput: false,
					start: async () => {
						input.onMessage({
							type: "result",
							subtype: "success",
							result: "done",
							session_id: "s",
						} as never);
						return { sessionId: "s" };
					},
					stop: () => {},
					isRunning: () => false,
				} as never,
			};
		},
	});
}

async function run(
	configured: Map<string, RepositoryConfig>,
	description: string,
) {
	const svc = await service(configured);
	await svc.send({
		version: 2,
		kind: "create",
		taskId: TASK,
		contextId: CTX,
		messageId: "m1",
		binding,
		issue: {
			id: "1",
			key: "QA-1",
			summary: "s",
			description,
			labels: [],
			projectKey: "QA",
		},
		authorizedRepositoryIds: [...configured.keys()],
		text: "Do the fixture work.",
	});
	let snapshot: Awaited<ReturnType<typeof svc.get>> | undefined;
	await vi.waitFor(
		async () => {
			snapshot = await svc.get({
				version: 2,
				taskId: TASK,
				contextId: CTX,
				binding,
				authorizedRepositoryIds: [...configured.keys()],
			});
			expect(snapshot.settled).toBe(true);
			expect(svc.liveCount()).toBe(0);
		},
		{ timeout: 30_000 },
	);
	return snapshot as NonNullable<typeof snapshot>;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "jira-scope-"));
	builds = [];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Jira workspaces on real git", () => {
	it("a multi-repository checkout with a plain (non-git) child starts nothing", async () => {
		const broken = join(root, "repos", "broken");
		mkdirSync(broken, { recursive: true });
		const configured = new Map([
			["valid", repo("valid", gitRepo("valid"))],
			["broken", repo("broken", broken)],
		]);
		const s = await run(configured, "repos=valid,broken");
		expect(s.state).toBe("failed");
		expect(s.error).toContain("broken has no valid git worktree");
		expect(builds).toHaveLength(0);
	});

	it("two real repositories get their own worktrees and run", async () => {
		const configured = new Map([
			["web", repo("web", gitRepo("web"))],
			["api", repo("api", gitRepo("api"))],
		]);
		const s = await run(configured, "repos=web,api");
		expect(s.state).toBe("completed");
		expect(builds).toHaveLength(1);
		const ws = builds[0]?.workspace;
		const inspected = await inspectJiraWorkspace(
			ws as never,
			builds[0]?.repositories ?? [],
		);
		expect(inspected.ok).toBe(true);
	});

	it("a worktree of a different repository is rejected", async () => {
		const a = gitRepo("a");
		const b = gitRepo("b");
		const worktree = join(root, "worktrees", "x");
		execFileSync("git", ["-C", b, "worktree", "add", "-b", "x", worktree], {
			stdio: "pipe",
		});
		const inspected = await inspectJiraWorkspace(
			{ path: worktree, isGitWorktree: true },
			[repo("a", a)],
		);
		expect(inspected).toEqual({
			ok: false,
			reason: "a's worktree belongs to another repository",
		});
	});

	it("the repository's own main checkout is never accepted as the task worktree", async () => {
		const a = gitRepo("a");
		const inspected = await inspectJiraWorkspace(
			{ path: a, isGitWorktree: true },
			[repo("a", a)],
		);
		expect(inspected.ok).toBe(false);
	});

	it("a directory inside another checkout is not its own worktree", async () => {
		const a = gitRepo("a");
		const nested = join(a, "nested");
		mkdirSync(nested);
		const inspected = await inspectJiraWorkspace(
			{ path: nested, isGitWorktree: true },
			[repo("a", a)],
		);
		expect(inspected.ok).toBe(false);
	});
});
