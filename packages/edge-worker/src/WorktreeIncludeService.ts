import {
	copyFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { createLogger, type ILogger } from "cyrus-core";
import ignore, { type Ignore } from "ignore";

/**
 * Service responsible for handling .worktreeinclude file processing
 *
 * The .worktreeinclude file specifies which files ignored by .gitignore
 * should be copied from the main repository to new worktrees.
 *
 * Files must match BOTH .worktreeinclude AND .gitignore patterns to be copied.
 * This ensures only intended ignored files are duplicated.
 */
export class WorktreeIncludeService {
	private logger: ILogger;

	constructor(logger?: ILogger) {
		this.logger =
			logger ?? createLogger({ component: "WorktreeIncludeService" });
	}

	/**
	 * Process .worktreeinclude and copy matching ignored files to the worktree
	 *
	 * @param repositoryPath - Path to the main repository
	 * @param worktreePath - Path to the newly created worktree
	 */
	async copyIgnoredFiles(
		repositoryPath: string,
		worktreePath: string,
	): Promise<void> {
		const worktreeIncludePath = join(repositoryPath, ".worktreeinclude");

		// Check if .worktreeinclude exists
		if (!existsSync(worktreeIncludePath)) {
			// No .worktreeinclude file, nothing to do
			return;
		}

		this.logger.info("Found .worktreeinclude file, processing...");

		// Parse .worktreeinclude patterns
		const worktreeIncludePatterns = this.parsePatternFile(worktreeIncludePath);
		if (worktreeIncludePatterns.length === 0) {
			this.logger.info(".worktreeinclude is empty, nothing to copy");
			return;
		}

		// Parse .gitignore patterns
		const gitignorePath = join(repositoryPath, ".gitignore");
		const gitignorePatterns = existsSync(gitignorePath)
			? this.parsePatternFile(gitignorePath)
			: [];

		if (gitignorePatterns.length === 0) {
			this.logger.warn(
				"No .gitignore found or empty, .worktreeinclude requires files to be gitignored",
			);
			return;
		}

		// Create ignore matchers
		const worktreeIncludeMatcher = ignore().add(worktreeIncludePatterns);
		const gitignoreMatcher = ignore().add(gitignorePatterns);

		// Find files that match both patterns
		const filesToCopy = this.findMatchingFiles(
			repositoryPath,
			worktreeIncludeMatcher,
			gitignoreMatcher,
		);

		if (filesToCopy.length === 0) {
			this.logger.info("No files match both .worktreeinclude and .gitignore");
			return;
		}

		this.logger.info(
			`Copying ${filesToCopy.length} ignored file(s) to worktree...`,
		);

		// Copy each matching file
		for (const relativePath of filesToCopy) {
			const sourcePath = join(repositoryPath, relativePath);
			const destPath = join(worktreePath, relativePath);

			try {
				// Ensure destination directory exists
				const destDir = dirname(destPath);
				if (!existsSync(destDir)) {
					mkdirSync(destDir, { recursive: true });
				}

				copyFileSync(sourcePath, destPath);
				this.logger.info(`  Copied: ${relativePath}`);
			} catch (error) {
				this.logger.warn(
					`  Failed to copy ${relativePath}: ${(error as Error).message}`,
				);
			}
		}

		this.logger.info("Finished copying ignored files");
	}

	/**
	 * Parse a pattern file (like .gitignore or .worktreeinclude)
	 * Returns an array of non-empty, non-comment lines
	 */
	private parsePatternFile(filePath: string): string[] {
		const content = readFileSync(filePath, "utf-8");
		return content
			.split("\n")
			.map((line) => line.trim())
			.filter((line) => line.length > 0 && !line.startsWith("#"));
	}

	/**
	 * Recursively find all files in the repository that match both
	 * .worktreeinclude AND .gitignore patterns
	 */
	private findMatchingFiles(
		repositoryPath: string,
		worktreeIncludeMatcher: Ignore,
		gitignoreMatcher: Ignore,
	): string[] {
		const matchingFiles: string[] = [];

		const walkDirectory = (currentPath: string): void => {
			const entries = readdirSync(currentPath, { withFileTypes: true });

			for (const entry of entries) {
				const fullPath = join(currentPath, entry.name);
				const relativePath = relative(repositoryPath, fullPath);

				// Skip .git directory
				if (entry.name === ".git") {
					continue;
				}

				if (entry.isDirectory()) {
					// Walk into directories to find specific files
					// We don't add directories themselves to the copy list
					walkDirectory(fullPath);
				} else if (entry.isFile()) {
					// Check if file matches both patterns
					const isGitignored = gitignoreMatcher.ignores(relativePath);
					const isWorktreeIncluded =
						worktreeIncludeMatcher.ignores(relativePath);

					if (isGitignored && isWorktreeIncluded) {
						matchingFiles.push(relativePath);
					}
				}
			}
		};

		walkDirectory(repositoryPath);
		return matchingFiles;
	}
}
