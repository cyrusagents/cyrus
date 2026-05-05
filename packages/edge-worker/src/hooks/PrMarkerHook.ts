import { execFileSync, spawnSync } from "node:child_process";
import type {
	HookCallbackMatcher,
	HookEvent,
	PostToolUseHookInput,
} from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";
import { CYRUS_PR_MARKER } from "cyrus-github-event-transport";

/**
 * The hidden HTML marker that identifies a PR/MR description as Cyrus-authored.
 * Re-exported from cyrus-github-event-transport so that the marker-injection
 * hook (here) and the PR review authorization policy (there) share a single
 * source of truth.
 */
export { CYRUS_PR_MARKER };

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
						return {};
					},
				],
			},
		],
	};
}
