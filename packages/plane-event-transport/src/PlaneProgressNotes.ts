import { createLogger, type ILogger } from "cyrus-core";
import type { PlaneApiClient } from "./PlaneApiClient.js";
import { markdownToHtml } from "./PlaneText.js";
import type { PlaneActivityType } from "./types.js";

/** At most one edit of a note in this interval; Plane gets a burst of thoughts otherwise. */
const MIN_UPDATE_MS = 15_000;
const MAX_TEXT = 400;
/** Cyrus's own housekeeping thoughts, not worth showing as progress. */
const HOUSEKEEPING =
	/^(Using model:|Analyzing your request|Still working|Conversation history compacted)/i;

interface Note {
	projectId: string;
	workItemId: string;
	commentId: string;
	shown: string;
	pending?: string;
	lastUpdate: number;
	timer?: NodeJS.Timeout;
}

/**
 * A reply in the agent's thread on the work item that says it is working and
 * what it is doing now. Plane shows an agent's live progress (thoughts and
 * actions) only on paid plans; without it a run is invisible until its
 * answer. The note is posted at the run's first step, edited with its latest
 * thought (at most every 15 s), and deleted when the agent answers, asks a
 * question or fails, so only the answer stays in the thread.
 */
export class PlaneProgressNotes {
	private readonly notes = new Map<string, Promise<Note | undefined>>();
	private readonly logger: ILogger;

	constructor(
		private readonly api: PlaneApiClient,
		private readonly options: { minUpdateMs?: number; logger?: ILogger } = {},
	) {
		this.logger =
			options.logger ?? createLogger({ component: "PlaneProgressNotes" });
	}

	/** Called for every activity the agent posts to a run. Never throws. */
	async onActivity(
		runId: string,
		type: PlaneActivityType,
		body?: string,
	): Promise<void> {
		try {
			if (type === "response" || type === "error" || type === "elicitation") {
				await this.finish(runId);
				return;
			}
			if (type !== "thought" && type !== "action") return;
			const thought = type === "thought" ? body?.trim() : undefined;
			const latest =
				thought && !HOUSEKEEPING.test(thought) ? thought : undefined;
			let created = this.notes.get(runId);
			if (!created) {
				created = this.create(runId, latest);
				this.notes.set(runId, created);
				await created;
				return;
			}
			const note = await created;
			if (note && latest) this.update(note, latest);
		} catch (error) {
			this.logger.warn(`Progress note for run ${runId} failed`, error);
		}
	}

	private async create(
		runId: string,
		latest: string | undefined,
	): Promise<Note | undefined> {
		const run = await this.api.getRun(runId);
		if (!run.issue || !run.project) return undefined;
		// Reply in the run's thread: its comment, or that comment's parent when
		// the run started from a reply.
		let threadId = run.comment ?? undefined;
		if (threadId) {
			const comment = await this.api
				.getComment(run.project, run.issue, threadId)
				.catch(() => undefined);
			threadId = comment?.parent ?? threadId;
		}
		const text = latest ?? "";
		const comment = await this.api.createComment(
			run.project,
			run.issue,
			noteHtml(text),
			threadId,
		);
		return {
			projectId: run.project,
			workItemId: run.issue,
			commentId: comment.id,
			shown: text,
			lastUpdate: Date.now(),
		};
	}

	private update(note: Note, latest: string): void {
		note.pending = latest;
		if (note.timer) return;
		const wait = Math.max(
			0,
			note.lastUpdate +
				(this.options.minUpdateMs ?? MIN_UPDATE_MS) -
				Date.now(),
		);
		const flush = () => {
			note.timer = undefined;
			const text = note.pending;
			note.pending = undefined;
			if (!text || text === note.shown) return;
			note.shown = text;
			note.lastUpdate = Date.now();
			void this.api
				.updateComment(
					note.projectId,
					note.workItemId,
					note.commentId,
					noteHtml(text),
				)
				.catch((error) =>
					this.logger.warn("Progress note update failed", error),
				);
		};
		if (wait === 0) flush();
		else note.timer = setTimeout(flush, wait);
	}

	private async finish(runId: string): Promise<void> {
		const created = this.notes.get(runId);
		if (!created) return;
		this.notes.delete(runId);
		const note = await created.catch(() => undefined);
		if (!note) return;
		clearTimeout(note.timer);
		await this.api.deleteComment(
			note.projectId,
			note.workItemId,
			note.commentId,
		);
	}
}

function noteHtml(latest: string): string {
	const text =
		latest.length > MAX_TEXT ? `${latest.slice(0, MAX_TEXT)}…` : latest;
	return (
		"<p>⏳ <strong>Working on it.</strong> This note goes away when I post my answer.</p>" +
		(text ? markdownToHtml(`Now: ${text}`) : "")
	);
}
