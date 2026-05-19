import type { IMessageFormatter } from "cyrus-core";

type ToolInput = Record<string, unknown>;

function asObject(input: unknown): ToolInput | null {
	if (input && typeof input === "object" && !Array.isArray(input)) {
		return input as ToolInput;
	}
	return null;
}

function safeStringify(input: unknown): string {
	try {
		return JSON.stringify(input);
	} catch {
		return String(input);
	}
}

function truncateResult(result: string, maxLength = 4000): string {
	if (result.length <= maxLength) {
		return result;
	}
	return `${result.slice(0, maxLength)}\n\n[truncated]`;
}

function getString(input: ToolInput, keys: string[]): string | null {
	for (const key of keys) {
		const value = input[key];
		if (typeof value === "string" && value.length > 0) {
			return value;
		}
	}
	return null;
}

export class OpenCodeMessageFormatter implements IMessageFormatter {
	formatTodoWriteParameter(jsonContent: string): string {
		try {
			const parsed = JSON.parse(jsonContent);
			if (!parsed || !Array.isArray(parsed.todos)) {
				return jsonContent;
			}

			return parsed.todos
				.map((todo: Record<string, unknown>) => {
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
					const marker = status === "completed" ? "[x]" : "[ ]";
					const suffix = status === "in_progress" ? " (in progress)" : "";
					return `- ${marker} ${content}${suffix}`.trim();
				})
				.join("\n");
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

		const taskId = getString(input, ["taskId", "id"]) || "";
		const subject = getString(input, ["subject", "description", "title"]) || "";
		const status = getString(input, ["status"]) || "";

		if (toolName === "TaskCreate") {
			return subject || "Create task";
		}
		if (toolName === "TaskUpdate") {
			return [taskId ? `Task #${taskId}` : "Task", status, subject]
				.filter(Boolean)
				.join(" ");
		}
		if (toolName === "TaskGet" && taskId) {
			return subject ? `Task #${taskId}: ${subject}` : `Task #${taskId}`;
		}

		return safeStringify(toolInput);
	}

	formatToolParameter(_toolName: string, toolInput: unknown): string {
		if (typeof toolInput === "string") {
			return toolInput;
		}

		const input = asObject(toolInput);
		if (!input) {
			return safeStringify(toolInput);
		}

		const command = getString(input, ["command", "cmd"]);
		if (command) {
			return command;
		}

		const filePath = getString(input, ["file_path", "filePath", "path"]);
		if (filePath) {
			return filePath;
		}

		const url = getString(input, ["url"]);
		if (url) {
			return url;
		}

		const pattern = getString(input, ["pattern", "query"]);
		if (pattern) {
			return pattern;
		}

		return safeStringify(toolInput);
	}

	formatToolActionName(
		toolName: string,
		toolInput: unknown,
		_isError: boolean,
	): string {
		const input = asObject(toolInput);
		const description = input
			? getString(input, ["description", "title"])
			: null;
		return description ? `${toolName} (${description})` : toolName;
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
