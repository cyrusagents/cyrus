import { createHash } from "node:crypto";
import {
	mkdir,
	readdir,
	readFile,
	rename,
	rmdir,
	unlink,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import type { CyrusAgentSession, RepositoryConfig } from "cyrus-core";
import type { GitHubCiFailure } from "cyrus-github-event-transport";
import { buildGitHubCiPrompt } from "./prompts/githubCiPrompt.js";

type Pull = {
	number: number;
	state: string;
	head: { sha: string; ref: string; repo: { id: number } | null };
	base: { repo: { id: number } };
	merge_commit_sha: string | null;
};
type Check = {
	id: number;
	name: string;
	head_sha: string;
	status: string;
	conclusion: string;
	app: { id: number };
};
type Status = { id: number; context: string; state: string };
export interface CiRouterDependencies {
	home: string;
	/** Read live configuration; an omitted setting is disabled. */
	enabled: () => boolean;
	repositories: () => RepositoryConfig[];
	sessions: () => CyrusAgentSession[];
	token: (
		repository: RepositoryConfig,
		forwarded?: string,
	) => Promise<string | undefined>;
	/** Prepare without starting a turn. Returned callback starts that SAME session. */
	prepare: (
		session: CyrusAgentSession,
		repository: RepositoryConfig,
		prompt: string,
	) => Promise<() => Promise<void>>;
	onDispatchError: (sessionId: string) => void;
	fetch?: typeof fetch;
}

/** Fail-closed CI association and a durable, bounded dispatch journal. */
export class GitHubCiRouter {
	private readonly active = new Set<string>();
	private readonly activeSessions = new Set<string>();
	constructor(private readonly deps: CiRouterDependencies) {}

	async handle(
		failure: GitHubCiFailure,
		forwarded?: string,
	): Promise<{ outcome: string; sessionId?: string }> {
		if (!this.deps.enabled()) return { outcome: "disabled" };
		const repositories = this.deps.repositories().filter(
			(repo) =>
				repo.isActive !== false &&
				repo.githubUrl
					?.toLowerCase()
					.replace(/\/$/, "")
					.replace(/\.git$/, "") ===
					`https://github.com/${failure.repository.fullName}`.toLowerCase(),
		);
		if (repositories.length !== 1) return { outcome: "repository_not_unique" };
		const repository = repositories[0]!;
		const token = await this.deps.token(repository, forwarded);
		if (!token) throw new Error("CI GitHub credentials unavailable");
		const request = async <T>(path: string): Promise<T> => {
			const response = await (this.deps.fetch ?? fetch)(
				`https://api.github.com/repos/${failure.repository.fullName}${path}`,
				{
					headers: {
						Authorization: `Bearer ${token}`,
						Accept: "application/vnd.github+json",
						"X-GitHub-Api-Version": "2022-11-28",
					},
					signal: AbortSignal.timeout(5000),
					redirect: "error",
				},
			);
			if (!response.ok)
				throw new Error(`CI GitHub lookup failed (${response.status})`);
			return (await response.json()) as T;
		};
		const remote = await request<{ id: number }>("");
		if (remote.id !== failure.repository.id)
			return { outcome: "repository_identity_mismatch" };
		// Do not trust webhook branches/pull_requests: they can be empty, stale, or non-head.
		const candidates: Pull[] = [];
		for (let page = 1; ; page++) {
			const pulls = await request<Pull[]>(
				`/pulls?state=open&per_page=100&page=${page}`,
			);
			candidates.push(
				...pulls.filter(
					(pr) =>
						pr.head.sha === failure.sha || pr.merge_commit_sha === failure.sha,
				),
			);
			if (pulls.length < 100) break;
			if (page === 10)
				throw new Error("CI PR lookup exceeded safe pagination limit");
		}
		if (candidates.length !== 1)
			return { outcome: candidates.length ? "ambiguous_pr" : "no_current_pr" };
		const pr = await request<Pull>(`/pulls/${candidates[0]!.number}`);
		if (
			pr.state !== "open" ||
			pr.base.repo.id !== remote.id ||
			pr.head.repo?.id !== remote.id ||
			(pr.head.sha !== failure.sha && pr.merge_commit_sha !== failure.sha)
		)
			return { outcome: "stale_or_fork_pr" };
		if (pr.head.sha !== failure.sha) {
			const commit = await request<{ parents: { sha: string }[] }>(
				`/commits/${failure.sha}`,
			);
			if (!commit.parents.some((parent) => parent.sha === pr.head.sha))
				return { outcome: "stale_merge_revision" };
		}
		if (!(await this.isCurrentFailure(failure, request)))
			return { outcome: "superseded_failure" };
		const sessions = this.deps
			.sessions()
			.filter((session) =>
				session.repositories.some(
					(context) =>
						context.repositoryId === repository.id &&
						context.branchName === pr.head.ref,
				),
			);
		if (sessions.length !== 1)
			return {
				outcome: sessions.length ? "ambiguous_session" : "session_not_found",
			};
		const session = sessions[0]!;
		// Scope journal to repository + PR, not delivery ID, check ID or session ID.
		// Reruns/new sessions cannot reset the per-PR loop budget.
		const key = createHash("sha256")
			.update(`${remote.id}:${pr.number}`)
			.digest("hex");
		const dir = join(this.deps.home, "ci-dispatch", key);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const lock = join(dir, "lock");
		await mkdir(lock); // Atomic across processes; contention is retryable, not success.
		try {
			const path = join(dir, `${pr.head.sha}.json`);
			let prior: { state: string } | undefined;
			try {
				prior = JSON.parse(await readFile(path, "utf8"));
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			if (prior) {
				if (
					prior.state === "failed" ||
					(prior.state === "dispatching" && !this.active.has(path))
				)
					throw new Error("CI dispatch needs operator reconciliation");
				return { outcome: "duplicate_revision", sessionId: session.id };
			}
			if (
				(await readdir(dir)).filter((name) => name.endsWith(".json")).length >=
				3
			)
				return { outcome: "automatic_attempt_limit", sessionId: session.id };
			// GitHub-generated links only: provider target_url/output can contain secrets.
			const prompt = buildGitHubCiPrompt(failure, pr.number, pr.head.sha);
			if (this.activeSessions.has(session.id))
				throw new Error("CI session already reserved");
			this.activeSessions.add(session.id);
			let dispatched = false;
			try {
				const start = await this.deps.prepare(session, repository, prompt);
				// Recheck after preparation and before reservation/dispatch.
				const current = await request<Pull>(`/pulls/${pr.number}`);
				if (
					current.state !== "open" ||
					current.head.sha !== pr.head.sha ||
					(failure.sha !== current.head.sha &&
						current.merge_commit_sha !== failure.sha) ||
					!(await this.isCurrentFailure(failure, request))
				)
					return { outcome: "superseded_failure" };
				if (!this.deps.enabled()) return { outcome: "disabled" };
				const entry = {
					sessionId: session.id,
					repositoryId: remote.id,
					pr: pr.number,
					headSha: pr.head.sha,
					testedSha: failure.sha,
					eventType: failure.eventType,
					checkId: failure.id,
					createdAt: new Date().toISOString(),
				};
				const save = async (state: string) => {
					await writeFile(`${path}.tmp`, JSON.stringify({ ...entry, state }), {
						mode: 0o600,
					});
					await rename(`${path}.tmp`, path);
				};
				// Crash after reservation is deliberately not replayed automatically: the
				// agent may have acted. No exactly-once transaction exists with a runner.
				await save("dispatching");
				if (!this.deps.enabled()) {
					await unlink(path);
					return { outcome: "disabled" };
				}
				// Dispatch in background: runner.start can await the entire agent turn.
				// Keep dispatching until completion so a crash cannot look like success.
				this.active.add(path);
				dispatched = true;
				void Promise.resolve()
					.then(start)
					.then(() => save("completed"))
					.catch(async () => {
						try {
							await save("failed");
						} finally {
							this.deps.onDispatchError(session.id);
						}
					})
					.catch(() => this.deps.onDispatchError(session.id))
					.finally(() => {
						this.active.delete(path);
						this.activeSessions.delete(session.id);
					});
				return { outcome: "accepted", sessionId: session.id };
			} finally {
				if (!dispatched) this.activeSessions.delete(session.id);
			}
		} finally {
			await rmdir(lock);
		}
	}

	private async isCurrentFailure(
		failure: GitHubCiFailure,
		request: <T>(path: string) => Promise<T>,
	): Promise<boolean> {
		if (failure.eventType === "status") {
			for (let page = 1; page <= 10; page++) {
				// REST statuses are newest first. The first matching context wins.
				const statuses = await request<Status[]>(
					`/commits/${failure.sha}/statuses?per_page=100&page=${page}`,
				);
				const latest = statuses.find(
					(status) => status.context === failure.name,
				);
				if (latest)
					return (
						latest.id === failure.id &&
						["failure", "error"].includes(latest.state)
					);
				if (statuses.length < 100) return false;
			}
			throw new Error("CI status lookup exceeded safe pagination limit");
		}
		const runs: Check[] = [];
		for (let page = 1; page <= 10; page++) {
			const result = await request<{ check_runs: Check[] }>(
				`/commits/${failure.sha}/check-runs?filter=latest&per_page=100&page=${page}`,
			);
			runs.push(
				...result.check_runs.filter(
					(check) =>
						check.name === failure.name && check.app.id === failure.appId,
				),
			);
			if (result.check_runs.length < 100) {
				return (
					runs.length === 1 &&
					runs[0]!.id === failure.id &&
					runs[0]!.head_sha === failure.sha &&
					runs[0]!.status === "completed" &&
					[
						"failure",
						"timed_out",
						"action_required",
						"startup_failure",
					].includes(runs[0]!.conclusion)
				);
			}
		}
		throw new Error("CI checks lookup exceeded safe pagination limit");
	}
}
