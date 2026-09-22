import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Manages system prompts for Gemini CLI by writing them to disk
 * and configuring the GEMINI_SYSTEM_MD environment variable.
 *
 * Unlike Claude runner which can accept system prompts directly,
 * Gemini CLI requires system prompts to be in a file on disk.
 *
 * Supports parallel execution by using unique file paths per workspace.
 */
export class SystemPromptManager {
	private atmikoHome: string;
	private systemPromptPath: string;

	constructor(atmikoHome: string, workspaceName: string) {
		this.atmikoHome = atmikoHome;
		// Use workspace-specific path to support parallel execution
		// Format: ~/.atmiko/gemini-system-prompts/<workspace-name>.md
		// NOTE: Workspace-name is the Linear issue identifier
		const promptsDir = join(this.atmikoHome, "gemini-system-prompts");
		this.systemPromptPath = join(promptsDir, `${workspaceName}.md`);
	}

	/**
	 * Write system prompt to disk and return the path to be used with GEMINI_SYSTEM_MD
	 */
	async prepareSystemPrompt(dynamicSystemPrompt: string): Promise<string> {
		try {
			// Ensure prompts directory exists
			const promptsDir = join(this.atmikoHome, "gemini-system-prompts");
			await mkdir(promptsDir, { recursive: true });

			// Get Gemini system prompt, which we will append
			const __filename = fileURLToPath(import.meta.url);
			const __dirname = dirname(__filename);
			const subroutinePromptPath = join(__dirname, "prompts", "system.md");

			const geminiSystemPrompt = await readFile(subroutinePromptPath, "utf-8");
			const completeSystemPrompt = geminiSystemPrompt + dynamicSystemPrompt;

			// Write system prompt to workspace-specific file
			await writeFile(this.systemPromptPath, completeSystemPrompt, "utf8");

			console.log(
				`[SystemPromptManager] Wrote system prompt to: ${this.systemPromptPath}`,
			);

			return this.systemPromptPath;
		} catch (error) {
			console.error(
				"[SystemPromptManager] Failed to write system prompt:",
				error,
			);
			throw error;
		}
	}

	/**
	 * Get the path where system prompts are stored for this workspace
	 */
	getSystemPromptPath(): string {
		return this.systemPromptPath;
	}

	/**
	 * Resolve tilde (~) in paths to absolute home directory path
	 */
	static resolveTildePath(path: string): string {
		if (path.startsWith("~/")) {
			return join(homedir(), path.slice(2));
		}
		return path;
	}
}
