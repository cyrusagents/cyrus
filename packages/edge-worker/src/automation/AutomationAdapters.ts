import { LinearClient, LinearDocument, LinearError } from "@linear/sdk";
import type { RepositoryConfig } from "atmiko-core";
import { automationCompletion } from "./completion.js";
import {
	type AutomationAdapter,
	AutomationError,
	type AutomationInput,
	type AutomationRun,
	type RepositoryTaskRequest,
	type RunUpdate,
} from "./types.js";

export interface AutomationAdapterDeps {
	/** Use the existing tracker client so OAuth refresh and token hot reload remain shared. */
	clientForWorkspace?(workspaceId: string): LinearClient | undefined;
	repositories(): RepositoryConfig[];
	workspaces(): Record<
		string,
		{ linearToken: string; linearWorkspaceName?: string }
	>;
	repoTags(description: string): { repo: string; branch?: string }[];
	startTask(request: RepositoryTaskRequest): Promise<void>;
	localState(run: AutomationRun): RunUpdate | undefined;
}

export class AutomationAdapters implements AutomationAdapter {
	constructor(
		private deps: AutomationAdapterDeps,
		private client = (token: string) =>
			new LinearClient({
				accessToken: token,
				signal: AbortSignal.timeout(30000),
			}),
	) {}
	private linear(workspaceId: string) {
		const workspace = this.deps.workspaces()[workspaceId];
		if (!workspace?.linearToken)
			throw new AutomationError("Linear connection is unavailable");
		if (this.deps.clientForWorkspace) {
			const client = this.deps.clientForWorkspace(workspaceId);
			if (!client)
				throw new AutomationError("Linear agent connection is unavailable");
			return client;
		}
		return this.client(workspace.linearToken);
	}
	options() {
		return {
			repositories: this.deps.repositories().map((r) => ({
				id: r.id,
				name: r.name,
				workspaceId: r.linearWorkspaceId,
			})),
			workspaces: Object.entries(this.deps.workspaces()).map(([id, w]) => ({
				id,
				name: w.linearWorkspaceName || id,
			})),
		};
	}
	async linearOptions(workspaceId: string, teamId?: string) {
		const client = this.linear(workspaceId);
		const connection = teamId
			? await (await client.team(teamId)).projects({ first: 250 })
			: await client.teams({ first: 250 });
		const values = connection.nodes.map((n) => ({ id: n.id, name: n.name }));
		while (connection.pageInfo.hasNextPage) {
			await connection.fetchNext();
			for (const n of connection.nodes)
				if (!values.some((v) => v.id === n.id))
					values.push({ id: n.id, name: n.name });
		}
		return values;
	}
	async validate(input: AutomationInput) {
		try {
			await this.validateTarget(input);
		} catch (error) {
			throw this.normalizeError(error);
		}
	}
	private normalizeError(error: unknown) {
		if (
			error instanceof LinearError &&
			([
				"AuthenticationError",
				"Forbidden",
				"InvalidInput",
				"FeatureNotAccessible",
				"UserError",
			].includes(error.type || "") ||
				[400, 401, 403, 404].includes(error.status || 0))
		)
			return new AutomationError(
				"Linear rejected the request; check authorization and target configuration",
				error.status || 400,
			);
		return error;
	}
	private async validateTarget(input: AutomationInput) {
		const repository = this.deps
			.repositories()
			.find((r) => r.id === input.repositoryId);
		if (!repository || repository.isActive === false)
			throw new AutomationError("Repository is unavailable");
		const tags = this.deps.repoTags(input.instructions);
		if (
			tags.some((t) => {
				const matches = this.deps
					.repositories()
					.filter(
						(r) =>
							r.id === t.repo ||
							r.name.toLowerCase() === t.repo.toLowerCase() ||
							[r.githubUrl, r.gitlabUrl].some(
								(url) =>
									url?.endsWith(`/${t.repo}`) ||
									url?.endsWith(`/${t.repo}.git`),
							),
					);
				return (
					t.branch || matches.length !== 1 || matches[0]?.id !== repository.id
				);
			})
		)
			throw new AutomationError(
				"Task repository selectors must match the selected repository without a branch override",
			);
		if (input.target.kind !== "linear_issue") return;
		if (repository.linearWorkspaceId !== input.target.workspaceId)
			throw new AutomationError(
				"Repository does not belong to the selected Linear workspace",
			);
		if (!/^[a-zA-Z0-9_\-/.]+$/.test(repository.id))
			throw new AutomationError(
				"Repository ID cannot be represented as a routing selector",
			);
		const client = this.linear(input.target.workspaceId);
		const viewer = await client.viewer;
		if (!viewer.app || !viewer.supportsAgentSessions)
			throw new AutomationError(
				"Connect Linear with the miko agent's app authorization",
			);
		if ((await viewer.organization).id !== input.target.workspaceId)
			throw new AutomationError(
				"Linear connection belongs to a different workspace",
			);
		const team = await client.team(input.target.teamId);
		if (team.archivedAt) throw new AutomationError("Linear team is archived");
		const projectId = input.target.projectId;
		if (
			projectId &&
			!(await this.linearOptions(input.target.workspaceId, team.id)).some(
				(p) => p.id === projectId,
			)
		)
			throw new AutomationError("Project does not belong to the selected team");
	}
	async dispatch(run: AutomationRun): Promise<RunUpdate> {
		try {
			return await this.dispatchTarget(run);
		} catch (error) {
			throw this.normalizeError(error);
		}
	}
	private async dispatchTarget(run: AutomationRun): Promise<RunUpdate> {
		const input = run.snapshot;
		if (input.target.kind === "direct_repository") {
			await this.deps.startTask({
				id: run.id,
				title: input.name,
				instructions: input.instructions,
				repositoryId: input.repositoryId,
				source: "automation",
			});
			return { sessionId: `automation-${run.id}`, status: "running" };
		}
		const client = this.linear(input.target.workspaceId);
		const existing = await client.issues({
			filter: { id: { eq: run.issueId! } },
			first: 1,
		});
		if (existing.nodes[0])
			return { issueUrl: existing.nodes[0].url, status: "waiting_session" };
		const viewer = await client.viewer;
		const repository = this.deps
			.repositories()
			.find((r) => r.id === input.repositoryId)!;
		const result = await client.createIssue({
			id: run.issueId,
			title: input.name,
			description: `${input.instructions}\n\n[repo=${repository.id}]\n\nAutomation run: ${run.id}`,
			teamId: input.target.teamId,
			projectId: input.target.projectId,
			delegateId: viewer.id,
		});
		if (!result.success)
			throw new AutomationError("Linear rejected issue creation");
		const issue = await result.issue;
		return { status: "waiting_session", issueUrl: issue?.url };
	}
	async reconcile(run: AutomationRun): Promise<RunUpdate> {
		const local = this.deps.localState(run);
		if (local) return local;
		if (run.snapshot.target.kind === "direct_repository")
			return {
				status: "uncertain",
				message:
					run.message ||
					"Previous execution cannot be confirmed; it will not be restarted automatically",
			};
		const client = this.linear(run.snapshot.target.workspaceId);
		const issues = await client.issues({
			filter: { id: { eq: run.issueId! } },
			first: 1,
		});
		if (!issues.nodes.length)
			return {
				status: "uncertain",
				message: "Issue creation could not be confirmed",
			};
		let sessionId = run.sessionId;
		if (!sessionId) {
			const viewer = await client.viewer;
			const sessions = await client.agentSessions({
				first: 100,
				orderBy: LinearDocument.PaginationOrderBy.CreatedAt,
			});
			for (let page = 0; page < 5; page++) {
				const match = sessions.nodes.find(
					(session) =>
						session.issueId === run.issueId && session.appUserId === viewer.id,
				);
				if (match) {
					sessionId = match.id;
					break;
				}
				if (
					!sessions.pageInfo.hasNextPage ||
					sessions.nodes.some(
						(session) => session.createdAt.getTime() < run.createdAt - 60000,
					)
				)
					break;
				await sessions.fetchNext();
			}
		}
		if (sessionId) {
			const session = await client.agentSession(sessionId);
			if (session.status === "error")
				return {
					status: "failed",
					sessionId,
					message: "Confirmed failure from Linear agent session",
				};
			if (session.status === "complete") {
				const activities = await session.activities({ last: 50 });
				const response = [...activities.nodes]
					.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
					.find((a) => a.content.type === "response");
				return {
					sessionId,
					...automationCompletion(
						response &&
							"body" in response.content &&
							typeof response.content.body === "string"
							? response.content.body
							: "",
					),
				};
			}
			if (session.status === "awaitingInput")
				return {
					sessionId,
					status: "awaiting_input",
					message: "Waiting for an answer in Linear",
				};
			if (session.status === "active") return { sessionId, status: "running" };
		}
		return Date.now() - run.createdAt > 300000
			? {
					status: "uncertain",
					sessionId,
					issueUrl: issues.nodes[0]!.url,
					message:
						"Issue exists, but no active local execution is confirmed. Check delegation, webhook delivery and repository access.",
				}
			: {
					status: "waiting_session",
					sessionId,
					issueUrl: issues.nodes[0]!.url,
				};
	}
}
