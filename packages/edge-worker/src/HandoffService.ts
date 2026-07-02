/**
 * Cross-runner handoff support: parse `/handoff <runner>` commands, build a
 * context snapshot of the source runner's worktree state, format the target
 * runner's starting prompt, and poll for the source runner to stop.
 *
 * Pure/logic-only — no live runner wiring. The orchestration that stops the
 * source runner and starts the target lives in EdgeWorker.handleHandoffCommand.
 */

import type { CyrusAgentSession, RunnerType } from "cyrus-core";

export type HandoffTarget = "claude" | "codex";

export interface HandoffCommand {
	/** Validated target, or null when the word after /handoff is unrecognized. */
	targetRunner: HandoffTarget | null;
	/** The raw word that followed /handoff (for error messages). */
	rawTarget: string;
	/** Any text after the target — becomes the target runner's instruction. */
	remainder: string;
}

export interface HandoffSnapshotArgs {
	sourceRunner: RunnerType | "unknown";
	targetRunner: HandoffTarget;
	issueId: string;
	sessionId: string;
	worktreePath: string;
	latestSummary?: string;
}

export interface HandoffSnapshot extends HandoffSnapshotArgs {
	branch: string;
	gitStatus: string;
	recentCommits: string;
	diffSummary: string;
	prLink?: string;
}

/** Read-only git facts about a worktree. Implemented by GitService. */
export interface GitSnapshotReader {
	getCurrentBranch(worktreePath: string): string;
	getStatus(worktreePath: string): string;
	getRecentCommits(worktreePath: string, limit: number): string;
	getDiffSummary(worktreePath: string): string;
	getOpenPrUrl(worktreePath: string): string | undefined;
}

/** How long to wait for the active runner to stop before declaring handoff blocked. */
export const HANDOFF_STOP_TIMEOUT_MS = 30000;

const HANDOFF_RE = /\/handoff\s+(\S+)([\s\S]*)/i;

/** Identify the runner a session is currently bound to. */
export function getActiveRunnerType(
	session: Pick<
		CyrusAgentSession,
		| "claudeSessionId"
		| "geminiSessionId"
		| "codexSessionId"
		| "cursorSessionId"
		| "agentRunner"
	>,
): RunnerType | "unknown" {
	if (session.claudeSessionId) return "claude";
	if (session.geminiSessionId) return "gemini";
	if (session.codexSessionId) return "codex";
	if (session.cursorSessionId) return "cursor";
	switch (session.agentRunner?.constructor?.name) {
		case "ClaudeRunner":
			return "claude";
		case "GeminiRunner":
			return "gemini";
		case "CodexRunner":
			return "codex";
		case "CursorRunner":
			return "cursor";
		default:
			return "unknown";
	}
}

export class HandoffService {
	constructor(private readonly gitReader: GitSnapshotReader) {}

	buildSnapshot(args: HandoffSnapshotArgs): HandoffSnapshot {
		return {
			...args,
			branch: this.gitReader.getCurrentBranch(args.worktreePath),
			gitStatus: this.gitReader.getStatus(args.worktreePath),
			recentCommits: this.gitReader.getRecentCommits(args.worktreePath, 5),
			diffSummary: this.gitReader.getDiffSummary(args.worktreePath),
			prLink: this.gitReader.getOpenPrUrl(args.worktreePath),
		};
	}

	buildHandoffPrompt(snapshot: HandoffSnapshot, userText?: string): string {
		const lines = [
			"<handoff_context>",
			"  You are taking over an in-progress Linear issue from another agent.",
			"  The worktree, branch, files, and PR state below are already in place.",
			`  <source_runner>${snapshot.sourceRunner}</source_runner>`,
			`  <target_runner>${snapshot.targetRunner}</target_runner>`,
			`  <issue_id>${snapshot.issueId}</issue_id>`,
			`  <session_id>${snapshot.sessionId}</session_id>`,
			`  <worktree_path>${snapshot.worktreePath}</worktree_path>`,
			`  <branch>${snapshot.branch || "(unknown)"}</branch>`,
			`  <git_status>\n${snapshot.gitStatus || "(clean)"}\n  </git_status>`,
			`  <recent_commits>\n${snapshot.recentCommits || "(none)"}\n  </recent_commits>`,
			`  <diff_summary>\n${snapshot.diffSummary || "(no changes)"}\n  </diff_summary>`,
		];
		if (snapshot.prLink) {
			lines.push(`  <pull_request>${snapshot.prLink}</pull_request>`);
		}
		if (snapshot.latestSummary) {
			lines.push(
				`  <previous_agent_summary>\n${snapshot.latestSummary}\n  </previous_agent_summary>`,
			);
		}
		lines.push("</handoff_context>");

		const instruction =
			userText && userText.trim().length > 0
				? userText.trim()
				: "Continue the work in this worktree from where the previous runner left off.";
		return `${lines.join("\n")}\n\n${instruction}`;
	}

	async waitForStopped(
		isRunning: () => boolean,
		opts: {
			timeoutMs: number;
			pollIntervalMs: number;
			sleep: (ms: number) => Promise<void>;
		},
	): Promise<boolean> {
		let elapsed = 0;
		while (isRunning()) {
			if (elapsed >= opts.timeoutMs) {
				return false;
			}
			await opts.sleep(opts.pollIntervalMs);
			elapsed += opts.pollIntervalMs;
		}
		return true;
	}

	parseHandoffCommand(text: string): HandoffCommand | null {
		const match = text.match(HANDOFF_RE);
		if (!match) {
			return null;
		}
		const rawTarget = (match[1] ?? "").toLowerCase();
		const remainder = (match[2] ?? "").trim();
		const targetRunner: HandoffTarget | null =
			rawTarget === "claude" || rawTarget === "codex" ? rawTarget : null;
		return { targetRunner, rawTarget, remainder };
	}
}
