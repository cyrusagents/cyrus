import type { LinearClient } from "@linear/sdk";
import type { RepositoryConfig } from "miko-core";
import { describe, expect, it, vi } from "vitest";
import {
	type AutomationAdapterDeps,
	AutomationAdapters,
} from "../src/automation/AutomationAdapters.js";
import {
	AUTOMATION_COMPLETION_INSTRUCTIONS,
	automationCompletion,
} from "../src/automation/completion.js";
import type { AutomationRun } from "../src/automation/types.js";

function fixture() {
	const repository = {
		id: "repo-1",
		name: "Human readable repo",
		linearWorkspaceId: "ws",
		isActive: true,
	} as RepositoryConfig;
	const client = {
		viewer: Promise.resolve({
			id: "agent",
			app: true,
			supportsAgentSessions: true,
			organization: Promise.resolve({ id: "ws" }),
		}),
		team: vi.fn(async () => ({ id: "team", archivedAt: null })),
		issues: vi.fn(async () => ({ nodes: [] as { url: string }[] })),
		createIssue: vi.fn(async () => ({
			success: true,
			issue: Promise.resolve({ url: "https://linear.app/ws/issue/T-1" }),
		})),
		agentSession: vi.fn(),
		agentSessions: vi.fn(async () => ({
			nodes: [],
			pageInfo: { hasNextPage: false },
		})),
	};
	const deps: AutomationAdapterDeps = {
		repositories: () => [repository],
		workspaces: () => ({
			ws: { linearToken: "private-token", linearWorkspaceName: "Workspace" },
		}),
		repoTags: () => [],
		startTask: vi.fn(async () => {}),
		localState: () => undefined,
	};
	const factory = vi.fn(() => client as unknown as LinearClient);
	const adapter = new AutomationAdapters(deps, factory);
	const run = {
		id: "run-1",
		automationId: "auto",
		issueId: "issue-uuid",
		status: "dispatching",
		createdAt: Date.now(),
		prUrls: [],
		snapshot: {
			name: "Fix it",
			instructions: "Implement and verify",
			repositoryId: "repo-1",
			target: { kind: "linear_issue", workspaceId: "ws", teamId: "team" },
		},
	} as AutomationRun;
	return { adapter, client, deps, run, factory };
}

describe("automation platform adapters", () => {
	it("creates with a durable issue ID, agent delegation and an unambiguous repository ID", async () => {
		const { adapter, client, run } = fixture();
		await adapter.validate(run.snapshot);
		expect(await adapter.dispatch(run)).toEqual({
			status: "waiting_session",
			issueUrl: "https://linear.app/ws/issue/T-1",
		});
		expect(client.createIssue).toHaveBeenCalledWith({
			id: "issue-uuid",
			title: "Fix it",
			description:
				"Implement and verify\n\n[repo=repo-1]\n\nAutomation run: run-1",
			teamId: "team",
			projectId: undefined,
			delegateId: "agent",
		});
	});
	it("recovers a successful creation whose response was lost without creating again", async () => {
		const { adapter, client, run } = fixture();
		client.issues.mockResolvedValue({
			nodes: [{ url: "https://linear.app/existing" }],
		});
		expect(await adapter.dispatch(run)).toEqual({
			status: "waiting_session",
			issueUrl: "https://linear.app/existing",
		});
		expect(client.createIssue).not.toHaveBeenCalled();
	});
	it("validates a direct repository task with no Linear connection and never calls Linear", async () => {
		const { adapter, deps, run, factory } = fixture();
		run.snapshot.target = { kind: "direct_repository" };
		deps.workspaces = () => ({});
		await adapter.validate(run.snapshot);
		expect(await adapter.dispatch(run)).toEqual({
			sessionId: "automation-run-1",
			status: "running",
		});
		expect(factory).not.toHaveBeenCalled();
		expect(deps.startTask).toHaveBeenCalledWith({
			id: "run-1",
			title: "Fix it",
			instructions: "Implement and verify",
			repositoryId: "repo-1",
			source: "automation",
		});
	});
	it("rejects human credentials, cross-workspace repositories and conflicting selectors", async () => {
		const { adapter, deps, run, client } = fixture();
		client.viewer = Promise.resolve({
			id: "human",
			app: false,
			supportsAgentSessions: false,
			organization: Promise.resolve({ id: "ws" }),
		});
		await expect(adapter.validate(run.snapshot)).rejects.toThrow(
			"app authorization",
		);
		run.snapshot.target = {
			kind: "linear_issue",
			workspaceId: "different",
			teamId: "team",
		};
		await expect(adapter.validate(run.snapshot)).rejects.toThrow(
			"does not belong",
		);
		run.snapshot.target = { kind: "direct_repository" };
		deps.repoTags = () => [{ repo: "another" }];
		await expect(adapter.validate(run.snapshot)).rejects.toThrow("selectors");
	});
	it("reports missing webhook delivery as uncertain and exposes no credentials in options", async () => {
		const { adapter, client, run } = fixture();
		client.issues.mockResolvedValue({
			nodes: [{ url: "https://linear.app/existing" }],
		});
		run.createdAt -= 300001;
		expect(await adapter.reconcile(run)).toMatchObject({ status: "uncertain" });
		expect(JSON.stringify(adapter.options())).not.toContain("private-token");
	});
	it("does not interpret Linear's turn-complete state as a completed development task", async () => {
		const { adapter, client, run } = fixture();
		run.sessionId = "session";
		client.issues.mockResolvedValue({
			nodes: [{ url: "https://linear.app/existing" }],
		});
		client.agentSession.mockResolvedValue({
			status: "complete",
			activities: async () => ({
				nodes: [
					{
						createdAt: new Date(),
						content: {
							type: "response",
							body: "I finished coding; tests are next.",
						},
					},
				],
			}),
		});
		expect(await adapter.reconcile(run)).toMatchObject({ status: "uncertain" });
	});
});

describe("development completion contract", () => {
	it("requires a final verified outcome or a reasoned no-change result", () => {
		expect(automationCompletion("Just finished coding")).toMatchObject({
			status: "uncertain",
		});
		expect(
			automationCompletion(
				'Done\n<!-- miko-automation-result {"outcome":"succeeded","reason":"Tests passed","prUrls":["https://github.com/org/repo/pull/1"]} -->',
			),
		).toEqual({
			status: "succeeded",
			message: "Done",
			prUrls: ["https://github.com/org/repo/pull/1"],
		});
		expect(
			automationCompletion(
				'<!-- miko-automation-result {"outcome":"no_change","reason":"Already up to date","prUrls":[]} -->',
			),
		).toEqual({
			status: "succeeded",
			message: "Already up to date",
			prUrls: [],
		});
		expect(
			automationCompletion(
				'<!-- miko-automation-result {"outcome":"succeeded","reason":"Done","prUrls":[]} -->',
			),
		).toMatchObject({ status: "uncertain" });
		expect(
			automationCompletion(
				'<!-- miko-automation-result {"outcome":"awaiting_input","reason":"Which release?","prUrls":[]} -->',
			),
		).toMatchObject({ status: "awaiting_input" });
	});
	it("keeps the complete automation instructions stable", () => {
		expect(
			AUTOMATION_COMPLETION_INSTRUCTIONS,
		).toBe(`This scheduled development run must include implementation, verification, and a pull request when changes are needed. Do not treat an intermediate step as task completion.
At the end of your final response, include a hidden completion record:
<!-- miko-automation-result {"outcome":"succeeded","reason":"Completed and verified","prUrls":["https://github.com/owner/repo/pull/123"]} -->
Use outcome "no_change" with a specific reason and an empty prUrls array when no changes are necessary; "awaiting_input" when clarification is required; or "failed" when blocked or unsuccessful. Only report "succeeded" after verification and PR creation. Never invent a PR URL.`);
	});
});
