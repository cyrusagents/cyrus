#!/usr/bin/env bun

/**
 * F1 Server - Testing Framework Server for Miko
 *
 * This server starts the EdgeWorker in CLI platform mode, providing
 * a complete testing environment for the Miko agent system without
 * external dependencies.
 *
 * Features:
 * - EdgeWorker configured with platform: "cli"
 * - Creates temporary directories for worktrees
 * - Beautiful colored connection info display
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Zero `any` types
 *
 * Usage:
 *   MIKO_PORT=3600 MIKO_REPO_PATH=/path/to/repo bun run server.ts
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllTools } from "miko-claude-runner";
import {
	type EdgeWorkerConfig,
	getDefaultReposDir,
	getDefaultWorktreesDir,
	type RepositoryConfig,
} from "miko-core";
import { EdgeWorker, registerManagedUpdates } from "miko-edge-worker";
import type { SlackWebhookEvent } from "miko-slack-event-transport";
import { bold, cyan, dim, gray, green, success } from "./src/utils/colors.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const MIKO_PORT = Number.parseInt(process.env.MIKO_PORT || "3600", 10);
const MIKO_REPO_PATH = process.env.MIKO_REPO_PATH || process.cwd();
const MIKO_HOME = join(tmpdir(), `miko-f1-${Date.now()}`);
const DEFAULT_REPOS_BASE_DIR = getDefaultReposDir(MIKO_HOME);
const DEFAULT_WORKTREES_BASE_DIR = getDefaultWorktreesDir(MIKO_HOME);
// Optional second repository path for multi-repo orchestration testing
const MIKO_REPO_PATH_2 = process.env.MIKO_REPO_PATH_2;
const MULTI_REPO_MODE = Boolean(MIKO_REPO_PATH_2);

// Validate port
if (Number.isNaN(MIKO_PORT) || MIKO_PORT < 1 || MIKO_PORT > 65535) {
	console.error(`❌ Invalid MIKO_PORT: ${process.env.MIKO_PORT}`);
	console.error("   Port must be between 1 and 65535");
	process.exit(1);
}

// Validate repository path
if (!existsSync(MIKO_REPO_PATH)) {
	console.error(`❌ Repository path does not exist: ${MIKO_REPO_PATH}`);
	console.error("   Set MIKO_REPO_PATH to a valid directory");
	process.exit(1);
}

// ============================================================================
// DIRECTORY SETUP
// ============================================================================

/**
 * Create required directories for F1 testing
 */
function setupDirectories(): void {
	const requiredDirs = [
		MIKO_HOME,
		DEFAULT_REPOS_BASE_DIR,
		DEFAULT_WORKTREES_BASE_DIR,
		join(MIKO_HOME, "mcp-configs"),
		join(MIKO_HOME, "state"),
	];

	for (const dir of requiredDirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}

// ============================================================================
// EDGEWORKER CONFIGURATION
// ============================================================================

/**
 * Create EdgeWorker configuration for CLI platform
 */
function createEdgeWorkerConfig(): EdgeWorkerConfig {
	// Create primary test repository configuration
	const repository: RepositoryConfig = {
		id: "f1-test-repo",
		name: "F1 Test Repository",
		repositoryPath: MIKO_REPO_PATH,
		baseBranch: "main",
		githubUrl: "https://github.com/f1-test/primary-repo",
		linearWorkspaceId: "cli-workspace",
		workspaceBaseDir: DEFAULT_WORKTREES_BASE_DIR,
		isActive: true,
		// Routing configuration for multi-repo support
		routingLabels: ["primary", "main-repo"],
		teamKeys: ["PRIMARY"],
		// Label-based system prompt configuration for F1 testing
		// This enables testing of label-based orchestrator/debugger/builder/scoper modes
		labelPrompts: {
			debugger: {
				labels: ["bug", "Bug", "debugger", "Debugger"],
			},
			builder: {
				labels: ["feature", "Feature", "builder", "Builder", "enhancement"],
			},
			scoper: {
				labels: ["scope", "Scope", "scoper", "Scoper", "research", "Research"],
			},
			orchestrator: {
				labels: ["orchestrator", "Orchestrator"],
			},
			"graphite-orchestrator": {
				labels: ["graphite-orchestrator"],
			},
			graphite: {
				labels: ["graphite", "Graphite"],
			},
		},
	};

	const repositories: RepositoryConfig[] = [repository];

	// Add second repository if multi-repo mode is enabled
	if (MULTI_REPO_MODE && MIKO_REPO_PATH_2) {
		const secondaryRepository: RepositoryConfig = {
			id: "f1-test-repo-secondary",
			name: "F1 Secondary Repository",
			repositoryPath: MIKO_REPO_PATH_2,
			baseBranch: "main",
			githubUrl: "https://github.com/f1-test/secondary-repo",
			linearWorkspaceId: "cli-workspace", // Same workspace for routing test
			workspaceBaseDir: join(DEFAULT_WORKTREES_BASE_DIR, "secondary"),
			isActive: true,
			// Different routing labels for second repo
			routingLabels: ["secondary", "backend"],
			teamKeys: ["SECONDARY"],
			projectKeys: ["Backend Project"],
			labelPrompts: {
				debugger: {
					labels: ["bug", "Bug"],
				},
				builder: {
					labels: ["feature", "Feature"],
				},
			},
		};
		repositories.push(secondaryRepository);
	}

	const config: EdgeWorkerConfig = {
		platform: "cli" as const,
		repositories,
		mikoHome: MIKO_HOME,
		serverPort: MIKO_PORT,
		serverHost: "localhost",
		claudeDefaultModel: "sonnet",
		claudeDefaultFallbackModel: "haiku",
		// Env-gated runner selection for harness validation (default unchanged).
		// e.g. MIKO_DEFAULT_RUNNER=codex to exercise the Codex (app-server) path.
		...(process.env.MIKO_DEFAULT_RUNNER && {
			defaultRunner: process.env.MIKO_DEFAULT_RUNNER as
				| "claude"
				| "gemini"
				| "codex"
				| "cursor",
		}),
		codexDefaultModel: process.env.CODEX_MODEL || "gpt-5.5",
		// Enable all tools including Edit(**), Bash, etc. for full testing capability
		linearAllowedTools: getAllTools(),
		// CLI platform needs a linearWorkspaces entry so the CLIIssueTrackerService
		// gets created for the workspace ID referenced in the repository configs
		linearWorkspaces: {
			"cli-workspace": {
				linearToken: "cli-mode-no-token-needed",
			},
		},
		// Enable egress proxy sandbox when MIKO_SANDBOX=1 is set.
		// The proxy only intercepts Bash-spawned subprocess traffic (git, gh, npm, etc.).
		// Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
		//
		// No networkPolicy = allow-all mode (passthrough with logging).
		// To test deny-all + explicit allows with transforms, set MIKO_SANDBOX_POLICY=1.
		...(process.env.MIKO_SANDBOX === "1" && {
			sandbox: {
				enabled: true,
				httpProxyPort: 19080,
				socksProxyPort: 19081,
				logRequests: true,
				// User-defined policy: deny-all default, explicit allows with transforms.
				// Only enabled with MIKO_SANDBOX_POLICY=1 since F1 test repos lack
				// GitHub remotes and don't need network restrictions.
				...(process.env.MIKO_SANDBOX_POLICY === "1" && {
					networkPolicy: {
						allow: {
							"github.com": [
								{
									transform: [
										{
											headers: {
												"X-Miko-Egress": "verified",
											},
										},
									],
								},
							],
							"api.github.com": [
								{
									transform: [
										{
											headers: {
												"X-Miko-Egress": "verified",
											},
										},
									],
								},
							],
							// Subprocess dependencies (npm, etc.)
							"registry.npmjs.org": [],
						},
					},
				}),
			},
		}),
	};

	return config;
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

/**
 * Display beautiful server connection info
 */
function displayConnectionInfo(): void {
	const divider = gray("─".repeat(60));

	console.log(`\n${divider}`);
	console.log(bold(green("  🏎️  F1 Testing Framework Server")));
	console.log(divider);
	console.log(success("Server started successfully"));
	console.log("");
	console.log(
		`  ${cyan("Server:")}    ${bold(`http://localhost:${MIKO_PORT}`)}`,
	);
	console.log(
		`  ${cyan("RPC:")}       ${bold(`http://localhost:${MIKO_PORT}/cli/rpc`)}`,
	);
	console.log(`  ${cyan("Platform:")}  ${bold("cli")}`);
	console.log(`  ${cyan("Miko Home:")} ${dim(MIKO_HOME)}`);
	console.log(`  ${cyan("Repository:")} ${dim(MIKO_REPO_PATH)}`);
	if (MULTI_REPO_MODE) {
		console.log(
			`  ${cyan("Multi-Repo:")} ${bold("enabled")} (${dim(MIKO_REPO_PATH_2 || "")})`,
		);
		console.log(
			dim("  Routing context will be included in orchestrator prompts"),
		);
	}
	console.log("");
	console.log(dim("  Press Ctrl+C to stop the server"));
	console.log(`${divider}\n`);
}

/**
 * Main server startup function
 */
async function startServer(): Promise<void> {
	try {
		// Setup directories
		setupDirectories();

		// Create EdgeWorker configuration
		const config = createEdgeWorkerConfig();

		// Initialize EdgeWorker
		const edgeWorker = new EdgeWorker(config);

		// Setup graceful shutdown
		const shutdown = async (signal: string): Promise<void> => {
			console.log(`\n\n${dim(`Received ${signal}, shutting down...`)}`);
			try {
				await edgeWorker.stop();
				console.log(success("Server stopped gracefully"));
				process.exit(0);
			} catch (error) {
				console.error(`❌ Error during shutdown: ${error}`);
				process.exit(1);
			}
		};

		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));

		// Register F1 test-only HTTP route for dispatching synthetic Slack chat events
		// BEFORE starting EdgeWorker — Fastify rejects new routes after listen().
		// Exercises the Slack → ChatSessionHandler → ClaudeRunner code path without
		// going through Slack signature verification.
		const fastify = edgeWorker
			.getSharedApplicationServer()
			.getFastifyInstance();
		fastify.post("/cli/dispatch-chat", async (request, reply) => {
			const body =
				(request.body as {
					channel?: string;
					user?: string;
					text?: string;
					threadTs?: string;
				}) ?? {};
			const ts = `${Date.now() / 1000}`;
			const channel = body.channel ?? "C_F1_CHAN";
			const event: SlackWebhookEvent = {
				eventType: "app_mention",
				eventId: `f1-${ts}`,
				teamId: "f1-test-team",
				slackBotToken: undefined,
				payload: {
					type: "app_mention",
					user: body.user ?? "U_F1_USER",
					text: body.text ?? "hello",
					ts,
					channel,
					...(body.threadTs ? { thread_ts: body.threadTs } : {}),
					event_ts: ts,
				},
			};
			try {
				await edgeWorker.dispatchChatTestEvent(event);
				const threadKey = `${channel}:${body.threadTs || ts}`;
				reply.send({ ok: true, eventId: event.eventId, threadKey });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				reply.code(500).send({ ok: false, error: message });
			}
		});

		// List active chat threads (threadKey → sessionId)
		fastify.get("/cli/chat-threads", async (_request, reply) => {
			reply.send({ ok: true, threads: edgeWorker.listChatThreads() });
		});

		// Fetch the last assistant reply for a chat thread (polled by F1 to
		// observe agent output when no real Slack channel is available).
		fastify.get("/cli/chat-thread", async (request, reply) => {
			const query = (request.query as { threadKey?: string }) ?? {};
			if (!query.threadKey) {
				reply.code(400).send({ ok: false, error: "threadKey required" });
				return;
			}
			const result = edgeWorker.getChatThreadLastReply(query.threadKey);
			if (!result) {
				reply
					.code(404)
					.send({ ok: false, error: `thread not found: ${query.threadKey}` });
				return;
			}
			reply.send({ ok: true, threadKey: query.threadKey, ...result });
		});

		// Start EdgeWorker
		await edgeWorker.start();
		registerManagedUpdates(
			() => edgeWorker.prepareForUpdate(),
			() => shutdown("managed launcher"),
			process,
			() => edgeWorker.activateAfterUpdate(),
		);

		// Display connection info
		displayConnectionInfo();
	} catch (error) {
		console.error(`❌ Failed to start server: ${error}`);
		if (error instanceof Error) {
			console.error(dim(`   ${error.message}`));
			if (error.stack) {
				console.error(dim(error.stack));
			}
		}
		process.exit(1);
	}
}

// ============================================================================
// RUN
// ============================================================================

startServer();
