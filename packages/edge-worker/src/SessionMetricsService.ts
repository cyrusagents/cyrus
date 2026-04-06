import { exec } from "node:child_process";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import type { SDKResultMessage } from "cyrus-claude-runner";
import type { CyrusAgentSession, CyrusAgentSessionEntry } from "cyrus-core";

const execAsync = promisify(exec);

const PR_URL_PATTERN =
	/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+|https:\/\/gitlab\.com\/[\w./+-]+\/-\/merge_requests\/\d+/;

export interface SessionMetricsRecord {
	sessionId: string;
	issueId: string;
	issueIdentifier: string;
	repo: string;
	model: string | null;
	workflow: string | null;
	startedAt: string;
	endedAt: string;
	durationSeconds: number;
	filesChanged: number | null;
	prUrl: string | null;
	outcome: "success" | "error" | "timeout";
	completionCommentPosted: boolean;
	tokenUsage: object | null;
	totalCostUsd: number | null;
}

/**
 * Records structured session metrics to a local append-only JSONL file.
 *
 * One JSON line is appended per completed session. Logging failures are
 * silently swallowed so they never block session execution.
 */
export class SessionMetricsService {
	private metricsPath: string;
	/** Maps sessionId → repository name, populated when a session starts */
	private pendingRepoNames: Map<string, string> = new Map();
	/** Tracks sessions that have already been recorded to avoid duplicates */
	private recordedSessions: Set<string> = new Set();

	constructor(cyrusHome: string) {
		this.metricsPath = join(cyrusHome, "session-metrics.jsonl");
	}

	/**
	 * Register the repository name for a session before it completes.
	 * Called by EdgeWorker right after creating a session.
	 */
	notifySessionStart(sessionId: string, repoName: string): void {
		this.pendingRepoNames.set(sessionId, repoName);
	}

	/**
	 * Append a metrics record for a completed session.
	 * Safe to call multiple times — only the first call per session is recorded.
	 * All errors are caught and discarded to avoid interfering with session execution.
	 */
	async record(
		session: CyrusAgentSession,
		resultMessage: SDKResultMessage,
		entries: CyrusAgentSessionEntry[],
	): Promise<void> {
		if (this.recordedSessions.has(session.id)) return;
		this.recordedSessions.add(session.id);

		try {
			const repoName =
				this.pendingRepoNames.get(session.id) ??
				session.repositories[0]?.repositoryId ??
				"unknown";
			this.pendingRepoNames.delete(session.id);

			const outcome =
				resultMessage.subtype === "success"
					? "success"
					: resultMessage.subtype === "error_max_turns"
						? "timeout"
						: "error";

			const durationSeconds = Math.round(
				(Date.now() - session.createdAt) / 1000,
			);
			const prUrl = this.extractPrUrl(entries, resultMessage);
			const filesChanged = await this.getFilesChangedCount(session);

			const record: SessionMetricsRecord = {
				sessionId: session.id,
				issueId: session.issueContext?.issueId ?? session.issueId ?? "",
				issueIdentifier: session.issueContext?.issueIdentifier ?? "",
				repo: repoName,
				model: session.metadata?.model ?? null,
				workflow: session.metadata?.procedure?.procedureName ?? null,
				startedAt: new Date(session.createdAt).toISOString(),
				endedAt: new Date().toISOString(),
				durationSeconds,
				filesChanged,
				prUrl,
				outcome,
				completionCommentPosted: outcome === "success",
				tokenUsage:
					resultMessage.usage != null ? (resultMessage.usage as object) : null,
				totalCostUsd: resultMessage.total_cost_usd ?? null,
			};

			await this.appendRecord(record);
		} catch {
			// Never block session execution if metrics logging fails
		}
	}

	private extractPrUrl(
		entries: CyrusAgentSessionEntry[],
		resultMessage: SDKResultMessage,
	): string | null {
		// Check result text first (most likely to contain the final PR URL)
		const resultText =
			"result" in resultMessage && typeof resultMessage.result === "string"
				? resultMessage.result
				: "";
		const resultMatch = resultText.match(PR_URL_PATTERN);
		if (resultMatch) return resultMatch[0];

		// Scan entries from most recent to oldest
		for (let i = entries.length - 1; i >= 0; i--) {
			const content = entries[i]?.content ?? "";
			const match = content.match(PR_URL_PATTERN);
			if (match) return match[0];
		}

		return null;
	}

	private async getFilesChangedCount(
		session: CyrusAgentSession,
	): Promise<number | null> {
		try {
			const workspacePath = session.workspace?.path;
			if (!workspacePath) return null;

			const baseBranch = session.repositories[0]?.baseBranchName ?? "main";

			const { stdout } = await execAsync(
				`git diff --name-only origin/${baseBranch}...HEAD`,
				{ cwd: workspacePath, timeout: 5000 },
			);

			const lines = stdout.trim().split("\n").filter(Boolean);
			return lines.length;
		} catch {
			return null;
		}
	}

	private async appendRecord(record: SessionMetricsRecord): Promise<void> {
		const line = `${JSON.stringify(record)}\n`;
		await mkdir(dirname(this.metricsPath), { recursive: true });
		await appendFile(this.metricsPath, line, "utf-8");
	}

	/**
	 * Read and summarise the metrics JSONL file.
	 * Returns a human-readable multi-line string.
	 */
	static async summarize(cyrusHome: string): Promise<string> {
		const metricsPath = join(cyrusHome, "session-metrics.jsonl");

		let content: string;
		try {
			content = await readFile(metricsPath, "utf-8");
		} catch {
			return `No metrics found.\nExpected file: ${metricsPath}`;
		}

		const records: SessionMetricsRecord[] = content
			.trim()
			.split("\n")
			.filter(Boolean)
			.map((line) => JSON.parse(line) as SessionMetricsRecord);

		if (records.length === 0) {
			return "No sessions recorded yet.";
		}

		const total = records.length;
		const successes = records.filter((r) => r.outcome === "success").length;
		const errors = records.filter((r) => r.outcome === "error").length;
		const timeouts = records.filter((r) => r.outcome === "timeout").length;
		const successRate = ((successes / total) * 100).toFixed(1);
		const avgDuration = (
			records.reduce((sum, r) => sum + r.durationSeconds, 0) / total
		).toFixed(1);
		const withPr = records.filter((r) => r.prUrl !== null).length;
		const prRate = ((withPr / total) * 100).toFixed(1);

		// Per-repo breakdown
		const byRepo = new Map<
			string,
			{ count: number; successes: number; totalDuration: number }
		>();
		for (const r of records) {
			const repo = r.repo || "unknown";
			const existing = byRepo.get(repo) ?? {
				count: 0,
				successes: 0,
				totalDuration: 0,
			};
			existing.count++;
			if (r.outcome === "success") existing.successes++;
			existing.totalDuration += r.durationSeconds;
			byRepo.set(repo, existing);
		}

		const lines: string[] = [
			"Session Metrics Summary",
			"=======================",
			`Total sessions:   ${total}`,
			`  Success:        ${successes} (${successRate}%)`,
			`  Error:          ${errors}`,
			`  Timeout:        ${timeouts}`,
			`Avg duration:     ${avgDuration}s`,
			`PRs created:      ${withPr} (${prRate}%)`,
		];

		if (byRepo.size > 0) {
			lines.push("", "By repository:");
			for (const [repo, stats] of byRepo.entries()) {
				const repoSuccessRate = ((stats.successes / stats.count) * 100).toFixed(
					0,
				);
				const repoAvgDuration = (stats.totalDuration / stats.count).toFixed(1);
				lines.push(
					`  ${repo}: ${stats.count} session${stats.count !== 1 ? "s" : ""}, ${repoSuccessRate}% success, avg ${repoAvgDuration}s`,
				);
			}
		}

		return lines.join("\n");
	}
}
