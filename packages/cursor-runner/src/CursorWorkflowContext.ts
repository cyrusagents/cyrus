import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { AgentRunnerConfig } from "cyrus-core";

/** Expose Cyrus instructions and scoped skills on every turn and through Cursor's skill directory. */
export class CursorWorkflowContext {
	private skills = new Map<string, string>();
	private availableSkills = new Set<string>();

	constructor(private readonly config: AgentRunnerConfig) {}

	stage(workspace: string): void {
		this.cleanup();
		const allowed = Array.isArray(this.config.skills)
			? new Set(this.config.skills)
			: undefined;
		const sources = [
			...(this.config.plugins ?? [])
				.filter((plugin) => plugin.type === "local")
				.map((plugin) => join(plugin.path, "skills")),
			...[workspace, ...(this.config.additionalDirectories ?? [])].map((root) =>
				join(root, ".claude", "skills"),
			),
		];
		for (const source of sources) {
			if (!existsSync(source)) continue;
			for (const entry of readdirSync(source, { withFileTypes: true })) {
				if (
					(!entry.isDirectory() && !entry.isSymbolicLink()) ||
					(allowed && !allowed.has(entry.name))
				)
					continue;
				const origin = resolve(source, entry.name);
				if (!existsSync(join(origin, "SKILL.md"))) continue;
				const relative = `.cursor/skills/${entry.name}`;
				const target = join(workspace, relative);
				// Preserve project-owned skills, including dangling symlinks.
				try {
					lstatSync(target);
					if (existsSync(join(target, "SKILL.md")))
						this.availableSkills.add(target);
					continue;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
				}
				mkdirSync(dirname(target), { recursive: true });
				this.ignore(workspace, relative);
				symlinkSync(origin, target, "dir");
				this.skills.set(target, origin);
				this.availableSkills.add(target);
			}
		}
	}

	buildPrompt(workspace: string, prompt: string): string {
		const instructions = this.config.appendSystemPrompt?.trim();
		if (!instructions && this.availableSkills.size === 0) return prompt;
		const parts = [
			`Working directory: ${workspace}. Use this directory explicitly for shell commands and file operations.`,
			instructions,
			this.availableSkills.size
				? "Cyrus workflow skills (read the relevant SKILL.md with file tools):\n" +
					[...this.availableSkills]
						.map((path) => `- ${join(path, "SKILL.md")}`)
						.join("\n")
				: undefined,
		].filter(Boolean);
		return `<cyrus_session_context>\n${parts.join("\n\n")}\n</cyrus_session_context>\n\n${prompt}`;
	}

	getSkillNames(): string[] {
		return [...this.availableSkills].map((path) => basename(path));
	}

	cleanup(): void {
		for (const [target, origin] of this.skills) {
			try {
				if (readlinkSync(target) === origin) rmSync(target);
			} catch {
				/* preserve replacements and never mask the session result */
			}
		}
		this.skills.clear();
		this.availableSkills.clear();
	}

	private ignore(workspace: string, relative: string): void {
		try {
			const raw = execFileSync(
				"git",
				["rev-parse", "--git-path", "info/exclude"],
				{
					cwd: workspace,
					encoding: "utf8",
					stdio: ["ignore", "pipe", "ignore"],
				},
			).trim();
			const path = isAbsolute(raw) ? raw : join(workspace, raw);
			const pattern = `/${relative}`;
			const content = existsSync(path) ? readFileSync(path, "utf8") : "";
			if (content.split(/\r?\n/).includes(pattern)) return;
			mkdirSync(dirname(path), { recursive: true });
			appendFileSync(path, `${content.endsWith("\n") ? "" : "\n"}${pattern}\n`);
		} catch {
			/* Non-git chat workspaces still receive the instructions. */
		}
	}
}
