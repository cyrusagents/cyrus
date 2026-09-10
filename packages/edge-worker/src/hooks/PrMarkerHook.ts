import { execFileSync, spawnSync } from "node:child_process";
import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

/**
 * The hidden HTML marker that identifies a PR/MR description as Cyrus-authored.
 * Its presence is what tells our GitHub/GitLab webhook handlers that a
 * "Changes requested" or comment event should be forwarded back to Cyrus.
 */
export const CYRUS_PR_MARKER = "<!-- generated-by-cyrus -->";

/**
 * A PR/MR detected on the branch checked out in the session worktree,
 * read back from the forge right after a PR-mutating command ran.
 */
export interface DetectedPullRequest {
	/** Which forge provider detected it ("github", "gitlab"). */
	provider: string;
	/** PR/MR number on the forge. */
	number: number;
	/** PR/MR title. */
	title: string;
	/** Canonical web URL of the PR/MR. */
	url: string;
	/** Whether the PR is currently a draft. */
	isDraft: boolean;
	/** Source branch of the PR/MR. */
	headBranch: string;
}

/**
 * Provider-specific knowledge about how to detect PR/MR mutating commands and
 * how to read/write the description on the underlying forge. Adding support
 * for a new forge means adding a new provider — no changes to the hook itself.
 */
export interface PrMarkerProvider {
	/** Provider name, used only for log messages. */
	readonly name: string;
	/** Returns true when `command` will create or update a PR/MR via this provider. */
	matches(command: string): boolean;
	/**
	 * Idempotently ensures the marker is present at the end of the live PR/MR
	 * description for the branch checked out at `cwd`. Implementations should
	 * be a no-op when no PR/MR exists yet, or when the marker is already there.
	 */
	ensureMarker(cwd: string, log: ILogger): void;
	/**
	 * Read back the PR/MR for the branch checked out at `cwd`, if one exists.
	 * Optional: providers without it simply never feed the
	 * `onPullRequestDetected` callback.
	 */
	readPullRequest?(cwd: string, log: ILogger): DetectedPullRequest | null;
}

/**
 * Append the marker to a body, preserving a single trailing newline.
 * Idempotent: returns the original body when the marker is already present.
 */
export function appendMarker(body: string | null | undefined): string {
	const current = body ?? "";
	if (current.includes(CYRUS_PR_MARKER)) {
		return current;
	}
	const trimmed = current.replace(/\s+$/, "");
	if (trimmed.length === 0) {
		return CYRUS_PR_MARKER;
	}
	return `${trimmed}\n\n${CYRUS_PR_MARKER}`;
}

/**
 * GitHub provider — uses the `gh` CLI. Also covers `gt submit` (Graphite),
 * which submits via the GitHub API and ends up viewable through `gh pr view`.
 */
export class GitHubPrMarkerProvider implements PrMarkerProvider {
	readonly name = "github";

	matches(command: string): boolean {
		// Strip surrounding shell noise; we only care whether the command line
		// contains a PR-mutating gh/gt invocation.
		return (
			/\bgh\s+pr\s+(create|edit)\b/.test(command) ||
			/\bgt\s+submit\b/.test(command)
		);
	}

	ensureMarker(cwd: string, log: ILogger): void {
		let payload: { body?: string; number?: number };
		try {
			const json = execFileSync("gh", ["pr", "view", "--json", "body,number"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			payload = JSON.parse(json) as { body?: string; number?: number };
		} catch {
			// No PR for this branch yet, gh not authenticated, or not a GitHub
			// repo. Either way, nothing for us to ensure — bail silently.
			return;
		}

		if (typeof payload.number !== "number") {
			return;
		}
		const updated = appendMarker(payload.body);
		if (updated === (payload.body ?? "")) {
			return;
		}

		const result = spawnSync(
			"gh",
			["pr", "edit", String(payload.number), "--body-file", "-"],
			{
				cwd,
				input: updated,
				encoding: "utf8",
				stdio: ["pipe", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] gh pr edit failed for #${payload.number}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return;
		}
		log.info(
			`[PrMarkerHook] Appended Cyrus marker to GitHub PR #${payload.number}`,
		);
	}

	readPullRequest(cwd: string, _log: ILogger): DetectedPullRequest | null {
		try {
			const json = execFileSync(
				"gh",
				["pr", "view", "--json", "number,title,url,isDraft,headRefName"],
				{
					cwd,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			);
			const payload = JSON.parse(json) as {
				number?: number;
				title?: string;
				url?: string;
				isDraft?: boolean;
				headRefName?: string;
			};
			if (typeof payload.number !== "number" || !payload.url) {
				return null;
			}
			return {
				provider: this.name,
				number: payload.number,
				title: payload.title ?? "",
				url: payload.url,
				isDraft: payload.isDraft ?? false,
				headBranch: payload.headRefName ?? "",
			};
		} catch {
			// No PR yet, gh unauthenticated, or not a GitHub repo.
			return null;
		}
	}
}

/**
 * GitLab provider — uses the `glab` CLI.
 */
export class GitLabMrMarkerProvider implements PrMarkerProvider {
	readonly name = "gitlab";

	matches(command: string): boolean {
		return /\bglab\s+mr\s+(create|update|edit)\b/.test(command);
	}

	ensureMarker(cwd: string, log: ILogger): void {
		let payload: { description?: string; iid?: number };
		try {
			const json = execFileSync("glab", ["mr", "view", "--output", "json"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			payload = JSON.parse(json) as { description?: string; iid?: number };
		} catch {
			return;
		}

		if (typeof payload.iid !== "number") {
			return;
		}
		const updated = appendMarker(payload.description);
		if (updated === (payload.description ?? "")) {
			return;
		}

		const result = spawnSync(
			"glab",
			["mr", "update", String(payload.iid), "--description", updated],
			{
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		if (result.status !== 0) {
			log.warn(
				`[PrMarkerHook] glab mr update failed for !${payload.iid}: ${
					result.stderr?.trim() || "unknown error"
				}`,
			);
			return;
		}
		log.info(
			`[PrMarkerHook] Appended Cyrus marker to GitLab MR !${payload.iid}`,
		);
	}
}

/**
 * Build the PostToolUse hook that ensures Cyrus's identifying marker is
 * present on every PR/MR Cyrus creates or updates.
 *
 * Wired alongside the screenshot/stop hooks in RunnerConfigBuilder. Designed
 * around the strategy pattern: `providers` is injectable so tests can stub
 * forge interactions and so new forges can be added without touching this
 * function.
 */
export function buildPrMarkerHook(
	log: ILogger,
	providers: PrMarkerProvider[] = [
		new GitHubPrMarkerProvider(),
		new GitLabMrMarkerProvider(),
	],
	onPullRequestDetected?: (
		pr: DetectedPullRequest,
		cwd: string,
	) => Promise<void>,
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	return {
		PostToolUse: [
			{
				matcher: "Bash",
				hooks: [
					async (input) => {
						const post = input as PostToolUseHookInput;
						const command =
							(post.tool_input as { command?: string } | undefined)?.command ??
							"";
						const provider = providers.find((p) => p.matches(command));
						if (!provider) {
							return {};
						}
						try {
							provider.ensureMarker(post.cwd, log);
						} catch (err) {
							log.warn(
								`[PrMarkerHook] ${provider.name} provider threw: ${
									(err as Error).message
								}`,
							);
						}
						// Surface the PR to the caller (EdgeWorker links it to the
						// Linear issue + agent session). Failures are logged and
						// swallowed — the coding session must never be interrupted
						// by presentation-layer plumbing.
						if (onPullRequestDetected && provider.readPullRequest) {
							try {
								const pr = provider.readPullRequest(post.cwd, log);
								if (pr) {
									await onPullRequestDetected(pr, post.cwd);
								}
							} catch (err) {
								log.warn(
									`[PrMarkerHook] onPullRequestDetected failed: ${
										(err as Error).message
									}`,
								);
							}
						}
						return {};
					},
				],
			},
		],
	};
}
