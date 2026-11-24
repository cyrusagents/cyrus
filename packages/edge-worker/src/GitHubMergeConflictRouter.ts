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
import type { GitHubMergeConflictEvent } from "cyrus-github-event-transport";
import { buildGitHubMergeConflictPrompt } from "./prompts/githubMergeConflictPrompt.js";

type Pull = {
	number: number;
	state: string;
	draft?: boolean;
	head: { sha: string; ref: string; repo: { id: number } | null };
	base: { sha: string; ref: string; repo: { id: number } };
	/** GitHub computes this lazily: `null` means unknown and never counts. */
	mergeable: boolean | null;
};

export interface MergeConflictRouterDependencies {
	home: string;
	/** Live configuration; an omitted setting is disabled. */
	enabled: () => boolean;
	repositories: () => RepositoryConfig[];
	sessions: () => CyrusAgentSession[];
	/** This runtime's authorized GitHub credential for the repository. */
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
	/** Background check failures (credentials, GitHub, journal). */
	onCheckError: (error: unknown) => void;
	fetch?: typeof fetch;
	sleep?: (ms: number) => Promise<void>;
}

/** Automatic follow-ups per pull request, across head and base revisions. */
const ATTEMPT_LIMIT = 3;
/** Owned branches checked for one base push. */
const PUSH_BRANCH_LIMIT = 10;
/** Waits before each read: GitHub computes mergeability after it is asked. */
export const MERGEABILITY_DELAYS_MS = [0, 2000, 4000, 8000];

/**
 * Continues the one existing session that owns a conflicted PR's branch, on
 * standard `pull_request` and base-branch `push` events. GitHub has no
 * conflict webhook, so the event is only a reason to look. Ownership is this
 * runtime's own sessions: a PR is considered only if its head branch is the
 * branch of exactly one known session for that repository, and it is the
 * only open same-repository PR from that branch. Never starts a session.
 *
 * `receive` does only local checks and queues the GitHub work, so ordinary
 * webhook handling is not delayed. The journal is keyed by repository and PR,
 * one entry per head/base pair, so redeliveries, races and restarts cannot
 * repeat or reset it.
 */
export class GitHubMergeConflictRouter {
	private readonly active = new Set<string>();
	private readonly activeSessions = new Set<string>();
	/** Repository/PR checks in progress, so one push and its PR events coalesce. */
	private readonly inFlight = new Set<string>();
	constructor(private readonly deps: MergeConflictRouterDependencies) {}

	async receive(
		event: GitHubMergeConflictEvent,
		forwarded?: string,
	): Promise<{ outcome: string }> {
		if (!this.deps.enabled()) return { outcome: "disabled" };
		const repositories = this.deps.repositories().filter(
			(repo) =>
				repo.isActive !== false &&
				repo.githubUrl
					?.toLowerCase()
					.replace(/\/$/, "")
					.replace(/\.git$/, "") ===
					`https://github.com/${event.repository.fullName}`.toLowerCase(),
		);
		if (repositories.length !== 1) return { outcome: "repository_not_unique" };
		const repository = repositories[0]!;
		const owned = this.ownedBranches(repository);
		if (!owned.size) return { outcome: "session_not_found" };
		if (event.kind === "pull_request" && !owned.has(event.headRef))
			return { outcome: "not_owned" };
		const key =
			event.kind === "pull_request"
				? `${event.repository.id}:pr:${event.number}`
				: `${event.repository.id}:push:${event.baseRef}`;
		if (this.inFlight.has(key)) return { outcome: "in_flight" };
		this.inFlight.add(key);
		void this.check(event, repository, forwarded)
			.catch((error) => this.deps.onCheckError(error))
			.finally(() => this.inFlight.delete(key));
		return { outcome: "queued" };
	}

	/** Branches of this runtime's known sessions for the repository. */
	private ownedBranches(repository: RepositoryConfig): Set<string> {
		const branches = new Set<string>();
		for (const session of this.deps.sessions())
			for (const context of session.repositories)
				if (context.repositoryId === repository.id && context.branchName)
					branches.add(context.branchName);
		return branches;
	}

	/** Exactly one known session owns the branch, or none is used. */
	private owner(
		repository: RepositoryConfig,
		branch: string,
	): CyrusAgentSession | null {
		const sessions = this.deps
			.sessions()
			.filter((session) =>
				session.repositories.some(
					(context) =>
						context.repositoryId === repository.id &&
						context.branchName === branch,
				),
			);
		return sessions.length === 1 ? sessions[0]! : null;
	}

	/** Background: credentials, GitHub reads and, for a conflict, dispatch. */
	async check(
		event: GitHubMergeConflictEvent,
		repository: RepositoryConfig,
		forwarded?: string,
	): Promise<Record<number, string>> {
		const token = await this.deps.token(repository, forwarded);
		if (!token)
			throw new Error("Merge conflict GitHub credentials unavailable");
		const request = async <T>(path: string): Promise<T> => {
			const response = await (this.deps.fetch ?? fetch)(
				`https://api.github.com/repos/${event.repository.fullName}${path}`,
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
		if (remote.id !== event.repository.id)
			return { 0: "repository_identity_mismatch" };
		const owner = event.repository.fullName.split("/")[0]!;
		/** Open same-repository PRs from a branch; at most two are needed. */
		const openFrom = (branch: string, base?: string) =>
			request<Pull[]>(
				`/pulls?state=open&head=${encodeURIComponent(`${owner}:${branch}`)}${
					base ? `&base=${encodeURIComponent(base)}` : ""
				}&per_page=2`,
			);

		let numbers: number[];
		if (event.kind === "pull_request") numbers = [event.number];
		else {
			// Scoped to branches this runtime's sessions own, never all open PRs.
			const branches = [...this.ownedBranches(repository)]
				.filter((branch) => branch !== event.baseRef)
				.slice(0, PUSH_BRANCH_LIMIT);
			numbers = [];
			for (const branch of branches)
				for (const pr of await openFrom(branch, event.baseRef))
					numbers.push(pr.number);
		}
		const results: Record<number, string> = {};
		for (const number of numbers)
			results[number] = await this.checkPull(
				number,
				event,
				repository,
				remote.id,
				request,
				openFrom,
			);
		return results;
	}

	private async checkPull(
		number: number,
		event: GitHubMergeConflictEvent,
		repository: RepositoryConfig,
		repositoryId: number,
		request: <T>(path: string) => Promise<T>,
		openFrom: (branch: string, base?: string) => Promise<Pull[]>,
	): Promise<string> {
		/** Current state only: why not to act, or the PR to act on. */
		const current = async (): Promise<string | Pull> => {
			const pr = await request<Pull>(`/pulls/${number}`);
			if (
				pr.number !== number ||
				pr.state !== "open" ||
				pr.draft === true ||
				pr.base.repo.id !== repositoryId ||
				pr.head.repo?.id !== repositoryId ||
				(event.kind === "push" && pr.base.ref !== event.baseRef)
			)
				return "not_open_or_fork";
			return pr;
		};
		let pr: Pull | undefined;
		for (const delay of MERGEABILITY_DELAYS_MS) {
			if (delay) await (this.deps.sleep ?? defaultSleep)(delay);
			const read = await current();
			if (typeof read === "string") return read;
			if (read.mergeable === true) return "not_conflicted";
			if (read.mergeable === false) {
				pr = read;
				break;
			}
		}
		if (!pr) return "mergeability_unknown";
		// One session owns the branch, and that branch has only this open PR:
		// otherwise the session cannot be tied to this PR.
		const session = this.owner(repository, pr.head.ref);
		if (!session) return "session_not_found_or_ambiguous";
		const siblings = await openFrom(pr.head.ref);
		if (siblings.length !== 1 || siblings[0]!.number !== number)
			return "ambiguous_pull";
		return this.dispatch(
			pr,
			event,
			repository,
			repositoryId,
			session,
			async () => {
				const again = await current();
				if (typeof again === "string") return again;
				if (again.head.sha !== pr.head.sha || again.base.sha !== pr.base.sha)
					return "superseded";
				if (again.mergeable !== false) return "not_conflicted";
				return null;
			},
		);
	}

	private async dispatch(
		pr: Pull,
		event: GitHubMergeConflictEvent,
		repository: RepositoryConfig,
		repositoryId: number,
		session: CyrusAgentSession,
		recheck: () => Promise<string | null>,
	): Promise<string> {
		const key = createHash("sha256")
			.update(`${repositoryId}:${pr.number}`)
			.digest("hex");
		const dir = join(this.deps.home, "merge-conflict-dispatch", key);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const lock = join(dir, "lock");
		await mkdir(lock); // Atomic across processes; contention is retryable, not success.
		try {
			const path = join(dir, `${pr.head.sha}-${pr.base.sha}.json`);
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
				return "duplicate_revision";
			}
			if (
				(await readdir(dir)).filter((name) => name.endsWith(".json")).length >=
				ATTEMPT_LIMIT
			)
				return "automatic_attempt_limit";
			const prompt = buildGitHubMergeConflictPrompt({
				repository: event.repository.fullName,
				number: pr.number,
				headSha: pr.head.sha,
				baseSha: pr.base.sha,
			});
			if (this.activeSessions.has(session.id))
				throw new Error("Merge conflict session already reserved");
			this.activeSessions.add(session.id);
			let dispatched = false;
			try {
				const start = await this.deps.prepare(session, repository, prompt);
				// Recheck after preparation and before reservation/dispatch.
				const stale = await recheck();
				if (stale) return stale;
				if (!this.deps.enabled()) return "disabled";
				const entry = {
					sessionId: session.id,
					repositoryId,
					pr: pr.number,
					headSha: pr.head.sha,
					baseSha: pr.base.sha,
					event: event.kind,
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
					return "disabled";
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
				return "accepted";
			} finally {
				if (!dispatched) this.activeSessions.delete(session.id);
			}
		} finally {
			await rmdir(lock);
		}
	}
}

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
