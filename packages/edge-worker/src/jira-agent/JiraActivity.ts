import type { SDKMessage } from "cyrus-core";

/**
 * Jira-visible activity derived from a runner's normalized SDK messages
 * (Claude natively; Codex through CodexEventMapper, which emits the same
 * `tool_use` / `tool_result` shapes).
 *
 * Only short, bounded labels leave the runtime:
 * - a tool start names the tool and one safe summary of its input (a command's
 *   first line, a workspace-relative path, a search pattern, a URL host);
 *   MCP tool arguments, file contents, edits and every tool OUTPUT are never
 *   included;
 * - a tool finish says only succeeded/failed;
 * - a reasoning entry is the provider-exposed thinking SUMMARY (Claude
 *   `thinking` blocks), truncated; `redacted_thinking` and anything else is
 *   dropped.
 * Assistant text and the final answer stay on their existing paths
 * (progress / result) and are never mixed into activity.
 */
export type JiraActivityKind = "tool_started" | "tool_finished" | "reasoning";

export interface JiraActivityEntry {
	seq: number;
	at: string;
	kind: JiraActivityKind;
	/** Runner tool-use id, pairing a start with its finish. */
	toolId?: string;
	/** Short display text (tool label or reasoning summary). */
	text: string;
	/** Tool finishes only. */
	outcome?: "succeeded" | "failed";
}

export type ActivityDraft = Omit<JiraActivityEntry, "seq" | "at">;

export const MAX_ACTIVITY_ENTRIES = 60;
const MAX_LABEL = 200;
const MAX_REASONING = 1024;
const MAX_DETAIL = 140;

/** Whether provider-exposed reasoning summaries are shown in Jira. */
export const SHOW_REASONING_SUMMARIES = true;

type Block = Record<string, unknown>;

const str = (v: unknown): string | null =>
	typeof v === "string" && v.trim().length > 0 ? v : null;

function clip(text: string, max: number): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

/** Masks credential-looking arguments in a command summary. */
export function redact(text: string): string {
	return text
		.replace(/\b(bearer|basic)\s+\S+/gi, "$1 ***")
		.replace(
			/\b([\w-]*(?:token|secret|password|passwd|api[_-]?key|auth)[\w-]*)(\s*[=:]\s*|\s+)("[^"]*"|'[^']*'|\S+)/gi,
			"$1$2***",
		)
		.replace(/[A-Za-z0-9_\-+/=]{32,}/g, "***");
}

function relative(path: string, workspacePath: string | null): string {
	if (workspacePath && path.startsWith(`${workspacePath}/`))
		return path.slice(workspacePath.length + 1);
	// Never reveal absolute paths outside the workspace; keep the file name.
	if (path.startsWith("/")) return path.split("/").pop() || "file";
	return path;
}

function host(url: string): string | null {
	try {
		return new URL(url).host || null;
	} catch {
		return null;
	}
}

/** Display label for a tool start. Input values beyond one summary are dropped. */
export function toolLabel(
	name: string,
	input: unknown,
	workspacePath: string | null,
): string {
	const i = (input && typeof input === "object" ? input : {}) as Block;
	const detail = (prefix: string, value: string | null) =>
		value ? `${prefix}: ${clip(value, MAX_DETAIL)}` : prefix;
	const file = str(i.file_path) ?? str(i.path) ?? str(i.notebook_path);
	const fileLabel = file ? relative(file, workspacePath) : null;
	if (name.startsWith("mcp__")) {
		const [, server = "", tool = ""] = name.split("__");
		return clip(`Tool ${server}/${tool}`, MAX_LABEL);
	}
	switch (name) {
		case "Bash":
		case "BashOutput": {
			const command = str(i.description) ?? str(i.command)?.split("\n")[0];
			return clip(
				detail("Command", command ? redact(command) : null),
				MAX_LABEL,
			);
		}
		case "Read":
			return clip(detail("Read", fileLabel), MAX_LABEL);
		case "Write":
			return clip(detail("Write", fileLabel), MAX_LABEL);
		case "Edit":
		case "MultiEdit":
		case "NotebookEdit":
			return clip(detail("Edit", fileLabel), MAX_LABEL);
		case "Grep":
			return clip(detail("Search code", str(i.pattern)), MAX_LABEL);
		case "Glob":
			return clip(detail("Find files", str(i.pattern)), MAX_LABEL);
		case "WebSearch":
			return clip(detail("Web search", str(i.query)), MAX_LABEL);
		case "WebFetch":
			return clip(
				detail("Fetch", str(i.url) ? host(i.url as string) : null),
				MAX_LABEL,
			);
		case "TodoWrite":
			return Array.isArray(i.todos)
				? `Update plan (${i.todos.length} items)`
				: "Update plan";
		case "Task":
		case "Agent":
			return clip(detail("Subagent", str(i.description)), MAX_LABEL);
		default:
			return clip(`Tool ${name}`, MAX_LABEL);
	}
}

/**
 * Activity drafts for one runner message. `labels` remembers tool-use ids of
 * the CURRENT live task so a finish can repeat its start's label; it is
 * bounded by the caller.
 */
export function activityFromMessage(
	message: SDKMessage,
	labels: Map<string, string>,
	workspacePath: string | null,
): ActivityDraft[] {
	const type = (message as { type?: unknown }).type;
	if (type !== "assistant" && type !== "user") return [];
	// Subagent-internal steps are summarized by the subagent's own start/finish.
	if ((message as { parent_tool_use_id?: unknown }).parent_tool_use_id)
		return [];
	const content = (message as { message?: { content?: unknown } }).message
		?.content;
	if (!Array.isArray(content)) return [];
	const drafts: ActivityDraft[] = [];
	for (const raw of content) {
		if (!raw || typeof raw !== "object") continue;
		const block = raw as Block;
		if (type === "assistant" && block.type === "tool_use") {
			const id = str(block.id);
			const name = str(block.name);
			if (!id || !name || labels.has(id)) continue;
			const text = toolLabel(name, block.input, workspacePath);
			labels.set(id, text);
			drafts.push({ kind: "tool_started", toolId: id, text });
		} else if (type === "assistant" && block.type === "thinking") {
			const thinking = str(block.thinking);
			if (SHOW_REASONING_SUMMARIES && thinking)
				drafts.push({ kind: "reasoning", text: clip(thinking, MAX_REASONING) });
		} else if (type === "user" && block.type === "tool_result") {
			const id = str(block.tool_use_id);
			if (!id) continue;
			const text = labels.get(id);
			// Only finishes of starts we showed (never an unknown/foreign id).
			if (text === undefined) continue;
			labels.delete(id);
			drafts.push({
				kind: "tool_finished",
				toolId: id,
				text,
				outcome: block.is_error === true ? "failed" : "succeeded",
			});
		}
	}
	return drafts;
}

export function isActivityEntry(value: unknown): value is JiraActivityEntry {
	if (!value || typeof value !== "object") return false;
	const e = value as Record<string, unknown>;
	return (
		typeof e.seq === "number" &&
		typeof e.at === "string" &&
		(e.kind === "tool_started" ||
			e.kind === "tool_finished" ||
			e.kind === "reasoning") &&
		typeof e.text === "string" &&
		(e.toolId === undefined || typeof e.toolId === "string") &&
		(e.outcome === undefined ||
			e.outcome === "succeeded" ||
			e.outcome === "failed")
	);
}
