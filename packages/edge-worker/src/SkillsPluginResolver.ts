import { access, mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SdkPluginConfig } from "cyrus-claude-runner";
import type { ILogger } from "cyrus-core";

/**
 * Resolves skills plugins for agent sessions.
 *
 * Two plugin sources are supported:
 * 1. Internal plugin — default Cyrus workflow skills deployed to ~/.cyrus/cyrus-skills-plugin/
 *    (editable by the user)
 * 2. User skills plugin — custom skills managed by the CYHOST UI at ~/.cyrus/user-skills-plugin/
 *
 * Both live outside the repository so they are never committed to the user's repo.
 *
 * Plugin ordering: user plugin is loaded before internal plugin so that
 * user-defined skills take precedence over internal skills with the same name.
 */
export class SkillsPluginResolver {
	private readonly internalPluginPath: string;
	private readonly userPluginPath: string;
	private readonly userSkillsDir: string;

	constructor(
		private readonly cyrusHome: string,
		private readonly logger: ILogger,
	) {
		this.internalPluginPath = join(this.cyrusHome, "cyrus-skills-plugin");
		this.userPluginPath = join(this.cyrusHome, "user-skills-plugin");
		this.userSkillsDir = join(this.userPluginPath, "skills");
	}

	/**
	 * Ensure the user skills plugin directory is properly initialized.
	 * Call once during EdgeWorker startup — NOT on every session.
	 *
	 * Separated from resolve() to maintain Command-Query Separation:
	 * this method writes to the filesystem, resolve() only reads.
	 */
	async ensureUserPluginScaffolded(): Promise<void> {
		if (!(await this.exists(this.userSkillsDir))) {
			return;
		}

		const manifestDir = join(this.userPluginPath, ".claude-plugin");
		const manifestPath = join(manifestDir, "plugin.json");
		if (await this.exists(manifestPath)) {
			return;
		}

		await mkdir(manifestDir, { recursive: true });
		await writeFile(
			manifestPath,
			JSON.stringify(
				{
					name: "user-skills",
					description: "User-created skills managed by Cyrus",
				},
				null,
				"\t",
			),
		);
		this.logger.info(
			`Auto-scaffolded user skills plugin manifest at ${manifestPath}`,
		);
	}

	/**
	 * Resolve all available skills plugins (user + internal).
	 *
	 * User plugin is listed first so user-defined skills take precedence
	 * over internal skills with the same name.
	 *
	 * Pure query — no filesystem side effects.
	 */
	async resolve(): Promise<SdkPluginConfig[]> {
		const plugins: SdkPluginConfig[] = [];

		// User plugin first — user skills override internal skills
		const user = await this.resolveUserPlugin();
		if (user) {
			plugins.push(user);
		}

		const internal = await this.resolveInternalPlugin();
		if (internal) {
			plugins.push(internal);
		}

		await this.logConflicts(plugins);

		return plugins;
	}

	/**
	 * Discover all available skill names from the given plugin configs.
	 *
	 * Reads the `skills/` subdirectory of each plugin path and returns
	 * deduplicated skill names (user skills shadow internal ones due to
	 * insertion order of the Set).
	 */
	async discoverSkillNames(plugins: SdkPluginConfig[]): Promise<string[]> {
		const skillNames: string[] = [];

		for (const plugin of plugins) {
			const skillsDir = join(plugin.path, "skills");
			try {
				const entries = await readdir(skillsDir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.isDirectory() || entry.isSymbolicLink()) {
						skillNames.push(entry.name);
					}
				}
			} catch {
				// Plugin directory doesn't exist or isn't readable — skip
			}
		}

		return [...new Set(skillNames)];
	}

	/**
	 * Build the skills guidance block appended to system prompts.
	 *
	 * Dynamically lists all available skills so that user-added custom
	 * skills appear in the guidance without code changes (OCP).
	 *
	 * Accepts pre-resolved plugins to avoid redundant filesystem access
	 * when resolve() is also called separately for the runner config.
	 */
	async buildSkillsGuidance(plugins?: SdkPluginConfig[]): Promise<string> {
		const resolvedPlugins = plugins ?? (await this.resolve());
		const availableSkills = await this.discoverSkillNames(resolvedPlugins);

		if (availableSkills.length === 0) {
			return "";
		}

		const skillsList = availableSkills.map((s) => `\`${s}\``).join(", ");

		return (
			"\n\n## Skills\n\n" +
			`You have skills available via the Skill tool: ${skillsList}\n\n` +
			"Choose the appropriate skill based on the context:\n\n" +
			"- **Code changes requested** (feature, bug fix, refactor): Use `implementation` to write code, then `verify-and-ship` to run checks and create a PR, then `summarize` to narrate results.\n" +
			"- **Bug report or error**: Use `debug` to reproduce, root-cause, and fix, then `verify-and-ship`, then `summarize`.\n" +
			"- **Question or research request**: Use `investigate` to search the codebase and provide an answer, then `summarize`.\n" +
			"- **PR review feedback** (changes requested): Use `implementation` to address review comments, then `verify-and-ship`.\n\n" +
			"Analyze the issue description, labels, and any user comments to determine which workflow fits. " +
			"Do NOT skip the verify-and-ship step if you made code changes — it ensures quality checks pass and a PR is created."
		);
	}

	private async resolveInternalPlugin(): Promise<SdkPluginConfig | null> {
		if (await this.exists(this.internalPluginPath)) {
			this.logger.debug(
				`Using internal skills plugin at ${this.internalPluginPath}`,
			);
			return { type: "local", path: this.internalPluginPath };
		}
		this.logger.warn(
			`No internal skills plugin found at ${this.internalPluginPath}`,
		);
		return null;
	}

	private async resolveUserPlugin(): Promise<SdkPluginConfig | null> {
		const manifestPath = join(
			this.userPluginPath,
			".claude-plugin",
			"plugin.json",
		);
		if (!(await this.exists(manifestPath))) {
			return null;
		}

		this.logger.debug(`Using user skills plugin at ${this.userPluginPath}`);
		return { type: "local", path: this.userPluginPath };
	}

	/**
	 * Detect and log skill name conflicts between user and internal plugins.
	 */
	private async logConflicts(plugins: SdkPluginConfig[]): Promise<void> {
		if (plugins.length < 2) {
			return;
		}

		const skillSets: string[][] = [];
		for (const plugin of plugins) {
			const skillsDir = join(plugin.path, "skills");
			try {
				const entries = await readdir(skillsDir, { withFileTypes: true });
				skillSets.push(
					entries
						.filter((e) => e.isDirectory() || e.isSymbolicLink())
						.map((e) => e.name),
				);
			} catch {
				skillSets.push([]);
			}
		}

		// First set is user, second is internal — find overlap
		if (skillSets.length >= 2 && skillSets[0] && skillSets[1]) {
			const userSkills = new Set(skillSets[0]);
			const conflicts = skillSets[1].filter((s) => userSkills.has(s));
			if (conflicts.length > 0) {
				this.logger.info(
					`User skills override internal skills: ${conflicts.join(", ")}`,
				);
			}
		}
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await access(path);
			return true;
		} catch {
			return false;
		}
	}
}
