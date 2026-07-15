import type { AgentSessionCreatedWebhook } from "cyrus-core";
import { beforeEach, describe, expect, it } from "vitest";
import { WebhookRouter, type WebhookRouterDeps } from "../src/WebhookRouter.js";
import {
	makeRepo,
	makeWebhookRouterDeps,
	type SpiedWebhookRouterDeps,
} from "./webhookRouterTestUtils.js";

/**
 * Verifies routeCreateWebhook honors the agentSessionCreated constraints from
 * packages/CLAUDE.md: cached repos skip routing; needs_selection defers the
 * runner to the prompted webhook; selected caches then starts; access/blocked-by
 * short-circuit the start.
 */
describe("WebhookRouter.routeCreatedWebhook", () => {
	let deps: SpiedWebhookRouterDeps;
	let router: WebhookRouter;
	const repos = [makeRepo("repo-1"), makeRepo("repo-2")];

	beforeEach(() => {
		deps = makeWebhookRouterDeps();
		router = new WebhookRouter(deps as unknown as WebhookRouterDeps);
	});

	const created = (
		issueId: string | null = "issue-1",
	): AgentSessionCreatedWebhook =>
		({
			type: "AgentSessionEvent",
			action: "created",
			organizationId: "workspace-1",
			agentSession: {
				id: "session-1",
				issue: issueId ? { id: issueId, identifier: "T-1" } : undefined,
			},
		}) as unknown as AgentSessionCreatedWebhook;

	it("cached repositories skip routing and start directly", async () => {
		const repo = makeRepo("cached-repo");
		deps.getCachedRepositories.mockReturnValue([repo]);
		const webhook = created();
		await router.routeCreatedWebhook(webhook, repos);
		expect(
			deps.repositoryRouter.determineRepositoryForWebhook,
		).not.toHaveBeenCalled();
		expect(deps.startSession).toHaveBeenCalledWith(webhook, [repo], {
			baseBranchOverrides: undefined,
			routingMethod: undefined,
		});
	});

	it("routingResult 'none' is a no-op (no elicit/park/start)", async () => {
		deps.getCachedRepositories.mockReturnValue(null);
		deps.repositoryRouter.determineRepositoryForWebhook.mockResolvedValue({
			type: "none",
		});
		await router.routeCreatedWebhook(created(), repos);
		expect(
			deps.repositoryRouter.elicitUserRepositorySelection,
		).not.toHaveBeenCalled();
		expect(deps.parkSession).not.toHaveBeenCalled();
		expect(deps.startSession).not.toHaveBeenCalled();
	});

	it("'needs_selection' elicits selection and does NOT start a runner", async () => {
		deps.getCachedRepositories.mockReturnValue(null);
		deps.repositoryRouter.determineRepositoryForWebhook.mockResolvedValue({
			type: "needs_selection",
			workspaceRepos: repos,
		});
		const webhook = created();
		await router.routeCreatedWebhook(webhook, repos);
		expect(
			deps.repositoryRouter.elicitUserRepositorySelection,
		).toHaveBeenCalledWith(webhook, repos);
		expect(deps.startSession).not.toHaveBeenCalled();
		expect(deps.parkSession).not.toHaveBeenCalled();
		expect(deps.checkBlockedByDependencies).not.toHaveBeenCalled();
	});

	it("'selected' caches the repo ids then starts the session", async () => {
		const selected = makeRepo("selected-repo");
		const baseBranchOverrides = new Map([["selected-repo", "develop"]]);
		deps.getCachedRepositories.mockReturnValue(null);
		deps.repositoryRouter.determineRepositoryForWebhook.mockResolvedValue({
			type: "selected",
			repositories: [selected],
			routingMethod: "description-tag",
			baseBranchOverrides,
		});
		const webhook = created();
		await router.routeCreatedWebhook(webhook, repos);
		expect(deps.cacheIssueRepositories).toHaveBeenCalledWith("issue-1", [
			"selected-repo",
		]);
		expect(deps.startSession).toHaveBeenCalledWith(webhook, [selected], {
			baseBranchOverrides,
			routingMethod: "description-tag",
		});
		expect(deps.parkSession).not.toHaveBeenCalled();
	});

	it("blocked user -> handleBlockedUser and no start", async () => {
		const selected = makeRepo("selected-repo");
		deps.getCachedRepositories.mockReturnValue([selected]);
		deps.checkUserAccess.mockReturnValue({
			allowed: false,
			reason: "blacklisted",
			userName: "Mallory",
		});
		const webhook = created();
		await router.routeCreatedWebhook(webhook, repos);
		expect(deps.handleBlockedUser).toHaveBeenCalledWith(
			webhook,
			selected,
			"blacklisted",
		);
		expect(deps.checkBlockedByDependencies).not.toHaveBeenCalled();
		expect(deps.startSession).not.toHaveBeenCalled();
	});

	it("blocked-by dependencies -> parkSession and no start", async () => {
		const selected = makeRepo("selected-repo");
		deps.getCachedRepositories.mockReturnValue([selected]);
		deps.checkBlockedByDependencies.mockResolvedValue({
			blocked: true,
			blockingIssueIds: ["blk-1"],
			blockingIdentifiers: ["T-9"],
		});
		const webhook = created();
		await router.routeCreatedWebhook(webhook, repos);
		expect(deps.parkSession).toHaveBeenCalledWith(
			webhook,
			[selected],
			["blk-1"],
			["T-9"],
			{ baseBranchOverrides: undefined, routingMethod: undefined },
		);
		expect(deps.startSession).not.toHaveBeenCalled();
	});

	it("redelivered created webhook (same agentSession.id) starts only once", async () => {
		const repo = makeRepo("cached-repo");
		deps.getCachedRepositories.mockReturnValue([repo]);
		const webhook = created();
		// Linear's at-least-once delivery: the same creation event arrives twice.
		await router.routeCreatedWebhook(webhook, repos);
		await router.routeCreatedWebhook(webhook, repos);
		expect(deps.startSession).toHaveBeenCalledTimes(1);
	});

	it("concurrent redelivery while first start is in flight starts only once", async () => {
		const repo = makeRepo("cached-repo");
		deps.getCachedRepositories.mockReturnValue([repo]);
		// startSession stays in flight briefly, mimicking runner A's subprocess
		// still streaming when the redelivered webhook is routed.
		deps.startSession.mockImplementation(
			() => new Promise<void>((resolve) => setTimeout(resolve, 5)),
		);
		const webhook = created();
		const first = router.routeCreatedWebhook(webhook, repos);
		const second = router.routeCreatedWebhook(webhook, repos);
		await Promise.all([first, second]);
		expect(deps.startSession).toHaveBeenCalledTimes(1);
	});

	it("a failed start is retried on redelivery (guard is released on throw)", async () => {
		const repo = makeRepo("cached-repo");
		deps.getCachedRepositories.mockReturnValue([repo]);
		deps.startSession.mockRejectedValueOnce(new Error("boom"));
		const webhook = created();
		await expect(router.routeCreatedWebhook(webhook, repos)).rejects.toThrow(
			"boom",
		);
		// Linear redelivers after the failure; the retry must be allowed through.
		await router.routeCreatedWebhook(webhook, repos);
		expect(deps.startSession).toHaveBeenCalledTimes(2);
	});
});
