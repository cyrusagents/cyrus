import type { NormalizedCodexItem } from "./types.js";

/** Notification method names emitted by the app-server that we act on. */
export type AppServerNotification =
	| "turn/started"
	| "item/started"
	| "item/completed"
	| "turn/completed"
	| "thread/tokenUsage/updated"
	| (string & {});

type RawItem = Record<string, unknown>;

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

/** Map app-server execution/patch/mcp status (camelCase) to normalized status. */
function normalizeRunStatus(
	status: unknown,
): "in_progress" | "completed" | "failed" {
	if (status === "inProgress") return "in_progress";
	if (status === "completed") return "completed";
	// "failed", "declined", or anything unexpected → treat as failed.
	return "failed";
}

function normalizePatchStatus(status: unknown): "completed" | "failed" {
	return status === "completed" ? "completed" : "failed";
}

function normalizeChanges(
	changes: unknown,
): { path: string; kind: "add" | "delete" | "update" }[] {
	if (!Array.isArray(changes)) {
		return [];
	}
	return changes.map((change) => {
		const c = (change ?? {}) as RawItem;
		const kind = str(c.kind);
		return {
			path: str(c.path),
			kind:
				kind === "add" || kind === "delete" || kind === "update"
					? kind
					: "update",
		};
	});
}

function normalizeMcpResult(
	result: unknown,
): { content?: unknown[]; structured_content?: unknown } | undefined {
	if (!result || typeof result !== "object") {
		return undefined;
	}
	const r = result as RawItem;
	return {
		content: Array.isArray(r.content) ? r.content : undefined,
		// v2 uses camelCase `structuredContent`; accept snake too defensively.
		structured_content:
			(r as { structuredContent?: unknown }).structuredContent ??
			(r as { structured_content?: unknown }).structured_content,
	};
}

/**
 * Translate an app-server v2 thread item into a {@link NormalizedCodexItem}.
 * Returns null for item types the activity mapper does not render.
 */
export function translateAppServerItem(
	raw: unknown,
): NormalizedCodexItem | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}
	const item = raw as RawItem;
	const id = str(item.id);
	switch (item.type) {
		case "agentMessage":
			return { type: "agent_message", id, text: str(item.text) };
		case "reasoning":
			return { type: "reasoning", id };
		case "userMessage":
			return { type: "user_message", id };
		case "commandExecution":
			return {
				type: "command_execution",
				id,
				command: str(item.command),
				aggregated_output: str(item.aggregatedOutput),
				...(typeof item.exitCode === "number"
					? { exit_code: item.exitCode }
					: {}),
				status: normalizeRunStatus(item.status),
			};
		case "fileChange":
			return {
				type: "file_change",
				id,
				changes: normalizeChanges(item.changes),
				status: normalizePatchStatus(item.status),
			};
		case "mcpToolCall": {
			const error =
				item.error && typeof item.error === "object"
					? { message: str((item.error as RawItem).message) }
					: undefined;
			return {
				type: "mcp_tool_call",
				id,
				server: str(item.server),
				tool: str(item.tool),
				arguments: item.arguments,
				...(normalizeMcpResult(item.result)
					? { result: normalizeMcpResult(item.result) }
					: {}),
				...(error ? { error } : {}),
				status: normalizeRunStatus(item.status),
			};
		}
		case "dynamicToolCall":
			return {
				type: "dynamic_tool_call",
				id,
				tool: str(item.tool),
				arguments: item.arguments,
				text: Array.isArray(item.contentItems)
					? item.contentItems
							.filter(
								(part) =>
									part &&
									part.type === "inputText" &&
									typeof part.text === "string",
							)
							.map((part) => part.text)
							.join("\n")
					: "",
				status:
					item.success === false ? "failed" : normalizeRunStatus(item.status),
			};
		case "webSearch":
			return {
				type: "web_search",
				id,
				query: str(item.query),
				...(item.action && typeof item.action === "object"
					? { action: item.action as Record<string, unknown> }
					: {}),
			};
		default:
			// userMessage handled above; plan/reasoning/etc. are not rendered as
			// tool activities, so drop anything else.
			return null;
	}
}
