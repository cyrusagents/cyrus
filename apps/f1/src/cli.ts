#!/usr/bin/env node

/**
 * F1 CLI - Testing Framework for Cyrus
 *
 * A beautiful command-line interface for interacting with the F1 server.
 * Provides commands for managing issues, sessions, and agent interactions.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { createAssignIssueCommand } from "./commands/assignIssue.js";
import { createCreateCommentCommand } from "./commands/createComment.js";
import { createCreateIssueCommand } from "./commands/createIssue.js";
import { createInitTestRepoCommand } from "./commands/initTestRepo.js";
import { createListChatThreadsCommand } from "./commands/listChatThreads.js";
import { createPingCommand } from "./commands/ping.js";
import { createPromptChatThreadCommand } from "./commands/promptChatThread.js";
import { createPromptSessionCommand } from "./commands/promptSession.js";
import { createStartChatSessionCommand } from "./commands/startChatSession.js";
import { createStartSessionCommand } from "./commands/startSession.js";
import { createStatusCommand } from "./commands/status.js";
import { createStopSessionCommand } from "./commands/stopSession.js";
import { createTerminateIssueCommand } from "./commands/terminateIssue.js";
import { createVersionCommand } from "./commands/version.js";
import { createViewChatThreadCommand } from "./commands/viewChatThread.js";
import { createViewSessionCommand } from "./commands/viewSession.js";
import { bold, cyan } from "./utils/colors.js";

// Get package.json for version info
const __dirname = dirname(fileURLToPath(import.meta.url));
const packageJsonPath = resolve(__dirname, "..", "..", "package.json");
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf-8"));

// Create main program
const program = new Command();

program
	.name("f1")
	.version(packageJson.version as string)
	.description(
		`${bold(cyan("F1 Testing Framework"))} - CLI for Cyrus

A beautiful command-line interface for testing and interacting with
the Cyrus agent system. Manage issues, sessions, and agent activities
without external dependencies.

Environment Variables:
  ${cyan("CYRUS_PORT")}  Port for F1 server (default: 3600)

Examples:
  ${cyan("f1 ping")}                           Health check
  ${cyan('f1 create-issue -t "Fix bug"')}      Create issue
  ${cyan("f1 start-session -i issue-123")}     Start session
  ${cyan("f1 view-session -s session-456")}    View session
  ${cyan("f1 init-test-repo -p /tmp/test")}    Create test repo`,
	);

// Register all commands
program.addCommand(createPingCommand());
program.addCommand(createStatusCommand());
program.addCommand(createVersionCommand());
program.addCommand(createCreateIssueCommand());
program.addCommand(createAssignIssueCommand());
program.addCommand(createCreateCommentCommand());
program.addCommand(createStartSessionCommand());
program.addCommand(createStartChatSessionCommand());
program.addCommand(createListChatThreadsCommand());
program.addCommand(createViewChatThreadCommand());
program.addCommand(createPromptChatThreadCommand());
program.addCommand(createViewSessionCommand());
program.addCommand(createPromptSessionCommand());
program.addCommand(createStopSessionCommand());
program.addCommand(createTerminateIssueCommand());
program.addCommand(createInitTestRepoCommand());

// Parse arguments
program.parse();
