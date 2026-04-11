/**
 * PRFeedbackLoopService
 *
 * Polls GitHub API every 15 minutes for new review comments on Cyrus-created PRs
 * and triggers implementation sessions for actionable feedback.
 *
 * Flow:
 * 1. Every 15 minutes, list open PRs for all configured repos
 * 2. Filter for Cyrus-created branches (cyrus/*, cyrus2/*, paul/bri-*)
 * 3. For each PR, get new comments from non-bot users
 * 4. Skip approvals (LGTM, "looks good", etc.) — mark as processed
 * 5. For remaining comments → call onFeedback(PRFeedbackEvent, repoConfig)
 * 6. Track max 3 cycles per PR before flagging for manual intervention
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ILogger, RepositoryConfig } from "cyrus-core";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface PRFeedbackComment {
	id: number;
	body: string;
	html_url: string;
	user: { login: string };
	created_at: string;
	/** Review comments only: the file being commented on */
	path?: string;
	/** Review comments only: diff hunk context */
	diff_hunk?: string;
	/** Review comments only: line number in the file */
	line?: number;
	/** Whether this is an inline review comment or a general PR comment */
	type: "review_comment" | "issue_comment";
}

export interface PRFeedbackEvent {
	owner: string;
	repo: string;
	prNumber: number;
	prTitle: string;
	branchRef: string;
	baseBranchRef: string;
	comments: PRFeedbackComment[];
	/** GitHub token to use for posting replies (may be undefined if not configured) */
	token: string | undefined;
}

export type PRFeedbackHandler = (
	event: PRFeedbackEvent,
	repoConfig: RepositoryConfig,
) => Promise<void>;

export type PRCommentPoster = (
	owner: string,
	repo: string,
	prNumber: number,
	body: string,
	token: string | undefined,
) => Promise<void>;

export interface PRFeedbackLoopConfig {
	/** GitHub personal access token for API calls */
	githubToken: string | undefined;
	/** Repositories to monitor */
	repositories: RepositoryConfig[];
	/** Cyrus home directory (for state file) */
	cyrusHome: string;
	/** Called when new actionable comments are found on a Cyrus PR */
	onFeedback: PRFeedbackHandler;
	/** Used to post system comments (e.g., max-cycle warning) directly */
	postComment: PRCommentPoster;
	/** Poll interval in milliseconds (default: 15 minutes) */
	pollIntervalMs?: number;
	/** Max automated feedback cycles per PR before escalating (default: 3) */
	maxCyclesPerPR?: number;
	/** GitHub username of the bot (falls back to GITHUB_BOT_USERNAME env var) */
	botLogin?: string;
	/**
	 * Minimum age of a comment (ms) before processing it.
	 * Gives time for webhooks to fire first (default: 2 minutes).
	 */
	minCommentAgeMs?: number;
	logger: ILogger;
}

// ---------------------------------------------------------------------------
// Internal state schema (persisted to ~/.cyrus/pr-feedback-state.json)
// ---------------------------------------------------------------------------

interface PRState {
	cycleCount: number;
	processedCommentIds: number[];
	flaggedForManualIntervention: boolean;
}

interface PRFeedbackState {
	version: 1;
	/** Key: "owner/repo#prNumber" */
	prs: Record<string, PRState>;
}

// ---------------------------------------------------------------------------
// GitHub API response shapes (minimal)
// ---------------------------------------------------------------------------

interface GitHubPRListItem {
	number: number;
	title: string;
	head: { ref: string };
	base: { ref: string };
	state: string;
}

interface GitHubCommentApiResponse {
	id: number;
	body: string;
	html_url: string;
	user: { login: string };
	created_at: string;
	path?: string;
	diff_hunk?: string;
	line?: number;
}

// ---------------------------------------------------------------------------
// Branch / approval heuristics
// ---------------------------------------------------------------------------

/** Patterns identifying Cyrus-created PR branches */
const CYRUS_BRANCH_PATTERNS = [/^cyrus\d*\//, /^paul\/bri-/];

/** Patterns indicating a pure approval comment — skip these */
const APPROVAL_PATTERNS = [
	/\blgtm\b/i,
	/\blooks?\s+good\b/i,
	/\bapproved?\b/i,
	/\bnice\s+(?:work|one)\b/i,
	/\bgreat\s+(?:work|job|stuff)\b/i,
	/\bship\s+it\b/i,
	/^👍+\s*$/,
	/^✓\s*$/,
	/\bwfm\b/i, // "works for me"
];

function isCyrusBranch(branchRef: string): boolean {
	return CYRUS_BRANCH_PATTERNS.some((p) => p.test(branchRef));
}

function isApprovalComment(body: string): boolean {
	const trimmed = body.trim();
	return APPROVAL_PATTERNS.some((p) => p.test(trimmed));
}

// ---------------------------------------------------------------------------
// PRFeedbackLoopService
// ---------------------------------------------------------------------------

export class PRFeedbackLoopService {
	private readonly config: PRFeedbackLoopConfig;
	private readonly logger: ILogger;
	private readonly stateFilePath: string;
	private state: PRFeedbackState = { version: 1, prs: {} };
	private intervalHandle: ReturnType<typeof setInterval> | null = null;
	private isPolling = false;

	constructor(config: PRFeedbackLoopConfig) {
		this.config = config;
		this.logger = config.logger;
		this.stateFilePath = join(config.cyrusHome, "pr-feedback-state.json");
	}

	// ---------------------------------------------------------------------------
	// Lifecycle
	// ---------------------------------------------------------------------------

	async start(): Promise<void> {
		await this.loadState();

		const intervalMs = this.config.pollIntervalMs ?? 15 * 60 * 1000;
		this.logger.info(
			`[PRFeedbackLoop] Starting — polling every ${intervalMs / 60000} min`,
		);

		// Run an initial poll immediately (non-blocking)
		this.poll().catch((err: unknown) => {
			this.logger.error(
				"[PRFeedbackLoop] Error in initial poll",
				err instanceof Error ? err : new Error(String(err)),
			);
		});

		this.intervalHandle = setInterval(() => {
			this.poll().catch((err: unknown) => {
				this.logger.error(
					"[PRFeedbackLoop] Error in scheduled poll",
					err instanceof Error ? err : new Error(String(err)),
				);
			});
		}, intervalMs);
	}

	stop(): void {
		if (this.intervalHandle !== null) {
			clearInterval(this.intervalHandle);
			this.intervalHandle = null;
		}
		this.logger.info("[PRFeedbackLoop] Stopped");
	}

	// ---------------------------------------------------------------------------
	// Poll cycle
	// ---------------------------------------------------------------------------

	private async poll(): Promise<void> {
		if (this.isPolling) {
			this.logger.debug(
				"[PRFeedbackLoop] Skipping poll — previous cycle still running",
			);
			return;
		}
		this.isPolling = true;
		try {
			this.logger.info("[PRFeedbackLoop] Poll cycle starting");
			for (const repo of this.config.repositories) {
				if (!repo.githubUrl) continue;
				try {
					await this.processRepository(repo);
				} catch (err: unknown) {
					this.logger.error(
						`[PRFeedbackLoop] Error processing repo ${repo.name}`,
						err instanceof Error ? err : new Error(String(err)),
					);
				}
			}
			this.logger.info("[PRFeedbackLoop] Poll cycle complete");
		} finally {
			this.isPolling = false;
		}
	}

	// ---------------------------------------------------------------------------
	// Repository processing
	// ---------------------------------------------------------------------------

	private async processRepository(repoConfig: RepositoryConfig): Promise<void> {
		const parsed = this.parseGitHubUrl(repoConfig.githubUrl!);
		if (!parsed) {
			this.logger.warn(
				`[PRFeedbackLoop] Could not parse GitHub URL: ${repoConfig.githubUrl}`,
			);
			return;
		}
		const { owner, repo } = parsed;

		let prs: GitHubPRListItem[];
		try {
			prs = await this.listOpenPRs(owner, repo);
		} catch (err: unknown) {
			this.logger.warn(
				`[PRFeedbackLoop] Failed to list PRs for ${owner}/${repo}: ${err instanceof Error ? err.message : err}`,
			);
			return;
		}

		const cyrusPRs = prs.filter((pr) => isCyrusBranch(pr.head.ref));
		if (cyrusPRs.length > 0) {
			this.logger.debug(
				`[PRFeedbackLoop] ${owner}/${repo}: ${cyrusPRs.length} Cyrus PR(s) open`,
			);
		}

		for (const pr of cyrusPRs) {
			try {
				await this.processPR(owner, repo, pr, repoConfig);
			} catch (err: unknown) {
				this.logger.error(
					`[PRFeedbackLoop] Error processing ${owner}/${repo}#${pr.number}`,
					err instanceof Error ? err : new Error(String(err)),
				);
			}
		}
	}

	// ---------------------------------------------------------------------------
	// PR processing
	// ---------------------------------------------------------------------------

	private async processPR(
		owner: string,
		repo: string,
		pr: GitHubPRListItem,
		repoConfig: RepositoryConfig,
	): Promise<void> {
		const prKey = `${owner}/${repo}#${pr.number}`;
		const prState: PRState = this.state.prs[prKey] ?? {
			cycleCount: 0,
			processedCommentIds: [],
			flaggedForManualIntervention: false,
		};
		const maxCycles = this.config.maxCyclesPerPR ?? 3;

		// Already at max cycles — flag once then stop
		if (prState.cycleCount >= maxCycles) {
			if (!prState.flaggedForManualIntervention) {
				this.logger.warn(
					`[PRFeedbackLoop] ${prKey} reached max cycles (${maxCycles}), flagging`,
				);
				await this.config.postComment(
					owner,
					repo,
					pr.number,
					`⚠️ **Automated review loop limit reached.**\n\nThis PR has gone through ${maxCycles} automated feedback cycles. Please review the remaining comments and handle them manually.`,
					this.config.githubToken,
				);
				prState.flaggedForManualIntervention = true;
				this.state.prs[prKey] = prState;
				await this.saveState();
			}
			return;
		}

		// Fetch all comment types in parallel
		const [reviewComments, issueComments] = await Promise.all([
			this.getReviewComments(owner, repo, pr.number),
			this.getIssueComments(owner, repo, pr.number),
		]);

		const minAgeMs = this.config.minCommentAgeMs ?? 2 * 60 * 1000;
		const now = Date.now();
		const botLogin =
			this.config.botLogin ?? process.env.GITHUB_BOT_USERNAME ?? "";

		const newActionable: PRFeedbackComment[] = [];

		const processRawComment = (
			raw: GitHubCommentApiResponse,
			type: PRFeedbackComment["type"],
		): void => {
			// Already seen
			if (prState.processedCommentIds.includes(raw.id)) return;
			// From bot — skip (and don't mark processed, so it isn't revisited needlessly)
			if (botLogin && raw.user.login === botLogin) {
				prState.processedCommentIds.push(raw.id);
				return;
			}
			// Too recent — let webhook handle it first
			if (now - new Date(raw.created_at).getTime() < minAgeMs) return;
			// Pure approval — mark processed, no action
			if (isApprovalComment(raw.body)) {
				prState.processedCommentIds.push(raw.id);
				return;
			}
			newActionable.push({
				id: raw.id,
				body: raw.body,
				html_url: raw.html_url,
				user: raw.user,
				created_at: raw.created_at,
				path: raw.path,
				diff_hunk: raw.diff_hunk,
				line: raw.line,
				type,
			});
		};

		for (const c of reviewComments) processRawComment(c, "review_comment");
		for (const c of issueComments) processRawComment(c, "issue_comment");

		// If we only processed approvals/bots, save and return
		if (newActionable.length === 0) {
			this.state.prs[prKey] = prState;
			await this.saveState();
			return;
		}

		this.logger.info(
			`[PRFeedbackLoop] ${prKey}: ${newActionable.length} new comment(s) — starting cycle ${prState.cycleCount + 1}/${maxCycles}`,
		);

		const feedbackEvent: PRFeedbackEvent = {
			owner,
			repo,
			prNumber: pr.number,
			prTitle: pr.title,
			branchRef: pr.head.ref,
			baseBranchRef: pr.base.ref,
			comments: newActionable,
			token: this.config.githubToken,
		};

		await this.config.onFeedback(feedbackEvent, repoConfig);

		// Mark all new comments as processed and increment cycle count
		for (const c of newActionable) {
			prState.processedCommentIds.push(c.id);
		}
		prState.cycleCount++;
		this.state.prs[prKey] = prState;
		await this.saveState();
	}

	// ---------------------------------------------------------------------------
	// GitHub API helpers
	// ---------------------------------------------------------------------------

	private async listOpenPRs(
		owner: string,
		repo: string,
	): Promise<GitHubPRListItem[]> {
		const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=100`;
		const res = await this.githubFetch(url);
		if (!res.ok) {
			if (res.status === 404) {
				this.logger.debug(
					`[PRFeedbackLoop] ${owner}/${repo}: not found or no access`,
				);
				return [];
			}
			throw new Error(`GitHub API ${res.status} listing PRs for ${owner}/${repo}`);
		}
		return (await res.json()) as GitHubPRListItem[];
	}

	private async getReviewComments(
		owner: string,
		repo: string,
		prNumber: number,
	): Promise<GitHubCommentApiResponse[]> {
		const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`;
		const res = await this.githubFetch(url);
		if (!res.ok) {
			throw new Error(
				`GitHub API ${res.status} getting review comments for ${owner}/${repo}#${prNumber}`,
			);
		}
		return (await res.json()) as GitHubCommentApiResponse[];
	}

	private async getIssueComments(
		owner: string,
		repo: string,
		prNumber: number,
	): Promise<GitHubCommentApiResponse[]> {
		const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`;
		const res = await this.githubFetch(url);
		if (!res.ok) {
			throw new Error(
				`GitHub API ${res.status} getting issue comments for ${owner}/${repo}#${prNumber}`,
			);
		}
		return (await res.json()) as GitHubCommentApiResponse[];
	}

	private githubFetch(url: string): Promise<Response> {
		const headers: Record<string, string> = {
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
		};
		if (this.config.githubToken) {
			headers.Authorization = `Bearer ${this.config.githubToken}`;
		}
		return fetch(url, { headers });
	}

	// ---------------------------------------------------------------------------
	// State persistence
	// ---------------------------------------------------------------------------

	private async loadState(): Promise<void> {
		try {
			const raw = await readFile(this.stateFilePath, "utf-8");
			const parsed = JSON.parse(raw) as PRFeedbackState;
			if (parsed.version === 1 && parsed.prs) {
				this.state = parsed;
				this.logger.debug(
					`[PRFeedbackLoop] Loaded state: ${Object.keys(parsed.prs).length} PR(s) tracked`,
				);
			}
		} catch {
			// File doesn't exist yet — start fresh
			this.state = { version: 1, prs: {} };
		}
	}

	private async saveState(): Promise<void> {
		await writeFile(
			this.stateFilePath,
			JSON.stringify(this.state, null, 2),
			"utf-8",
		);
	}

	// ---------------------------------------------------------------------------
	// URL parsing
	// ---------------------------------------------------------------------------

	private parseGitHubUrl(
		githubUrl: string,
	): { owner: string; repo: string } | null {
		// Handles:
		//   https://github.com/owner/repo
		//   git@github.com:owner/repo.git
		//   github.com/owner/repo
		//   owner/repo
		const httpsMatch = githubUrl.match(
			/github\.com[/:]([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/,
		);
		if (httpsMatch) {
			return { owner: httpsMatch[1], repo: httpsMatch[2] };
		}
		const simpleMatch = githubUrl.match(/^([^/]+)\/([^/]+?)(?:\.git)?$/);
		if (simpleMatch) {
			return { owner: simpleMatch[1], repo: simpleMatch[2] };
		}
		return null;
	}
}
