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
import type { GitHubMergeConflictHint } from "cyrus-github-event-transport";
import { buildGitHubMergeConflictPrompt } from "./prompts/githubMergeConflictPrompt.js";

type Pull = {
	number: number;
	state: string;
	draft?: boolean;
	head: { sha: string; ref: string; repo: { id: number } | null };
	base: { sha: string; repo: { id: number } };
	/** GitHub computes this lazily: `null` means unknown and never counts. */
	mergeable: boolean | null;
};

export interface MergeConflictRouterDependencies {
	home: string;
	/** Live configuration; an omitted setting is disabled. */
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

/** Automatic follow-ups per pull request, across head and base revisions. */
const ATTEMPT_LIMIT = 3;

/**
 * Continues the one existing session that owns a conflicted PR's branch. A
 * Hosted hint is only a reason to look: the PR is re-read and must still be
 * open, not a draft, from this repository (no forks), at the hinted head and
 * base, and reported `mergeable: false` by GitHub. Never starts a session.
 * The journal is keyed by repository and PR, with one entry per head/base
 * pair, so redeliveries, races and restarts cannot repeat or reset it.
 */
export class GitHubMergeConflictRouter {
	private readonly active = new Set<string>();
	private readonly activeSessions = new Set<string>();
	constructor(private readonly deps: MergeConflictRouterDependencies) {}

	async handle(
		hint: GitHubMergeConflictHint,
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
					`https://github.com/${hint.repository.fullName}`.toLowerCase(),
		);
		if (repositories.length !== 1) return { outcome: "repository_not_unique" };
		const repository = repositories[0]!;
		const token = await this.deps.token(repository, forwarded);
		if (!token)
			throw new Error("Merge conflict GitHub credentials unavailable");
		const request = async <T>(path: string): Promise<T> => {
			const response = await (this.deps.fetch ?? fetch)(
				`https://api.github.com/repos/${hint.repository.fullName}${path}`,
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
				throw new Error(
					`Merge conflict GitHub lookup failed (${response.status})`,
				);
			return (await response.json()) as T;
		};
		const remote = await request<{ id: number }>("");
		if (remote.id !== hint.repository.id)
			return { outcome: "repository_identity_mismatch" };
		let branch = "";
		/** Re-reads the PR; returns why not to act, or null with `branch` set. */
		const current = async (): Promise<string | null> => {
			const pr = await request<Pull>(`/pulls/${hint.pullRequest.number}`);
			if (
				pr.number !== hint.pullRequest.number ||
				pr.state !== "open" ||
				pr.draft === true ||
				pr.base.repo.id !== remote.id ||
				pr.head.repo?.id !== remote.id
			)
				return "not_open_or_fork";
			if (
				pr.head.sha !== hint.pullRequest.headSha ||
				pr.base.sha !== hint.pullRequest.baseSha
			)
				return "superseded";
			if (pr.mergeable === null) return "mergeability_unknown";
			if (pr.mergeable !== false) return "not_conflicted";
			branch = pr.head.ref;
			return null;
		};
		const stale = await current();
		if (stale) return { outcome: stale };
		const sessions = this.deps
			.sessions()
			.filter((session) =>
				session.repositories.some(
					(context) =>
						context.repositoryId === repository.id &&
						context.branchName === branch,
				),
			);
		if (sessions.length !== 1)
			return {
				outcome: sessions.length ? "ambiguous_session" : "session_not_found",
			};
		const session = sessions[0]!;
		const key = createHash("sha256")
			.update(`${remote.id}:${hint.pullRequest.number}`)
			.digest("hex");
		const dir = join(this.deps.home, "merge-conflict-dispatch", key);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const lock = join(dir, "lock");
		await mkdir(lock); // Atomic across processes; contention is retryable, not success.
		try {
			const path = join(
				dir,
				`${hint.pullRequest.headSha}-${hint.pullRequest.baseSha}.json`,
			);
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
					throw new Error(
						"Merge conflict dispatch needs operator reconciliation",
					);
				return { outcome: "duplicate_revision", sessionId: session.id };
			}
			if (
				(await readdir(dir)).filter((name) => name.endsWith(".json")).length >=
				ATTEMPT_LIMIT
			)
				return { outcome: "automatic_attempt_limit", sessionId: session.id };
			const prompt = buildGitHubMergeConflictPrompt(hint);
			if (this.activeSessions.has(session.id))
				throw new Error("Merge conflict session already reserved");
			this.activeSessions.add(session.id);
			let dispatched = false;
			try {
				const start = await this.deps.prepare(session, repository, prompt);
				// Recheck after preparation and before reservation/dispatch.
				const recheck = await current();
				if (recheck) return { outcome: recheck };
				if (!this.deps.enabled()) return { outcome: "disabled" };
				const entry = {
					sessionId: session.id,
					repositoryId: remote.id,
					pr: hint.pullRequest.number,
					headSha: hint.pullRequest.headSha,
					baseSha: hint.pullRequest.baseSha,
					createdAt: new Date().toISOString(),
				};
				const save = async (state: string) => {
					await writeFile(`${path}.tmp`, JSON.stringify({ ...entry, state }), {
						mode: 0o600,
					});
					await rename(`${path}.tmp`, path);
				};
				// A crash after reservation is not replayed automatically: the agent
				// may have acted. No exactly-once transaction exists with a runner.
				await save("dispatching");
				if (!this.deps.enabled()) {
					await unlink(path);
					return { outcome: "disabled" };
				}
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
}
