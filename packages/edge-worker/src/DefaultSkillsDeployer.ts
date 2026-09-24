import { createHash, randomUUID } from "node:crypto";
import {
	cp,
	lstat,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "miko-core";

/** Refresh bundled defaults while preserving locally edited or deleted skills. */
export class DefaultSkillsDeployer {
	private readonly bundledSkillsPath: string;
	private readonly deployedPluginPath: string;
	private readonly deployedSkillsPath: string;
	private readonly manifestDir: string;
	private readonly manifestPath: string;

	constructor(
		private readonly mikoHome: string,
		private readonly logger: ILogger,
		bundledSkillsDir?: string,
		private readonly previousBundledSkillsDir = process.env
			.MIKO_PREVIOUS_SKILLS_DIR,
	) {
		// Default: skills live alongside the compiled JS in dist/, placed there
		// by the copy-prompts build step. Callers (e.g. tests) can override.
		this.bundledSkillsPath =
			bundledSkillsDir ??
			join(
				dirname(fileURLToPath(import.meta.url)),
				"miko-skills-plugin",
				"skills",
			);
		this.deployedPluginPath = join(this.mikoHome, "miko-skills-plugin");
		this.deployedSkillsPath = join(this.deployedPluginPath, "skills");
		this.manifestDir = join(this.deployedPluginPath, ".claude-plugin");
		this.manifestPath = join(this.manifestDir, "plugin.json");
	}

	async ensureDeployed(): Promise<void> {
		if (!(await this.exists(this.bundledSkillsPath))) {
			this.logger.warn(
				`Bundled skills not found at ${this.bundledSkillsPath} — cannot deploy defaults`,
			);
			return;
		}
		await mkdir(this.deployedSkillsPath, { recursive: true });
		await mkdir(this.manifestDir, { recursive: true });
		if (!(await this.exists(this.manifestPath))) {
			await writeFile(
				this.manifestPath,
				JSON.stringify(
					{
						name: "miko-skills",
						description: "Default Miko workflow skills for agent sessions",
					},
					null,
					"\t",
				),
			);
		}
		const baselinePath = join(this.deployedPluginPath, ".bundled-skills.json");
		let baseline: Record<string, string> = {};
		try {
			const raw: unknown = JSON.parse(await readFile(baselinePath, "utf8"));
			if (raw && typeof raw === "object" && !Array.isArray(raw)) {
				baseline = Object.fromEntries(
					Object.entries(raw).filter(
						([key, value]) =>
							/^[a-zA-Z0-9_-]+$/.test(key) &&
							typeof value === "string" &&
							/^[a-f0-9]{64}$/.test(value),
					),
				);
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT")
				this.logger.warn(
					"Cannot read bundled skill baseline; preserving unmatched local skills",
				);
		}
		const next = { ...baseline };
		const names = new Set<string>();
		for (const entry of await readdir(this.bundledSkillsPath, {
			withFileTypes: true,
		})) {
			if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
			const name = entry.name;
			names.add(name);
			const src = join(this.bundledSkillsPath, name);
			const dest = join(this.deployedSkillsPath, name);
			const bundled = await this.fingerprint(src, true);
			if (!bundled) continue;
			const local = await this.fingerprint(dest);
			// Older installations had no baseline. Compare them against the
			// previous installed release supplied by the verified launcher.
			const previous =
				baseline[name] ??
				(this.previousBundledSkillsDir
					? await this.fingerprint(
							join(this.previousBundledSkillsDir, name),
							true,
						)
					: null);
			if (local === bundled) {
				next[name] = bundled;
			} else if (
				(local && local === previous) ||
				(!(await this.exists(dest)) && !previous)
			) {
				await this.replaceSkill(src, dest);
				next[name] = bundled;
				this.logger.info(`Updated default skill: ${name}`);
			} else {
				// Keep the old baseline: restoring a skill to its original content
				// later opts it back into managed updates. Deletions are intentional.
				if (previous) next[name] = previous;
				this.logger.debug(`Preserving customized or removed skill: ${name}`);
			}
		}
		for (const [name, digest] of Object.entries(baseline)) {
			if (names.has(name)) continue;
			const dest = join(this.deployedSkillsPath, name);
			if ((await this.fingerprint(dest)) === digest) {
				await rm(dest, { recursive: true });
				delete next[name];
			}
		}
		const temporary = `${baselinePath}.${randomUUID()}.tmp`;
		await writeFile(temporary, JSON.stringify(next, null, "\t"));
		await rename(temporary, baselinePath);
	}

	private async fingerprint(
		path: string,
		bundled = false,
	): Promise<string | null> {
		try {
			const hash = createHash("sha256");
			const visit = async (
				directory: string,
				prefix = "",
			): Promise<boolean> => {
				for (const entry of (
					await readdir(directory, { withFileTypes: true })
				).sort((a, b) => a.name.localeCompare(b.name))) {
					const relative = `${prefix}${entry.name}`;
					const file = join(directory, entry.name);
					if (entry.isDirectory()) {
						if (!(await visit(file, `${relative}/`))) return false;
					} else if (entry.isFile()) {
						hash
							.update(relative)
							.update("\0")
							.update(await readFile(file))
							.update("\0");
					} else return false;
				}
				return true;
			};
			// Never follow a user-created symlink when updating deployed skills.
			if (!bundled && (await lstat(path)).isSymbolicLink()) return null;
			return (await visit(path)) ? hash.digest("hex") : null;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
			throw error;
		}
	}

	private async replaceSkill(src: string, dest: string): Promise<void> {
		const temporary = `${dest}.update-${randomUUID()}`;
		const backup = `${dest}.previous-${randomUUID()}`;
		await cp(src, temporary, { recursive: true, dereference: true });
		const hadPrevious = await this.exists(dest);
		if (hadPrevious) await rename(dest, backup);
		try {
			await rename(temporary, dest);
		} catch (error) {
			if (hadPrevious) await rename(backup, dest);
			throw error;
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
		await rm(backup, { recursive: true, force: true });
	}

	private async exists(path: string): Promise<boolean> {
		try {
			await lstat(path);
			return true;
		} catch {
			return false;
		}
	}
}
