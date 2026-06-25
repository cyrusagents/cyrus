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
	constructor(readonly _gitReader: GitSnapshotReader) {}

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
