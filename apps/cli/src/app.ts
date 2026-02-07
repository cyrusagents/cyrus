#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { Application } from "./Application.js";
import { AuthCommand } from "./commands/AuthCommand.js";
import { CheckTokensCommand } from "./commands/CheckTokensCommand.js";
import { RefreshTokenCommand } from "./commands/RefreshTokenCommand.js";
import { SelfAddRepoCommand } from "./commands/SelfAddRepoCommand.js";
import { SelfAuthCommand } from "./commands/SelfAuthCommand.js";
import { StartCommand } from "./commands/StartCommand.js";

// Get the directory of the current module for reading package.json
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Read package.json to get the actual version
// When compiled, this is in dist/src/, so we need to go up two levels
const packageJsonPath = resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Setup Commander program
const program = new Command();

program
	.name("cyrus")
	.description("AI-powered Linear issue automation using Claude")
	.version(packageJson.version)
	.option(
		"--cyrus-home <path>",
		"Specify custom Cyrus config directory",
		resolve(homedir(), ".cyrus"),
	)
	.option("--env-file <path>", "Path to environment variables file");

// Start command (default)
program
	.command("start", { isDefault: true })
	.description("Start the edge worker")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
		);
		await new StartCommand(app).execute([]);
	});

// Auth command
program
	.command("auth <auth-key>")
	.description("Authenticate with Cyrus using auth key")
	.action(async (authKey: string) => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
		);
		await new AuthCommand(app).execute([authKey]);
	});

// Check tokens command
program
	.command("check-tokens")
	.description("Check the status of all Linear tokens")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
		);
		await new CheckTokensCommand(app).execute([]);
	});

// Refresh token command
program
	.command("refresh-token")
	.description("Refresh a specific Linear token")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
		);
		await new RefreshTokenCommand(app).execute([]);
	});

// Self-auth command - Linear OAuth directly from CLI
program
	.command("self-auth")
	.description("Authenticate with Linear OAuth directly")
	.action(async () => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
		);
		await new SelfAuthCommand(app).execute([]);
	});

// Self-add-repo command - Clone and add repository
program
	.command("self-add-repo <url> [workspace]")
	.description(
		'Clone a repo and add it to config. URL accepts any valid git clone address (e.g., "https://github.com/org/repo.git"). Workspace is the display name of the Linear workspace (e.g., "My Workspace"). Use -l for comma-separated routing labels (defaults to repo name).',
	)
	.action(async (url?: string, workspace?: string) => {
		const opts = program.opts();
		const app = new Application(
			opts.cyrusHome,
			opts.envFile,
			packageJson.version,
		);
		await new SelfAddRepoCommand(app).execute(
			[url, workspace].filter(Boolean) as string[],
		);
	});

// Parse and execute
(async () => {
	try {
		await program.parseAsync(process.argv);
	} catch (error) {
		console.error("Fatal error:", error);
		process.exit(1);
	}
})();
