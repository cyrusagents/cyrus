#!/usr/bin/env node

/**
 * Simple test script for claude-runner
 *
 * This script demonstrates how to use the ClaudeRunner class to start
 * a Claude session and interact with it programmatically.
 */

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ClaudeRunner } from "../dist/index.js";

// Load environment variables from .env file
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
dotenv.config({ path: join(__dirname, "..", ".env") });

async function main() {
	console.log("🚀 Starting Claude Runner Test");

	// Verify env variable is loaded
	if (!process.env.LINEAR_API_TOKEN) {
		console.error("❌ LINEAR_API_TOKEN not found in environment variables!");
		console.error(
			"Make sure .env file exists in the claude-runner package directory",
		);
		process.exit(1);
	}
	console.log("✅ LINEAR_API_TOKEN loaded from .env");

	// Configure the runner
	const config = {
		// Working directory for Claude to operate in
		workingDirectory: "/Users/agentops/code/hello-world-project",

		// Atmiko home directory for logs and state
		atmikoHome: "/tmp/simple-test-atmiko-home",

		// Use tools matching hello-world config
		allowedTools: [
			"Read",
			"Edit",
			"Write",
			"Glob",
			"Grep",
			"Task",
			"WebFetch",
			"WebSearch",
			"TaskCreate",
			"TaskUpdate",
			"TaskGet",
			"TaskList",
			"NotebookEdit",
			"Bash",
			"Skill",
			// MCP tools from @tacticlaunch/mcp-linear server
			// See: https://docs.anthropic.com/en/docs/claude-code/iam#tool-specific-permission-rules
			"mcp__linear",

			// Old tools from the official Linear MCP server (SSE based)
			// "mcp__linear__list_comments",
			// "mcp__linear__create_comment",
			// "mcp__linear__list_cycles",
			// "mcp__linear__get_document",
			// "mcp__linear__list_documents",
			// "mcp__linear__get_issue",
			// "mcp__linear__list_issues",
			// "mcp__linear__create_issue",
			// "mcp__linear__update_issue",
			// "mcp__linear__list_issue_statuses",
			// "mcp__linear__get_issue_status",
			// "mcp__linear__list_my_issues",
			// "mcp__linear__list_issue_labels",
			// "mcp__linear__list_projects",
			// "mcp__linear__get_project",
			// "mcp__linear__create_project",
			// "mcp__linear__update_project",
			// "mcp__linear__list_teams",
			// "mcp__linear__get_team",
			// "mcp__linear__list_users",
			// "mcp__linear__get_user",
			// "mcp__linear__search_documentation"
		],

		// Workspace name for logging
		workspaceName: "claude-runner-test",

		// MCP configuration - using official Linear HTTP MCP server
		mcpConfig: {
			linear: {
				type: "http",
				url: "https://mcp.linear.app/mcp",
				headers: {
					Authorization: `Bearer ${process.env.LINEAR_API_TOKEN}`,
				},
			},
		},

		// System prompt to guide Claude's behavior
		systemPrompt:
			"You are a helpful assistant. Please be concise and clear in your responses.",

		// Event handlers
		onMessage: (message) => {
			console.log(`📧 Message received: ${message.type}`);

			// Handle different message types
			switch (message.type) {
				case "assistant":
					if (message.message?.content) {
						console.log("🤖 Assistant content:");
						message.message.content.forEach((block, index) => {
							if (block.type === "text") {
								console.log(`   ${index + 1}. Text: ${block.text}`);
							} else if (block.type === "tool_use") {
								console.log(`   ${index + 1}. Tool use: ${block.name}`);
								console.log(
									`      Input: ${JSON.stringify(block.input, null, 2)}`,
								);
							}
						});
					}
					break;

				case "user":
					if (message.message?.content) {
						console.log("👤 User content:");
						message.message.content.forEach((block, index) => {
							if (block.type === "tool_result") {
								console.log(
									`   ${index + 1}. Tool result for: ${block.tool_use_id}`,
								);
								// Parse and pretty-print the tool result
								try {
									const result =
										typeof block.content === "string"
											? JSON.parse(block.content)
											: block.content;
									console.log(
										`      Result: ${JSON.stringify(result, null, 8)}`,
									);
								} catch (_e) {
									// If it's not JSON, just print it as-is
									console.log(`      Result: ${block.content}`);
								}
							}
						});
					}
					break;

				case "system":
					console.log("⚙️ System message received");
					if (message.tools) {
						console.log("📋 Available tools:", message.tools);
					}
					if (message.mcp_servers) {
						console.log("🔌 MCP servers:", message.mcp_servers);
					}
					break;

				case "result":
					console.log("🏁 Session result received");
					break;

				default:
					console.log(`❓ Unknown message type: ${message.type}`);
			}
		},

		onError: (error) => {
			console.error("❌ Error occurred:", error.message);
			console.error("📚 Stack trace:", error.stack);
		},

		onComplete: (messages) => {
			console.log(`✅ Session completed with ${messages.length} messages`);
			console.log("📊 Message types summary:");
			const typeCounts = messages.reduce((acc, msg) => {
				acc[msg.type] = (acc[msg.type] || 0) + 1;
				return acc;
			}, {});
			console.log(typeCounts);
		},
	};

	// Create the runner
	const runner = new ClaudeRunner(config);

	// Set up additional event listeners
	runner.on("text", (text) => {
		console.log(`💬 Text output: ${text}`);
	});

	runner.on("tool-use", (toolName, input) => {
		console.log(`🔧 Tool used: ${toolName}`);
		console.log(`📥 Tool input: ${JSON.stringify(input, null, 2)}`);
	});

	// Test prompt - check what tools are available first
	const testPrompt = `
First, tell me what tools you have available by looking at the system message.
Are there any tools starting with "mcp__linear__"?
If yes, try using mcp__linear__linear_getViewer to get info about the current user.
Then try mcp__linear__linear_getIssues to list issues.
If no, tell me what MCP-related tools you see (if any).
  `.trim();

	console.log("\n📝 Test prompt:");
	console.log(testPrompt);
	console.log(`\n${"=".repeat(50)}`);

	try {
		// Start the session
		const sessionInfo = await runner.start(testPrompt);

		console.log(`\n${"=".repeat(50)}`);
		console.log("🎉 Session completed successfully!");
		console.log(`📊 Session ID: ${sessionInfo.sessionId}`);
		console.log(`🕐 Started at: ${sessionInfo.startedAt}`);
		console.log(
			`🔄 Final status: ${sessionInfo.isRunning ? "Running" : "Completed"}`,
		);

		// Get final messages
		const allMessages = runner.getMessages();
		console.log(`📨 Total messages: ${allMessages.length}`);

		console.log("\n🎯 Session completed successfully!");
	} catch (error) {
		console.error("\n💥 Session failed:", error.message);
		console.error("📚 Full error:", error);
		process.exit(1);
	}
}

// Handle process signals gracefully
process.on("SIGINT", () => {
	console.log("\n🛑 Received SIGINT, shutting down...");
	process.exit(0);
});

process.on("SIGTERM", () => {
	console.log("\n🛑 Received SIGTERM, shutting down...");
	process.exit(0);
});

// Run the test
main().catch((error) => {
	console.error("💥 Unhandled error:", error);
	process.exit(1);
});
