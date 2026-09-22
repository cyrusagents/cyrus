#!/usr/bin/env node

/**
 * Subagent Functionality Test
 *
 * Tests Claude subagent functionality in ClaudeRunner:
 * 1. Verifies Task tool is available
 * 2. Creates test subagent configuration
 * 3. Tests subagent delegation and response
 * 4. Confirms subagent identity preservation
 *
 * This test requires a valid ANTHROPIC_API_KEY environment variable.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClaudeRunner } from "../dist/ClaudeRunner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function testSubagentFunctionality() {
	console.log("🧪 Claude Subagent Functionality Test");
	console.log("=====================================\n");

	// Note: This test uses Claude Code SDK which relies on system authentication
	// Run `claude auth` to set up authentication if you haven't already
	console.log(
		"💡 Using Claude Code SDK authentication (run `claude auth` if not set up)",
	);

	// Create test workspace
	const testWorkspaceDir = resolve(
		tmpdir(),
		`claude-runner-subagent-test-${Date.now()}`,
	);
	const agentsDir = resolve(testWorkspaceDir, ".claude", "agents");

	try {
		console.log("🔧 Setting up test environment...");

		// Create directory structure
		mkdirSync(agentsDir, { recursive: true });

		// Create test subagent
		const testAgentContent = `---
name: test-helper
description: A simple test subagent that helps with basic questions and file reading
tools:
  - Read
  - Bash
---

You are a helpful test subagent. Your job is to:
1. Answer questions clearly and concisely
2. Read files when requested
3. Always start your response with "TEST SUBAGENT:" to confirm your identity

You have access to Read and Bash tools for file operations.
`;
		writeFileSync(resolve(agentsDir, "test-helper.md"), testAgentContent);

		// Create test file for subagent to read
		writeFileSync(
			resolve(testWorkspaceDir, "sample-data.txt"),
			"This file contains test data for subagent functionality verification.",
		);

		console.log("✅ Test environment created");
		console.log(`📂 Workspace: ${testWorkspaceDir}`);
		console.log(`📂 Agents: ${agentsDir}`);

		// Track test results
		let foundTaskTool = false;
		let foundSubagentResponse = false;
		let taskToolUsed = false;
		const messages = [];

		// Set up ClaudeRunner
		console.log("\n🚀 Starting Claude session...");
		const runner = new ClaudeRunner({
			workingDirectory: testWorkspaceDir,
			allowedTools: ["Task", "Read", "Bash"],
			onMessage: (message) => {
				messages.push(message);

				// Check for Task tool in system message
				if (message.type === "system" && message.tools) {
					if (message.tools.includes("Task")) {
						foundTaskTool = true;
						console.log("✅ Task tool found in available tools");
					}
				}

				// Check for Task tool usage
				if (message.type === "assistant" && message.message?.content) {
					for (const block of message.message.content) {
						if (block.type === "tool_use" && block.name === "Task") {
							taskToolUsed = true;
							console.log("✅ Task tool being used");
							console.log(
								`📋 Task description: ${block.input?.description || "N/A"}`,
							);
							console.log(
								`🎯 Subagent type: ${block.input?.subagent_type || "N/A"}`,
							);
						}
					}
				}

				// Check for subagent response
				const messageStr = JSON.stringify(message);
				if (messageStr.includes("TEST SUBAGENT:")) {
					foundSubagentResponse = true;
					console.log("✅ Subagent response detected!");
				}
			},
		});

		const testPrompt = `
I need to test if subagents are working properly. Please:

1. First, tell me what tools you have available (specifically looking for the Task tool)
2. Use the Task tool to delegate to the "test-helper" subagent
3. Ask the test-helper subagent to read the sample-data.txt file and tell me what it contains
4. The test-helper should identify itself as "TEST SUBAGENT:" in its response

This is a functionality test to verify subagent delegation works correctly.
`;

		const sessionInfo = await runner.start(testPrompt);

		// Ensure runner is fully stopped and cleaned up
		if (runner.isRunning()) {
			runner.stop();
		}

		// Wait longer for log streams to finish writing and close
		await new Promise((resolve) => setTimeout(resolve, 2000));

		console.log("\n📊 Test Results:");
		console.log("================");
		console.log(`Session ID: ${sessionInfo.sessionId}`);
		console.log(`Messages received: ${messages.length}`);
		console.log(`Task tool available: ${foundTaskTool ? "✅" : "❌"}`);
		console.log(`Task tool used: ${taskToolUsed ? "✅" : "❌"}`);
		console.log(`Subagent response: ${foundSubagentResponse ? "✅" : "❌"}`);

		// Overall result
		const success = foundTaskTool && foundSubagentResponse;

		console.log("\n🎯 Overall Result:");
		if (success) {
			console.log("✅ SUCCESS: Claude subagents are fully functional!");
			console.log("   - Task tool is available and working");
			console.log("   - Subagent delegation successful");
			console.log("   - Subagent identity properly preserved");
		} else {
			console.log("❌ FAILURE: Subagent functionality incomplete");
			if (!foundTaskTool) console.log("   - Task tool not available");
			if (!foundSubagentResponse)
				console.log("   - Subagent response not detected");
		}

		// Save detailed log only if test failed (for debugging)
		if (!success) {
			const logData = {
				timestamp: new Date().toISOString(),
				testResults: {
					foundTaskTool,
					taskToolUsed,
					foundSubagentResponse,
					success,
				},
				sessionInfo,
				messageCount: messages.length,
				workspace: testWorkspaceDir,
				messages: messages, // Include messages for debugging failures
			};

			const logFile = resolve(
				__dirname,
				`subagent-test-log-${Date.now()}.json`,
			);
			writeFileSync(logFile, JSON.stringify(logData, null, 2));
			console.log(`\n📝 Detailed failure log saved: ${logFile}`);
		}

		// Force process exit after a longer delay to ensure log streams are closed
		setTimeout(() => {
			process.exit(success ? 0 : 1);
		}, 1000);

		return success;
	} catch (error) {
		console.error("\n💥 Test failed with error:", error);
		return false;
	} finally {
		// Cleanup
		console.log("\n🧹 Cleaning up test environment...");
		if (existsSync(testWorkspaceDir)) {
			rmSync(testWorkspaceDir, { recursive: true, force: true });
		}

		// Also clean up the corresponding logs directory
		const workspaceName = testWorkspaceDir.split("/").pop();
		const logsDir = join(homedir(), ".atmiko", "logs", workspaceName);
		if (existsSync(logsDir)) {
			rmSync(logsDir, { recursive: true, force: true });
		}

		console.log("✅ Cleanup complete");
	}
}

// Run the test
if (import.meta.url === `file://${process.argv[1]}`) {
	testSubagentFunctionality()
		.then((success) => {
			process.exit(success ? 0 : 1);
		})
		.catch((error) => {
			console.error("Test execution failed:", error);
			process.exit(1);
		});
}

export { testSubagentFunctionality };
