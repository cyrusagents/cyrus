#!/usr/bin/env bun

/**
 * F1 Server - Testing Framework Server for Cyrus
 *
 * This server starts the EdgeWorker in CLI platform mode, providing
 * a complete testing environment for the Cyrus agent system without
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
 *   CYRUS_PORT=3600 CYRUS_REPO_PATH=/path/to/repo bun run server.ts
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAllTools } from "cyrus-claude-runner";
import {
	type EdgeWorkerConfig,
	getDefaultReposDir,
	getDefaultWorktreesDir,
	type RepositoryConfig,
} from "cyrus-core";
import { EdgeWorker } from "cyrus-edge-worker";
import type { SlackWebhookEvent } from "cyrus-slack-event-transport";
import { bold, cyan, dim, gray, green, success } from "./src/utils/colors.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CYRUS_PORT = Number.parseInt(process.env.CYRUS_PORT || "3600", 10);
const CYRUS_REPO_PATH = process.env.CYRUS_REPO_PATH || process.cwd();
const CYRUS_HOME = join(tmpdir(), `cyrus-f1-${Date.now()}`);
const DEFAULT_REPOS_BASE_DIR = getDefaultReposDir(CYRUS_HOME);
const DEFAULT_WORKTREES_BASE_DIR = getDefaultWorktreesDir(CYRUS_HOME);
// Optional second repository path for multi-repo orchestration testing
const CYRUS_REPO_PATH_2 = process.env.CYRUS_REPO_PATH_2;
const MULTI_REPO_MODE = Boolean(CYRUS_REPO_PATH_2);

// Validate port
if (Number.isNaN(CYRUS_PORT) || CYRUS_PORT < 1 || CYRUS_PORT > 65535) {
	console.error(`❌ Invalid CYRUS_PORT: ${process.env.CYRUS_PORT}`);
	console.error("   Port must be between 1 and 65535");
	process.exit(1);
}

// Validate repository path
if (!existsSync(CYRUS_REPO_PATH)) {
	console.error(`❌ Repository path does not exist: ${CYRUS_REPO_PATH}`);
	console.error("   Set CYRUS_REPO_PATH to a valid directory");
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
		CYRUS_HOME,
		DEFAULT_REPOS_BASE_DIR,
		DEFAULT_WORKTREES_BASE_DIR,
		join(CYRUS_HOME, "mcp-configs"),
		join(CYRUS_HOME, "state"),
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
		repositoryPath: CYRUS_REPO_PATH,
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
	if (MULTI_REPO_MODE && CYRUS_REPO_PATH_2) {
		const secondaryRepository: RepositoryConfig = {
			id: "f1-test-repo-secondary",
			name: "F1 Secondary Repository",
			repositoryPath: CYRUS_REPO_PATH_2,
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
		cyrusHome: CYRUS_HOME,
		serverPort: CYRUS_PORT,
		serverHost: "localhost",
		claudeDefaultModel: "sonnet",
		claudeDefaultFallbackModel: "haiku",
		// Enable all tools including Edit(**), Bash, etc. for full testing capability
		linearAllowedTools: getAllTools(),
		// CLI platform needs a linearWorkspaces entry so the CLIIssueTrackerService
		// gets created for the workspace ID referenced in the repository configs
		linearWorkspaces: {
			"cli-workspace": {
				linearToken: "cli-mode-no-token-needed",
			},
		},
		// Enable egress proxy sandbox when CYRUS_SANDBOX=1 is set.
		// The proxy only intercepts Bash-spawned subprocess traffic (git, gh, npm, etc.).
		// Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
		//
		// No networkPolicy = allow-all mode (passthrough with logging).
		// To test deny-all + explicit allows with transforms, set CYRUS_SANDBOX_POLICY=1.
		...(process.env.CYRUS_SANDBOX === "1" && {
			sandbox: {
				enabled: true,
				httpProxyPort: 19080,
				socksProxyPort: 19081,
				logRequests: true,
				// User-defined policy: deny-all default, explicit allows with transforms.
				// Only enabled with CYRUS_SANDBOX_POLICY=1 since F1 test repos lack
				// GitHub remotes and don't need network restrictions.
				...(process.env.CYRUS_SANDBOX_POLICY === "1" && {
					networkPolicy: {
						allow: {
							"github.com": [
								{
									transform: [
										{
											headers: {
												"X-Cyrus-Egress": "verified",
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
												"X-Cyrus-Egress": "verified",
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
		`  ${cyan("Server:")}    ${bold(`http://localhost:${CYRUS_PORT}`)}`,
	);
	console.log(
		`  ${cyan("RPC:")}       ${bold(`http://localhost:${CYRUS_PORT}/cli/rpc`)}`,
	);
	console.log(`  ${cyan("Platform:")}  ${bold("cli")}`);
	console.log(`  ${cyan("Cyrus Home:")} ${dim(CYRUS_HOME)}`);
	console.log(`  ${cyan("Repository:")} ${dim(CYRUS_REPO_PATH)}`);
	if (MULTI_REPO_MODE) {
		console.log(
			`  ${cyan("Multi-Repo:")} ${bold("enabled")} (${dim(CYRUS_REPO_PATH_2 || "")})`,
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
		// Exercises the Slack → AgentSessionLifecycleService → ClaudeRunner code path without
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
