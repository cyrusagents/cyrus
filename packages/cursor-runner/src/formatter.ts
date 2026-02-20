import type { IMessageFormatter } from "cyrus-core";

type ToolInput = Record<string, unknown>;

function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
}

function asObject(input: unknown): ToolInput | null {
	if (input && typeof input === "object") {
		return input as ToolInput;
	}
	return null;
}

function formatLineRange(input: ToolInput): string {
	const filePath =
		typeof input.file_path === "string" ? input.file_path : undefined;
	if (!filePath) {
		return "";
	}

	const offset =
		typeof input.offset === "number" && Number.isFinite(input.offset)
			? input.offset
			: undefined;
	const limit =
		typeof input.limit === "number" && Number.isFinite(input.limit)
			? input.limit
			: undefined;

	if (offset === undefined && limit === undefined) {
		return filePath;
	}

	const start = offset ?? 0;
	const end = limit ? start + limit : "end";
	return `${filePath} (lines ${start + 1}-${end})`;
}

function truncateResult(result: string, maxLength = 4000): string {
	if (result.length <= maxLength) {
		return result;
	}
	return `${result.slice(0, maxLength)}\n\n[truncated]`;
}

export class CursorMessageFormatter implements IMessageFormatter {
	formatTodoWriteParameter(jsonContent: string): string {
		try {
			const parsed = JSON.parse(jsonContent);
			if (!parsed || !Array.isArray(parsed.todos)) {
				return jsonContent;
			}

			const lines = parsed.todos.map((todo: Record<string, unknown>) => {
				const status =
					typeof todo.status === "string"
						? todo.status.toLowerCase()
						: "pending";
				const content =
					typeof todo.content === "string"
						? todo.content
						: typeof todo.description === "string"
							? todo.description
							: "";
				const isCompleted =
					status === "completed" || status === "todo_status_completed";
				const isInProgress =
					status === "in_progress" || status === "todo_status_in_progress";
				const marker = isCompleted ? "[x]" : "[ ]";
				const suffix = isInProgress ? " (in progress)" : "";
				return `- ${marker} ${content}${suffix}`.trim();
			});

			return lines.join("\n");
		} catch {
			return jsonContent;
		}
	}

	formatTaskParameter(toolName: string, toolInput: unknown): string {
		if (typeof toolInput === "string") {
			return toolInput;
		}

		const input = asObject(toolInput);
		if (!input) {
			return safeStringify(toolInput);
		}

		if (toolName === "TaskList") {
			return "List all tasks";
		}

		const taskId = typeof input.taskId === "string" ? input.taskId : "";
		const subject = typeof input.subject === "string" ? input.subject : "";
		const status = typeof input.status === "string" ? input.status : "";

		if (toolName === "TaskCreate") {
			return subject || "Create task";
		}

		if (toolName === "TaskUpdate") {
			if (taskId && subject) {
				return `Task #${taskId} ${status}: ${subject}`.trim();
			}
			if (taskId) {
				return `Task #${taskId} ${status}`.trim();
			}
		}

		if (toolName === "TaskGet" && taskId) {
			return subject ? `Task #${taskId}: ${subject}` : `Task #${taskId}`;
		}

		return safeStringify(toolInput);
	}

	formatToolParameter(toolName: string, toolInput: unknown): string {
		if (typeof toolInput === "string") {
			return toolInput;
		}

		const input = asObject(toolInput);
		if (!input) {
			return safeStringify(toolInput);
		}

		const command = typeof input.command === "string" ? input.command : null;
		if (command) {
			return command;
		}

		const lineRange = formatLineRange(input);
		if (lineRange) {
			return lineRange;
		}

		const path = typeof input.path === "string" ? input.path : null;
		if (path) {
			return path;
		}

		const url = typeof input.url === "string" ? input.url : null;
		if (url) {
			return url;
		}

		const pattern = typeof input.pattern === "string" ? input.pattern : null;
		if (pattern) {
			return toolName.toLowerCase().includes("grep")
				? pattern
				: `${pattern} (${toolName})`;
		}

		return safeStringify(toolInput);
	}

	formatToolActionName(
		toolName: string,
		toolInput: unknown,
		_isError: boolean,
	): string {
		const input = asObject(toolInput);
		const description =
			input && typeof input.description === "string"
				? input.description.trim()
				: "";
		if (description) {
			return `${toolName} (${description})`;
		}
		return toolName;
	}

	formatToolResult(
		_toolName: string,
		_toolInput: unknown,
		result: string,
		isError: boolean,
	): string {
		const normalized = truncateResult(result || "No output");
		if (isError) {
			return `\`\`\`\n${normalized}\n\`\`\``;
		}
		return normalized;
	}
}
