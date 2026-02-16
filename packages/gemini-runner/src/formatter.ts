/**
 * Gemini Message Formatter
 *
 * Implements message formatting for Gemini CLI tool messages.
 * This formatter understands Gemini's specific tool format and converts
 * tool use/result messages into human-readable content for Linear.
 *
 * Gemini CLI tool names:
 * - read_file: Read file contents
 * - write_file: Write content to a file
 * - list_directory: List directory contents
 * - search_file_content: Search for patterns in files
 * - run_shell_command: Execute shell commands
 * - write_todos: Update task list
 * - replace: Edit/replace content in files
 */

import type { IMessageFormatter } from "cyrus-core";
import type { FormatterToolInput } from "./schemas.js";

/**
 * Helper to safely get a string property from tool input
 */
function getString(input: FormatterToolInput, key: string): string | undefined {
	const value = input[key];
	return typeof value === "string" ? value : undefined;
}

/**
 * Helper to safely get a number property from tool input
 */
function getNumber(input: FormatterToolInput, key: string): number | undefined {
	const value = input[key];
	return typeof value === "number" ? value : undefined;
}

/**
 * Helper to check if a property exists and is truthy
 */
function hasProperty(input: FormatterToolInput, key: string): boolean {
	return key in input && input[key] !== undefined && input[key] !== null;
}

export class GeminiMessageFormatter implements IMessageFormatter {
	/**
	 * Format TodoWrite tool parameter as a nice checklist
	 * @deprecated TodoWrite has been replaced by Task tools
	 */
	formatTodoWriteParameter(jsonContent: string): string {
		try {
			const data = JSON.parse(jsonContent);
			if (!data.todos || !Array.isArray(data.todos)) {
				return jsonContent;
			}

			const todos = data.todos as Array<{
				id?: string;
				description?: string;
				content?: string;
				status: string;
				priority?: string;
			}>;

			// Keep original order but add status indicators
			let formatted = "\n";

			todos.forEach((todo, index) => {
				let statusEmoji = "";
				if (todo.status === "completed") {
					statusEmoji = "✅ ";
				} else if (todo.status === "in_progress") {
					statusEmoji = "🔄 ";
				} else if (todo.status === "pending") {
					statusEmoji = "⏳ ";
				}

				// Gemini uses 'description' instead of 'content' for todo items
				const todoText = todo.description || todo.content || "";
				formatted += `${statusEmoji}${todoText}`;
				if (index < todos.length - 1) {
					formatted += "\n";
				}
			});

			return formatted;
		} catch (error) {
			console.error(
				"[GeminiMessageFormatter] Failed to format TodoWrite parameter:",
				error,
			);
			return jsonContent;
		}
	}

	/**
	 * Format Task tool parameter (TaskCreate, TaskUpdate, TaskList, TaskGet)
	 */
	formatTaskParameter(toolName: string, toolInput: FormatterToolInput): string {
		try {
			// If input is already a string, return it
			if (typeof toolInput === "string") {
				return toolInput;
			}

			switch (toolName) {
				case "TaskCreate": {
					// TaskCreate: { subject, description, activeForm? }
					const subject = getString(toolInput, "subject") || "";
					const description = getString(toolInput, "description") || "";
					const activeForm = getString(toolInput, "activeForm");

					let formatted = subject;
					if (description && description !== subject) {
						// Add description if it's different from subject
						formatted += `\n${description}`;
					}
					if (activeForm) {
						formatted += `\n_Active: ${activeForm}_`;
					}
					return formatted;
				}

				case "TaskUpdate": {
					// TaskUpdate: { taskId, status?, subject? }
					const taskId = getString(toolInput, "taskId") || "";
					const status = getString(toolInput, "status");
					const subject = getString(toolInput, "subject");

					let statusEmoji = "";
					if (status === "completed") {
						statusEmoji = "✅";
					} else if (status === "in_progress") {
						statusEmoji = "🔄";
					} else if (status === "pending") {
						statusEmoji = "⏳";
					} else if (status === "deleted") {
						statusEmoji = "🗑️";
					}

					if (subject) {
						return `${statusEmoji} Task #${taskId} — ${subject}`;
					}
					return `${statusEmoji} Task #${taskId}`;
				}

				case "TaskGet": {
					// TaskGet: { taskId, subject? }
					const taskId = getString(toolInput, "taskId") || "";
					const subject = getString(toolInput, "subject") || "";
					if (subject) {
						return `Task #${taskId} — ${subject}`;
					}
					return `Task #${taskId}`;
				}

				case "TaskList": {
					// TaskList: no parameters typically
					return "List all tasks";
				}

				default: {
					// Fallback for unknown Task tool types
					const subject = getString(toolInput, "subject");
					const description = getString(toolInput, "description");
					if (subject) {
						return subject;
					}
					if (description) {
						return description;
					}
					return JSON.stringify(toolInput);
				}
			}
		} catch (error) {
			console.error(
				"[GeminiMessageFormatter] Failed to format Task parameter:",
				error,
			);
			return JSON.stringify(toolInput);
		}
	}

	/**
	 * Format tool input for display in Linear agent activities
	 * Converts raw tool inputs into user-friendly parameter strings
	 */
	formatToolParameter(toolName: string, toolInput: FormatterToolInput): string {
		// If input is already a string, return it
		if (typeof toolInput === "string") {
			return toolInput;
		}

		try {
			switch (toolName) {
				// Gemini tool names
				case "run_shell_command": {
					// Show command only
					const command = getString(toolInput, "command");
					return command || JSON.stringify(toolInput);
				}

				case "read_file": {
					const filePath = getString(toolInput, "file_path");
					if (filePath) {
						let param = filePath;
						const offset = getNumber(toolInput, "offset");
						const limit = getNumber(toolInput, "limit");
						if (offset !== undefined || limit !== undefined) {
							const start = offset || 0;
							const end = limit ? start + limit : "end";
							param += ` (lines ${start + 1}-${end})`;
						}
						return param;
					}
					break;
				}

				case "write_file": {
					const filePath = getString(toolInput, "file_path");
					if (filePath) {
						return filePath;
					}
					break;
				}

				case "replace": {
					// Gemini's replace tool has instruction and file_path
					const filePath = getString(toolInput, "file_path");
					if (filePath) {
						let param = filePath;
						const instruction = getString(toolInput, "instruction");
						if (instruction) {
							param += ` - ${instruction.substring(0, 50)}${instruction.length > 50 ? "..." : ""}`;
						}
						return param;
					}
					break;
				}

				case "search_file_content": {
					const pattern = getString(toolInput, "pattern");
					if (pattern) {
						let param = `Pattern: \`${pattern}\``;
						const path = getString(toolInput, "path");
						if (path) {
							param += ` in ${path}`;
						}
						const glob = getString(toolInput, "glob");
						if (glob) {
							param += ` (${glob})`;
						}
						return param;
					}
					break;
				}

				case "list_directory": {
					const dirPath = getString(toolInput, "dir_path");
					if (dirPath) {
						return dirPath;
					}
					const path = getString(toolInput, "path");
					if (path) {
						return path;
					}
					return ".";
				}

				case "write_todos":
					if (
						hasProperty(toolInput, "todos") &&
						Array.isArray(toolInput.todos)
					) {
						return this.formatTodoWriteParameter(JSON.stringify(toolInput));
					}
					break;

				case "TaskCreate":
				case "TaskUpdate":
				case "TaskGet":
				case "TaskList":
					// Delegate to formatTaskParameter for Task tools
					return this.formatTaskParameter(toolName, toolInput);

				default:
					// For MCP tools or other unknown tools, try to extract meaningful info
					if (toolName.startsWith("mcp__")) {
						// Extract key fields that are commonly meaningful
						const meaningfulFields = [
							"query",
							"id",
							"issueId",
							"title",
							"name",
							"path",
							"file",
						];
						for (const field of meaningfulFields) {
							const value = getString(toolInput, field);
							if (value) {
								return `${field}: ${value}`;
							}
						}
					}
					break;
			}

			// Fallback to JSON but make it compact
			return JSON.stringify(toolInput);
		} catch (error) {
			console.error(
				"[GeminiMessageFormatter] Failed to format tool parameter:",
				error,
			);
			return JSON.stringify(toolInput);
		}
	}

	/**
	 * Format tool action name with description for shell command tool
	 * Puts the description in round brackets after the tool name in the action field
	 */
	formatToolActionName(
		toolName: string,
		toolInput: FormatterToolInput,
		isError: boolean,
	): string {
		// Handle run_shell_command tool with description
		if (toolName === "run_shell_command") {
			const description = getString(toolInput, "description");
			if (description) {
				const baseName = isError ? `${toolName} (Error)` : toolName;
				return `${baseName} (${description})`;
			}
		}

		// Default formatting for other tools
		return isError ? `${toolName} (Error)` : toolName;
	}

	/**
	 * Format tool result for display in Linear agent activities
	 * Converts raw tool results into formatted Markdown
	 */
	formatToolResult(
		toolName: string,
		toolInput: FormatterToolInput,
		result: string,
		isError: boolean,
	): string {
		// If there's an error, wrap in error formatting
		if (isError) {
			return `\`\`\`\n${result}\n\`\`\``;
		}

		try {
			switch (toolName) {
				// Gemini tool names
				case "run_shell_command": {
					let formatted = "";
					const command = getString(toolInput, "command");
					const description = getString(toolInput, "description");
					if (command && !description) {
						formatted += `\`\`\`bash\n${command}\n\`\`\`\n\n`;
					}
					if (result?.trim()) {
						formatted += `\`\`\`\n${result}\n\`\`\``;
					} else {
						formatted += "*No output*";
					}
					return formatted;
				}

				case "read_file": {
					// Gemini CLI returns empty output on success - file content goes into model context
					// Only show content if Gemini actually returns something (which it typically doesn't)
					if (result?.trim()) {
						// Clean up the result: remove line numbers and system-reminder tags
						let cleanedResult = result;

						// Remove line numbers (format: "  123→")
						cleanedResult = cleanedResult.replace(/^\s*\d+→/gm, "");

						// Remove system-reminder blocks
						cleanedResult = cleanedResult.replace(
							/<system-reminder>[\s\S]*?<\/system-reminder>/g,
							"",
						);

						// Trim only blank lines (not horizontal whitespace) to preserve indentation
						cleanedResult = cleanedResult
							.replace(/^\n+/, "")
							.replace(/\n+$/, "");

						// Try to detect language from file extension
						let lang = "";
						const filePath = getString(toolInput, "file_path");
						if (filePath) {
							const ext = filePath.split(".").pop()?.toLowerCase();
							const langMap: Record<string, string> = {
								ts: "typescript",
								tsx: "typescript",
								js: "javascript",
								jsx: "javascript",
								py: "python",
								rb: "ruby",
								go: "go",
								rs: "rust",
								java: "java",
								c: "c",
								cpp: "cpp",
								cs: "csharp",
								php: "php",
								swift: "swift",
								kt: "kotlin",
								scala: "scala",
								sh: "bash",
								bash: "bash",
								zsh: "bash",
								yml: "yaml",
								yaml: "yaml",
								json: "json",
								xml: "xml",
								html: "html",
								css: "css",
								scss: "scss",
								md: "markdown",
								sql: "sql",
							};
							lang = langMap[ext || ""] || "";
						}
						return `\`\`\`${lang}\n${cleanedResult}\n\`\`\``;
					}
					// Gemini returns empty output on success - this is normal, not an empty file
					return "*File read successfully*";
				}

				case "write_file":
					if (result?.trim()) {
						return result;
					}
					return "*File written successfully*";

				case "replace": {
					// For replace/edit, show the instruction if available
					const oldString = getString(toolInput, "old_string");
					const newString = getString(toolInput, "new_string");
					if (oldString && newString) {
						// Format as a unified diff
						const oldLines = oldString.split("\n");
						const newLines = newString.split("\n");

						let diff = "```diff\n";

						for (const line of oldLines) {
							diff += `-${line}\n`;
						}
						for (const line of newLines) {
							diff += `+${line}\n`;
						}

						diff += "```";
						return diff;
					}

					const instruction = getString(toolInput, "instruction");
					if (instruction) {
						return `*${instruction}*\n\n${result || "Edit completed"}`;
					}

					if (result?.trim()) {
						return result;
					}
					return "*Edit completed*";
				}

				case "search_file_content": {
					if (result?.trim()) {
						const lines = result.split("\n");
						if (
							lines.length > 0 &&
							lines[0] &&
							!lines[0].includes(":") &&
							lines[0].trim().length > 0
						) {
							return `Found ${lines.filter((l) => l.trim()).length} matching files:\n\`\`\`\n${result}\n\`\`\``;
						}
						return `\`\`\`\n${result}\n\`\`\``;
					}
					return "*No matches found*";
				}

				case "list_directory": {
					if (result?.trim()) {
						const lines = result.split("\n").filter((l) => l.trim());
						return `Found ${lines.length} items:\n\`\`\`\n${result}\n\`\`\``;
					}
					return "*Empty directory*";
				}

				case "write_todos":
					if (result?.trim()) {
						return result;
					}
					return "*Todos updated*";

				case "TaskCreate":
					// TaskCreate result typically contains task ID
					if (result?.trim()) {
						return `*Task created*\n${result}`;
					}
					return "*Task created*";

				case "TaskUpdate":
					// TaskUpdate result confirmation
					if (result?.trim()) {
						return result;
					}
					return "*Task updated*";

				case "TaskGet":
					// TaskGet returns task details - format as code block if multiline
					if (result?.trim()) {
						if (result.includes("\n")) {
							return `\`\`\`\n${result}\n\`\`\``;
						}
						return result;
					}
					return "*No task found*";

				case "TaskList":
					// TaskList returns list of tasks - format as code block
					if (result?.trim()) {
						return `\`\`\`\n${result}\n\`\`\``;
					}
					return "*No tasks*";

				default:
					// For unknown tools, use code block if result has multiple lines
					if (result?.trim()) {
						if (result.includes("\n") && result.length > 100) {
							return `\`\`\`\n${result}\n\`\`\``;
						}
						return result;
					}
					return "*Completed*";
			}
		} catch (error) {
			console.error(
				"[GeminiMessageFormatter] Failed to format tool result:",
				error,
			);
			return result || "";
		}
	}
}
