import type { SDKMessage } from "cyrus-core";
import { MAX_TOOL_DETAIL_BYTES, toolDetail } from "./JiraToolDetails.js";

/**
 * Jira-visible activity derived from a runner's normalized SDK messages
 * (Claude natively; Codex through CodexEventMapper, which emits the same
 * `tool_use` / `tool_result` shapes).
 *
 * What may leave the runtime is deliberately narrow:
 * - Known tools include their name and a bounded, redacted selected input
 *   (command, path, pattern, query, URL or task description). Arbitrary
 *   argument objects and tool output are never copied. See JiraToolDetails.
 * - A finish retains the same sanitized detail and says succeeded/failed.
 * - Reasoning is shown ONLY when the provider itself labels the text a
 *   public summary: Codex app-server `reasoning.summary[]`, carried by
 *   CodexEventMapper as a distinct `system`/`cyrus_reasoning_summary`
 *   message (never its raw `content[]`, deltas or the final-answer path).
 *   Claude `thinking`/`redacted_thinking` blocks carry no attested
 *   summarized-mode provenance and are always dropped.
 * - Assistant text and the final answer stay on their existing paths
 *   (progress / result) and are never mixed into activity.
 *
 * Correlation (which starts are open, which ids already finished) is pure
 * state cloned per commit: the task service applies events to a staged copy
 * under its context lock and keeps it only once the journal write succeeds.
 */
export type JiraActivityKind =
	| "tool_started"
	| "tool_finished"
	| "reasoning"
	| "gap";

export interface JiraActivityEntry {
	seq: number;
	at: string;
	kind: JiraActivityKind;
	/** Runner tool-use id (bounded), pairing a start with its finish. */
	toolId?: string;
	/** Tool label, provider reasoning summary, or the gap notice. */
	text: string;
	/** Recognized tool name and selected redacted input; no raw argument object. */
	toolName?: string;
	detail?: string;
	/** Tool finishes only. */
	outcome?: "succeeded" | "failed";
}

export type ActivityDraft = Omit<JiraActivityEntry, "seq" | "at">;

/** A normalized runner event, before correlation. */
export type ActivityEvent =
	| {
			kind: "start";
			id: string;
			label: string;
			toolName?: string;
			detail?: string;
	  }
	| { kind: "finish"; id: string; failed: boolean }
	| { kind: "summary"; text: string };

export const MAX_ACTIVITY_ENTRIES = 60;
/** UTF-8 bytes of one reasoning summary entry. */
export const MAX_ACTIVITY_TEXT_BYTES = 1024;
/** Total UTF-8 bytes of the retained activity window (JSON). */
export const MAX_ACTIVITY_WINDOW_BYTES = 96 * 1024;
const MAX_TOOL_ID = 128;
const TOOL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
/** Events taken from ONE runner message; the rest become a gap. */
export const MAX_EVENTS_PER_MESSAGE = 20;
const MAX_OPEN = 200;
const MAX_DONE = 500;
export const REASONING_SUMMARY_SUBTYPE = "cyrus_reasoning_summary";
export const GAP_TEXT = "Some steps weren't recorded";

const TOOL_LABELS: Record<string, string> = {
	Bash: "Command",
	BashOutput: "Command",
	KillShell: "Command",
	Read: "File read",
	Write: "File write",
	Edit: "File edit",
	MultiEdit: "File edit",
	NotebookEdit: "File edit",
	Grep: "Code search",
	Glob: "File search",
	WebSearch: "Web search",
	WebFetch: "Web page fetch",
	TodoWrite: "Plan update",
	Task: "Subagent",
	Agent: "Subagent",
};

/** Fixed display label for a tool (never derived from the name's text). */
export function toolLabel(name: unknown): string {
	if (typeof name !== "string") return "Tool";
	if (Object.hasOwn(TOOL_LABELS, name)) return TOOL_LABELS[name] as string;
	if (name.startsWith("mcp__")) return "Integration tool";
	return "Tool";
}

export function utf8Bytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

/** Truncate to at most `max` UTF-8 bytes without splitting a code point. */
export function truncateBytes(text: string, max: number): string {
	if (utf8Bytes(text) <= max) return text;
	let out = "";
	let used = 0;
	for (const ch of text) {
		const size = utf8Bytes(ch);
		if (used + size > max - 3) break;
		out += ch;
		used += size;
	}
	return `${out}…`;
}

const validId = (v: unknown): v is string =>
	typeof v === "string" && TOOL_ID.test(v);

/**
 * Normalized events in ONE message, at most MAX_EVENTS_PER_MESSAGE.
 * `overflow` reports events that were dropped (shown as a gap). Tool ids that
 * are missing, malformed or longer than 128 characters make the event
 * uncorrelatable and it is dropped (also counted).
 */
export function extractActivityEvents(message: SDKMessage): {
	events: ActivityEvent[];
	overflow: number;
} {
	const events: ActivityEvent[] = [];
	let overflow = 0;
	const add = (event: ActivityEvent) => {
		if (events.length < MAX_EVENTS_PER_MESSAGE) events.push(event);
		else overflow++;
	};
	const m = message as {
		type?: unknown;
		subtype?: unknown;
		summary?: unknown;
		parent_tool_use_id?: unknown;
		message?: { content?: unknown };
	};
	if (m.type === "system" && m.subtype === REASONING_SUMMARY_SUBTYPE) {
		if (!Array.isArray(m.summary)) return { events, overflow };
		for (const part of m.summary.slice(0, MAX_EVENTS_PER_MESSAGE * 2)) {
			if (typeof part !== "string") continue;
			// Bounded before queueing (re-bounded when applied).
			const text = truncateBytes(
				part
					.slice(0, MAX_ACTIVITY_TEXT_BYTES * 2)
					.replace(/\s+/g, " ")
					.trim(),
				MAX_ACTIVITY_TEXT_BYTES,
			);
			if (text) add({ kind: "summary", text });
		}
		return { events, overflow };
	}
	if (m.type !== "assistant" && m.type !== "user") return { events, overflow };
	// Subagent-internal steps are summarized by the subagent's own start/finish.
	if (m.parent_tool_use_id) return { events, overflow };
	const content = m.message?.content;
	if (!Array.isArray(content)) return { events, overflow };
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Record<string, unknown>;
		if (m.type === "assistant" && block.type === "tool_use") {
			if (!validId(block.id)) {
				overflow++;
				continue;
			}
			const name =
				typeof block.name === "string" && Object.hasOwn(TOOL_LABELS, block.name)
					? block.name
					: undefined;
			const detail = toolDetail(block.name, block.input);
			add({
				kind: "start",
				id: block.id,
				label: toolLabel(block.name),
				...(name ? { toolName: name } : {}),
				...(detail ? { detail } : {}),
			});
		} else if (m.type === "user" && block.type === "tool_result") {
			if (!validId(block.tool_use_id)) {
				overflow++;
				continue;
			}
			add({
				kind: "finish",
				id: block.tool_use_id,
				failed: block.is_error === true,
			});
		}
		// thinking / redacted_thinking / text: never activity.
	}
	return { events, overflow };
}

/**
 * Which tool ids are open (started, shown, not finished) and which already
 * finished, for ONE runner. Bounded; clone before applying, keep the clone
 * only after the resulting entries are durable.
 */
export class ActivityCorrelation {
	constructor(
		readonly runner: unknown,
		private open = new Map<
			string,
			{ label: string; toolName?: string; detail?: string }
		>(),
		private done: string[] = [],
	) {}

	clone(): ActivityCorrelation {
		return new ActivityCorrelation(this.runner, new Map(this.open), [
			...this.done,
		]);
	}

	get openCount(): number {
		return this.open.size;
	}

	/** Entries for these events; duplicates and foreign finishes are dropped. */
	apply(events: ActivityEvent[]): ActivityDraft[] {
		const drafts: ActivityDraft[] = [];
		for (const event of events) {
			if (event.kind === "summary") {
				drafts.push({
					kind: "reasoning",
					text: truncateBytes(event.text, MAX_ACTIVITY_TEXT_BYTES),
				});
			} else if (event.kind === "start") {
				// A repeated start (open or already finished) is the same step.
				if (this.open.has(event.id) || this.done.includes(event.id)) continue;
				const display = {
					label: event.label,
					...(event.toolName ? { toolName: event.toolName } : {}),
					...(event.detail ? { detail: event.detail } : {}),
				};
				this.open.set(event.id, display);
				while (this.open.size > MAX_OPEN) {
					this.open.delete(this.open.keys().next().value as string);
				}
				drafts.push({
					kind: "tool_started",
					toolId: event.id,
					text: event.label,
					...(event.toolName ? { toolName: event.toolName } : {}),
					...(event.detail ? { detail: event.detail } : {}),
				});
			} else {
				const display = this.open.get(event.id);
				// Only finishes of starts that were recorded, once.
				if (display === undefined) continue;
				this.open.delete(event.id);
				this.done.push(event.id);
				if (this.done.length > MAX_DONE)
					this.done.splice(0, this.done.length - MAX_DONE);
				drafts.push({
					kind: "tool_finished",
					toolId: event.id,
					text: display.label,
					...(display.toolName ? { toolName: display.toolName } : {}),
					...(display.detail ? { detail: display.detail } : {}),
					outcome: event.failed ? "failed" : "succeeded",
				});
			}
		}
		return drafts;
	}
}

/** Keep the newest entries within the count and byte bounds. */
export function boundActivityWindow(
	activity: JiraActivityEntry[],
): JiraActivityEntry[] {
	const window = activity.slice(-MAX_ACTIVITY_ENTRIES);
	let bytes = utf8Bytes(JSON.stringify(window));
	while (window.length > 0 && bytes > MAX_ACTIVITY_WINDOW_BYTES) {
		bytes -= utf8Bytes(JSON.stringify(window.shift())) + 1;
	}
	return window;
}

export function isActivityEntry(value: unknown): value is JiraActivityEntry {
	if (!value || typeof value !== "object") return false;
	const e = value as Record<string, unknown>;
	if (e.detail !== undefined || e.toolName !== undefined) {
		if (
			(e.kind !== "tool_started" && e.kind !== "tool_finished") ||
			typeof e.toolName !== "string" ||
			!Object.hasOwn(TOOL_LABELS, e.toolName)
		)
			return false;
	}

	return (
		Number.isSafeInteger(e.seq) &&
		typeof e.at === "string" &&
		e.at.length <= 40 &&
		(e.kind === "tool_started" ||
			e.kind === "tool_finished" ||
			e.kind === "reasoning" ||
			e.kind === "gap") &&
		typeof e.text === "string" &&
		utf8Bytes(e.text) <= MAX_ACTIVITY_TEXT_BYTES &&
		(e.detail === undefined ||
			(typeof e.detail === "string" &&
				utf8Bytes(e.detail) <= MAX_TOOL_DETAIL_BYTES)) &&
		(e.toolName === undefined ||
			(typeof e.toolName === "string" &&
				Object.hasOwn(TOOL_LABELS, e.toolName))) &&
		(e.toolId === undefined ||
			(typeof e.toolId === "string" && e.toolId.length <= MAX_TOOL_ID)) &&
		(e.outcome === undefined ||
			e.outcome === "succeeded" ||
			e.outcome === "failed")
	);
}

/** Restored journal activity: only valid entries, re-bounded (display only). */
export function restoreActivity(value: unknown): JiraActivityEntry[] {
	if (!Array.isArray(value)) return [];
	return boundActivityWindow(value.filter(isActivityEntry));
}
