import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as readline from "node:readline";
import {
	DEFAULT_BASE_BRANCH,
	DEFAULT_CONFIG_FILENAME,
	type EdgeConfig,
	migrateEdgeConfig,
} from "cyrus-core";
import { getDefaultWorktreesDir } from "../utils/getDefaultWorktreesDir.js";
import { BaseCommand } from "./ICommand.js";

/**
 * Detect the default branch of a cloned repository by reading the remote HEAD ref.
 * Falls back to DEFAULT_BASE_BRANCH ("main") if detection fails.
 */
export function detectDefaultBranch(repositoryPath: string): string {
	try {
		const ref = execSync("git symbolic-ref refs/remotes/origin/HEAD", {
			cwd: repositoryPath,
			encoding: "utf-8",
			stdio: ["pipe", "pipe", "pipe"],
		}).trim();
		// ref looks like "refs/remotes/origin/main" — extract the branch name
		const branch = ref.replace("refs/remotes/origin/", "");
		if (branch) {
			return branch;
		}
	} catch {
		// symbolic-ref not set — try `git remote show origin` as fallback
		try {
			const output = execSync("git remote show origin", {
				cwd: repositoryPath,
				encoding: "utf-8",
				stdio: ["pipe", "pipe", "pipe"],
			});
			const match = output.match(/HEAD branch:\s*(.+)/);
			if (match?.[1]?.trim()) {
				return match[1].trim();
			}
		} catch {
			// Both methods failed, fall through to default
		}
	}
	return DEFAULT_BASE_BRANCH;
}

/**
 * Workspace credentials extracted from existing repository configurations
 */
interface WorkspaceCredentials {
	id: string;
	name: string;
	token: string;
	refreshToken?: string;
}

/**
 * Self-add-repo command - clones a repo and adds it to config.json
 *
 * Usage:
 *   cyrus self-add-repo                      # prompts for everything
 *   cyrus self-add-repo <url>                # prompts for workspace if multiple
 *   cyrus self-add-repo <url> <workspace>    # no prompts
 *   cyrus self-add-repo <url> -l <labels>    # custom routing labels (comma-separated)
 *   cyrus self-add-repo <url> <workspace> -l <labels>
 *
 * Routing labels are used to route Linear issues to this repository.
 * If not specified, defaults to the repository name.
 */
export class SelfAddRepoCommand extends BaseCommand {
	private rl: readline.Interface | null = null;

	private getReadline(): readline.Interface {
		if (!this.rl) {
			this.rl = readline.createInterface({
				input: process.stdin,
				output: process.stdout,
			});
		}
		return this.rl;
	}

	private prompt(question: string): Promise<string> {
		return new Promise((resolve) => {
			this.getReadline().question(question, (answer) => resolve(answer.trim()));
		});
	}

	private cleanup(): void {
		if (this.rl) {
			this.rl.close();
			this.rl = null;
		}
	}

	async execute(args: string[]): Promise<void> {
		// Parse flags
		let customLabels: string[] | null = null;
		let baseBranchFlag: string | null = null;
		const positionalArgs: string[] = [];
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (!arg) continue;
			if ((arg === "-l" || arg === "--label") && args[i + 1]) {
				customLabels = args[i + 1]!.split(",")
					.map((l) => l.trim())
					.filter((l) => l.length > 0);
				i++; // Skip the label value
			} else if ((arg === "-b" || arg === "--base-branch") && args[i + 1]) {
				baseBranchFlag = args[i + 1]!;
				i++; // Skip the branch value
			} else {
				positionalArgs.push(arg);
			}
		}

		let url = positionalArgs[0];
		const workspaceName = positionalArgs[1];

		try {
			// Load config
			const configPath = resolve(this.app.cyrusHome, DEFAULT_CONFIG_FILENAME);
			let config: EdgeConfig;
			try {
				config = migrateEdgeConfig(
					JSON.parse(readFileSync(configPath, "utf-8")),
				) as EdgeConfig;
			} catch {
				this.logError(`Config file not found: ${configPath}`);
				process.exit(1);
			}

			if (!config.repositories) {
				config.repositories = [];
			}

			// Get URL if not provided
			if (!url) {
				url = await this.prompt("Repository URL: ");
				if (!url) {
					this.logError("URL is required");
					process.exit(1);
				}
			}

			// Extract repo name from URL
			const repoName = url
				.split("/")
				.pop()
				?.replace(/\.git$/, "");
			if (!repoName) {
				this.logError("Could not extract repo name from URL");
				process.exit(1);
			}

			// Check for duplicate
			if (
				config.repositories.some(
					(r: EdgeConfig["repositories"][number]) => r.name === repoName,
				)
			) {
				this.logError(`Repository '${repoName}' already exists in config`);
				process.exit(1);
			}

			// Find workspaces with Linear credentials (from workspace-level config)
			const workspaces = new Map<string, WorkspaceCredentials>();
			if (config.linearWorkspaces) {
				for (const [wsId, wsConfig] of Object.entries(
					config.linearWorkspaces,
				)) {
					if (wsConfig.linearToken) {
						workspaces.set(wsId, {
							id: wsId,
							name: wsConfig.linearWorkspaceName || wsId,
							token: wsConfig.linearToken,
							refreshToken: wsConfig.linearRefreshToken,
						});
					}
				}
			}

			if (workspaces.size === 0) {
				this.logError(
					"No Linear credentials found. Run 'cyrus self-auth-linear' first.",
				);
				process.exit(1);
			}

			// Get workspace
			let selectedWorkspace: WorkspaceCredentials;
			const workspaceList = Array.from(workspaces.values());

			if (workspaceList.length === 1) {
				// Safe: we checked length === 1 above
				selectedWorkspace = workspaceList[0]!;
			} else if (workspaceName) {
				const foundWorkspace = workspaceList.find(
					(w) => w.name === workspaceName,
				);
				if (!foundWorkspace) {
					this.logError(`Workspace '${workspaceName}' not found`);
					process.exit(1);
				}
				selectedWorkspace = foundWorkspace;
			} else {
				console.log("\nAvailable workspaces:");
				workspaceList.forEach((w, i) => {
					console.log(`  ${i + 1}. ${w.name}`);
				});
				const choice = await this.prompt(
					`Select workspace [1-${workspaceList.length}]: `,
				);
				const idx = parseInt(choice, 10) - 1;
				if (idx < 0 || idx >= workspaceList.length) {
					this.logError("Invalid selection");
					process.exit(1);
				}
				// Safe: we validated idx is within bounds above
				selectedWorkspace = workspaceList[idx]!;
			}

			// Clone the repo
			const repositoryPath = resolve(this.app.cyrusHome, "repos", repoName);

			if (existsSync(repositoryPath)) {
				console.log(`Repository already exists at ${repositoryPath}`);
			} else {
				console.log(`Cloning ${url}...`);
				try {
					execSync(`git clone ${url} ${repositoryPath}`, { stdio: "inherit" });
				} catch {
					this.logError("Failed to clone repository");
					process.exit(1);
				}
			}

			// Generate UUID and add to config
			const id = randomUUID();
			const routingLabels = customLabels ?? [repoName];

			// Determine base branch: flag > auto-detect > default
			const baseBranch = baseBranchFlag ?? detectDefaultBranch(repositoryPath);
			if (baseBranch !== DEFAULT_BASE_BRANCH) {
				console.log(`Detected base branch: ${baseBranch}`);
			}

			// Detect hosting platform from URL
			const repoConfig: EdgeConfig["repositories"][number] = {
				id,
				name: repoName,
				repositoryPath,
				baseBranch,
				workspaceBaseDir: getDefaultWorktreesDir(this.app.cyrusHome),
				linearWorkspaceId: selectedWorkspace.id,
				isActive: true,
				routingLabels,
			};

			if (url.includes("gitlab.com") || url.includes("gitlab.")) {
				repoConfig.gitlabUrl = url.replace(/\.git$/, "");
			} else if (url.includes("github.com")) {
				repoConfig.githubUrl = url.replace(/\.git$/, "");
			}

			config.repositories.push(repoConfig);

			writeFileSync(configPath, JSON.stringify(config, null, "\t"), "utf-8");

			console.log(`\nAdded: ${repoName}`);
			console.log(`  ID: ${id}`);
			console.log(`  Base branch: ${baseBranch}`);
			console.log(`  Workspace: ${selectedWorkspace.name}`);
			console.log(`  Routing labels: ${routingLabels.join(", ")}`);
			console.log(`\nTo use different routing labels, edit ${configPath}`);
			process.exit(0);
		} finally {
			this.cleanup();
		}
	}
}
