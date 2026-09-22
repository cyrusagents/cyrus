/**
 * Example: CLI Integration with EdgeWorker
 *
 * Shows how the CLI app would integrate the EdgeWorker with:
 * - OAuth token management
 * - Git worktree creation
 * - File-based configuration
 */

import { EdgeWorker } from "atmiko-edge-worker";
import { FSWorkspaceService } from "../cli/adapters/FSWorkspaceService";
import { OAuthHelper } from "../cli/utils/OAuthHelper";

export async function createCLIEdgeWorker(config: any) {
	// Get OAuth token from stored credentials
	const oauthHelper = new OAuthHelper(config.oauth);
	const linearToken = await oauthHelper.getAccessToken();

	if (!linearToken) {
		throw new Error(
			'No Linear OAuth token available. Run "atmiko auth" first.',
		);
	}

	// Create workspace service for git worktrees
	const workspaceService = new FSWorkspaceService(
		config.workspace.baseDir,
		config.workspace.useGitWorktrees,
	);

	// Create EdgeWorker with CLI-specific configuration
	const edgeWorker = new EdgeWorker({
		// Use OAuth token for both proxy and Linear API
		proxyUrl: config.edge.proxyUrl,
		linearToken: linearToken,

		// Claude configuration
		claudePath: config.claude.path,
		linearAllowedTools: config.claude.allowedTools,

		// Workspace configuration
		workspaceBaseDir: config.workspace.baseDir,

		// CLI-specific handlers
		handlers: {
			// Use git worktrees for workspaces
			createWorkspace: async (issue, _repositories) => {
				return await workspaceService.createWorkspace(issue);
			},

			// Log errors to console
			onError: (error, context) => {
				console.error("Edge worker error:", error);
				if (context) {
					console.error("Context:", context);
				}
			},

			// Log session lifecycle for debugging
			onSessionStart: (_issueId, issue) => {
				console.log(
					`🚀 Started processing ${issue.identifier}: ${issue.title}`,
				);
			},

			onSessionEnd: (issueId, exitCode) => {
				console.log(
					`✅ Finished processing issue ${issueId} (exit code: ${exitCode})`,
				);
			},
		},
	});

	// Handle process shutdown
	process.on("SIGINT", async () => {
		console.log("\nShutting down edge worker...");
		await edgeWorker.stop();
		process.exit(0);
	});

	return edgeWorker;
}

// Usage
async function _main() {
	// Load config from file
	const config = loadConfig(); // .env.secret-agents or similar

	try {
		const edgeWorker = await createCLIEdgeWorker(config);
		await edgeWorker.start();

		console.log("✅ Edge worker connected and ready");
	} catch (error) {
		console.error("Failed to start edge worker:", error);
		process.exit(1);
	}
}
