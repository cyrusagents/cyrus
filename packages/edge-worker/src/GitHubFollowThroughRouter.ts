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
import type {
	CyrusAgentSession,
	PullRequestBranchFreshness,
	RepositoryConfig,
} from "cyrus-core";
import type {
	FollowThroughAdmission,
	GitHubFollowThroughEvent,
} from "cyrus-github-event-transport";
import {
	buildGitHubBranchFreshnessPrompt,
	buildGitHubMergeConflictPrompt,
} from "./prompts/githubFollowThroughPrompts.js";

type Pull = {
	number: number;
	state: string;
	draft?: boolean;
	head: { sha: string; ref: string; repo: { id: number } | null };
	base: { sha: string; ref: string; repo: { id: number } };
	/** GitHub computes this lazily: `null` means unknown and never counts. */
	mergeable: boolean | null;
};

export interface FollowThroughRouterDependencies {
	home: string;
	/** Live `mergeConflictTrigger`; an omitted setting is disabled. */
	conflictsEnabled: () => boolean;
	/** Live `prBranchFreshness`; an omitted setting is "off". */
	freshness: () => PullRequestBranchFreshness;
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

/** What may run for one delivery: live config, limited by Hosted admission. */
type Effective = {
	conflicts: boolean;
	freshness: PullRequestBranchFreshness;
};

/** Automatic follow-ups per pull request, across head and base revisions. */
const ATTEMPT_LIMIT = 3;
/** Owned branches checked for one base push. */
const PUSH_BRANCH_LIMIT = 10;
/** Waits before each read: GitHub computes mergeability after it is asked. */
export const MERGEABILITY_DELAYS_MS = [0, 2000, 4000, 8000];
/** Retries for the journal lock held by a concurrent check of the same PR. */
const LOCK_RETRIES_MS = [50, 100, 200, 400];
const SHA = /^[0-9a-f]{40}$/;

type Action =
	| { kind: "conflict"; strategy: "merge" | "rebase" }
	| { kind: "freshness"; strategy: "merge" | "rebase"; behindBy: number };

/**
 * PR follow-through on standard `pull_request` and base-branch `push`
 * events. GitHub has no conflict or "base moved" event, so an event is only a
 * reason to re-read pull requests this runtime's own sessions own: a PR is
 * considered only if its head branch is the branch of exactly one known
 * session for that repository, and it is that branch's only open
 * same-repository PR. Never starts a session; never writes to GitHub.
 *
 * - Merge conflicts (`mergeConflictTrigger`): PR and push events. Only
 *   `mergeable: false` counts; the prompt uses the freshness strategy, or a
 *   safe merge when freshness is off.
 * - Branch freshness (`prBranchFreshness`): base pushes only. Only a
 *   mergeable PR that GitHub's compare shows behind its pinned base gets a
 *   merge or rebase prompt. A conflicted or unknown PR is never handed to
 *   freshness. Off sends no base-moved prompt at all.
 *
 * One journal entry per head/base pair, shared by both, so a PR gets at most
 * one prompt per revision pair, and three in total.
 */
export class GitHubFollowThroughRouter {
	private readonly active = new Set<string>();
	private readonly activeSessions = new Set<string>();
	/**
	 * Checks in progress. A newer event for the same key while one runs is
	 * kept (latest wins) and checked once that run ends, so it is not lost.
	 */
	private readonly inFlight = new Map<string, (() => void) | null>();
	constructor(private readonly deps: FollowThroughRouterDependencies) {}

	/** Live config, limited by Hosted's admission when proxied. */
	private effective(admission?: FollowThroughAdmission): Effective {
		const local = this.deps.freshness();
		const freshness =
			local === "off" || (admission && admission.freshness === "off")
				? "off"
				: // Hosted's admission reflects its current setting.
					(admission?.freshness ?? local);
		return {
			conflicts: this.deps.conflictsEnabled() && (admission?.conflicts ?? true),
			freshness,
		};
	}

	async receive(
		event: GitHubFollowThroughEvent,
		context: { installationToken?: string; admission?: FollowThroughAdmission },
	): Promise<{ outcome: string }> {
		const effective = this.effective(context.admission);
		if (
			event.kind === "pull_request"
				? !effective.conflicts
				: !effective.conflicts && effective.freshness === "off"
		)
			return { outcome: "disabled" };
		const repository = this.repository(event);
		if (!repository) return { outcome: "repository_not_unique" };
		const owned = this.ownedBranches(repository);
		if (!owned.size) return { outcome: "session_not_found" };
		if (event.kind === "pull_request" && !owned.has(event.headRef))
			return { outcome: "not_owned" };
		const key =
			event.kind === "pull_request"
				? `${event.repository.id}:pr:${event.number}`
				: `${event.repository.id}:push:${event.baseRef}`;
		const run = () => {
			this.inFlight.set(key, null);
			void this.check(event, repository, context)
				.catch((error) => this.deps.onCheckError(error))
				.finally(() => {
					const next = this.inFlight.get(key);
					this.inFlight.delete(key);
					next?.();
				});
		};
		if (this.inFlight.has(key)) {
			this.inFlight.set(key, () => void this.receive(event, context));
			return { outcome: "queued" };
		}
		run();
		return { outcome: "queued" };
	}

	private repository(event: GitHubFollowThroughEvent): RepositoryConfig | null {
		const repositories = this.deps.repositories().filter(
			(repo) =>
				repo.isActive !== false &&
				repo.githubUrl
					?.toLowerCase()
					.replace(/\/$/, "")
					.replace(/\.git$/, "") ===
					`https://github.com/${event.repository.fullName}`.toLowerCase(),
		);
		return repositories.length === 1 ? repositories[0]! : null;
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

	/** Background: credentials, GitHub reads and, if warranted, one dispatch. */
	async check(
		event: GitHubFollowThroughEvent,
		repository: RepositoryConfig,
		context: { installationToken?: string; admission?: FollowThroughAdmission },
	): Promise<Record<number, string>> {
		const token = await this.deps.token(repository, context.installationToken);
		if (!token)
			throw new Error("PR follow-through GitHub credentials unavailable");
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
					`PR follow-through GitHub lookup failed (${response.status})`,
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
				context.admission,
				request,
				openFrom,
			);
		return results;
	}

	private async checkPull(
		number: number,
		event: GitHubFollowThroughEvent,
		repository: RepositoryConfig,
		repositoryId: number,
		admission: FollowThroughAdmission | undefined,
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
			// Provider SHAs become journal paths and prompt pins.
			if (!SHA.test(pr.head.sha) || !SHA.test(pr.base.sha))
				return "invalid_revision";
			return pr;
		};
		/** How far the pinned head is behind the pinned base. */
		const behindBy = async (pr: Pull): Promise<number> => {
			const compare = await request<{ ahead_by?: unknown }>(
				`/compare/${pr.head.sha}...${pr.base.sha}`,
			);
			return Number.isSafeInteger(compare.ahead_by)
				? (compare.ahead_by as number)
				: 0;
		};
		/** Decide from current state, with the live settings at this moment. */
		const decide = async (pr: Pull): Promise<string | Action> => {
			const effective = this.effective(admission);
			const strategy =
				effective.freshness === "off" ? "merge" : effective.freshness;
			if (pr.mergeable === false)
				return effective.conflicts
					? { kind: "conflict", strategy }
					: // Never use freshness to resolve a conflict.
						"conflict_handling_disabled";
			if (event.kind !== "push" || effective.freshness === "off")
				return "not_conflicted";
			const behind = await behindBy(pr);
			if (behind <= 0) return "up_to_date";
			return { kind: "freshness", strategy, behindBy: behind };
		};

		let pr: Pull | undefined;
		for (const delay of MERGEABILITY_DELAYS_MS) {
			if (delay) await (this.deps.sleep ?? defaultSleep)(delay);
			const read = await current();
			if (typeof read === "string") return read;
			if (read.mergeable !== null) {
				pr = read;
				break;
			}
		}
		// Unknown is neither a conflict nor safe to refresh.
		if (!pr) return "mergeability_unknown";
		const action = await decide(pr);
		if (typeof action === "string") return action;
		// One session owns the branch, and that branch has only this open PR:
		// otherwise the session cannot be tied to this PR.
		const session = this.owner(repository, pr.head.ref);
		if (!session) return "session_not_found_or_ambiguous";
		const siblings = await openFrom(pr.head.ref);
		if (siblings.length !== 1 || siblings[0]!.number !== number)
			return "ambiguous_pull";
		const pinned = pr;
		return this.dispatch(
			pinned,
			action,
			event,
			repository,
			repositoryId,
			session,
			async () => {
				const again = await current();
				if (typeof again === "string") return again;
				if (
					again.head.sha !== pinned.head.sha ||
					again.base.sha !== pinned.base.sha
				)
					return "superseded";
				const still = await decide(again);
				if (typeof still === "string") return still;
				return still.kind === action.kind ? null : "superseded";
			},
		);
	}

	private async lock(path: string): Promise<void> {
		for (const wait of [...LOCK_RETRIES_MS, null]) {
			try {
				await mkdir(path);
				return;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST" || wait === null)
					throw error;
				await new Promise((resolve) => setTimeout(resolve, wait));
			}
		}
	}

	private async dispatch(
		pr: Pull,
		action: Action,
		event: GitHubFollowThroughEvent,
		repository: RepositoryConfig,
		repositoryId: number,
		session: CyrusAgentSession,
		recheck: () => Promise<string | null>,
	): Promise<string> {
		const key = createHash("sha256")
			.update(`${repositoryId}:${pr.number}`)
			.digest("hex");
		// The directory name is unchanged so existing journals keep counting.
		const dir = join(this.deps.home, "merge-conflict-dispatch", key);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const lock = join(dir, "lock");
		await this.lock(lock); // Atomic across processes.
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
						"PR follow-through dispatch needs operator reconciliation",
					);
				return "duplicate_revision";
			}
			if (
				(await readdir(dir)).filter((name) => name.endsWith(".json")).length >=
				ATTEMPT_LIMIT
			)
				return "automatic_attempt_limit";
			const input = {
				repository: event.repository.fullName,
				number: pr.number,
				headSha: pr.head.sha,
				baseSha: pr.base.sha,
				strategy: action.strategy,
			};
			const prompt =
				action.kind === "conflict"
					? buildGitHubMergeConflictPrompt(input)
					: buildGitHubBranchFreshnessPrompt({
							...input,
							behindBy: action.behindBy,
						});
			if (this.activeSessions.has(session.id))
				throw new Error("PR follow-through session already reserved");
			this.activeSessions.add(session.id);
			let dispatched = false;
			try {
				const start = await this.deps.prepare(session, repository, prompt);
				// Recheck after preparation and before reservation/dispatch.
				const stale = await recheck();
				if (stale) return stale;
				const entry = {
					sessionId: session.id,
					repositoryId,
					pr: pr.number,
					headSha: pr.head.sha,
					baseSha: pr.base.sha,
					kind: action.kind,
					strategy: action.strategy,
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
				// Settings can change while preparing: recheck before scheduling.
				const now = await recheck();
				if (now) {
					await unlink(path);
					return now;
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
