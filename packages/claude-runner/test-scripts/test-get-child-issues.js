#!/usr/bin/env node

import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { ClaudeRunner } from "../dist/ClaudeRunner.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load .env file from parent directory
dotenv.config({ path: path.join(__dirname, "..", ".env") });

async function testGetChildIssues() {
	const linearToken = process.env.LINEAR_API_TOKEN;

	if (!linearToken) {
		console.error("LINEAR_API_TOKEN is required but not set in .env file");
		process.exit(1);
	}

	console.log("Starting test for linear_get_child_issues tool...\n");

	const runner = new ClaudeRunner({
		includeSystemRole: true,
		apiKey: "test-key", // Not needed for MCP operations
		mcpConfig: {
			"atmiko-tools": {
				type: "inline-sdk",
				module: path.join(
					__dirname,
					"..",
					"dist",
					"tools",
					"atmiko-tools",
					"index.js",
				),
				initParams: [linearToken],
				// For testing, don't set up session management callbacks
			},
		},
	});

	try {
		await runner.start();
		console.log("✅ ClaudeRunner started successfully\n");

		// List available tools
		const toolList = await runner.listTools();
		console.log("Available Atmiko tools:");
		const atmikoTools = toolList.tools.filter((tool) =>
			tool.name.startsWith("linear_"),
		);
		for (const tool of atmikoTools) {
			console.log(`  - ${tool.name}: ${tool.description}`);
		}
		console.log("");

		// Check if our new tool is available
		const hasGetChildIssues = atmikoTools.some(
			(tool) => tool.name === "linear_get_child_issues",
		);
		if (hasGetChildIssues) {
			console.log("✅ linear_get_child_issues tool is available\n");
		} else {
			console.error("❌ linear_get_child_issues tool not found!");
			process.exit(1);
		}

		// Test the tool with a sample issue identifier
		// Replace with an actual issue that has child issues in your Linear workspace
		const testIssueId = process.argv[2] || "CYHOST-91";

		console.log(`Testing linear_get_child_issues with issue: ${testIssueId}`);
		console.log(
			"Options: includeCompleted=true, includeArchived=false, limit=10\n",
		);

		const result = await runner.callTool("linear_get_child_issues", {
			issueId: testIssueId,
			limit: 10,
			includeCompleted: true,
			includeArchived: false,
		});

		if (result.content && result.content.length > 0) {
			const response = JSON.parse(result.content[0].text);

			if (response.success) {
				console.log("✅ Tool executed successfully!\n");
				console.log(
					`Parent Issue: ${response.parentIssue.identifier} - ${response.parentIssue.title}`,
				);
				console.log(`Parent URL: ${response.parentIssue.url}`);
				console.log(`Number of child issues: ${response.childCount}\n`);

				if (response.children.length > 0) {
					console.log("Child Issues:");
					for (const child of response.children) {
						console.log(`  - ${child.identifier}: ${child.title}`);
						console.log(
							`    State: ${child.state} | Assignee: ${child.assignee || "Unassigned"}`,
						);
						console.log(
							`    Priority: ${child.priorityLabel || "No priority"}`,
						);
						console.log(`    URL: ${child.url}`);
						console.log("");
					}
				} else {
					console.log("No child issues found for this parent issue.");
				}
			} else {
				console.error("❌ Tool execution failed:");
				console.error(response.error);
			}
		} else {
			console.error("❌ No response from tool");
		}

		// Test with different options
		console.log("\n--- Testing with includeCompleted=false ---\n");

		const activeOnlyResult = await runner.callTool("linear_get_child_issues", {
			issueId: testIssueId,
			limit: 10,
			includeCompleted: false,
			includeArchived: false,
		});

		if (activeOnlyResult.content && activeOnlyResult.content.length > 0) {
			const response = JSON.parse(activeOnlyResult.content[0].text);

			if (response.success) {
				console.log(`Active child issues only: ${response.childCount} found`);
				if (response.children.length > 0) {
					for (const child of response.children) {
						console.log(
							`  - ${child.identifier}: ${child.title} (${child.state})`,
						);
					}
				}
			}
		}
	} catch (error) {
		console.error("Test failed:", error);
		process.exit(1);
	} finally {
		await runner.stop();
		console.log("\n✅ Test completed");
	}
}

testGetChildIssues().catch((error) => {
	console.error("Unhandled error:", error);
	process.exit(1);
});
