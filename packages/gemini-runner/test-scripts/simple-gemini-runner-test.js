#!/usr/bin/env node

/**
 * Simple test script to demonstrate SimpleGeminiRunner functionality
 *
 * This script demonstrates:
 * 1. Creating a SimpleGeminiRunner instance with enumerated responses
 * 2. Querying with a simple prompt
 * 3. Getting a constrained response from the valid set
 *
 * To run: node test-scripts/simple-gemini-runner-test.js
 */

import os from "node:os";
import path from "node:path";
import { SimpleGeminiRunner } from "../dist/SimpleGeminiRunner.js";

// ANSI color codes for output
const colors = {
	reset: "\x1b[0m",
	bright: "\x1b[1m",
	green: "\x1b[32m",
	yellow: "\x1b[33m",
	blue: "\x1b[34m",
	cyan: "\x1b[36m",
};

function log(message, color = "reset") {
	console.log(`${colors[color]}${message}${colors.reset}`);
}

async function main() {
	log("\n========================================", "bright");
	log("SimpleGeminiRunner Demonstration", "bright");
	log("========================================\n", "bright");

	try {
		// Create SimpleGeminiRunner with enumerated responses
		log("1. Creating SimpleGeminiRunner instance...", "cyan");
		log("   Valid responses: ['yes', 'no', 'maybe']", "blue");

		const runner = new SimpleGeminiRunner({
			validResponses: ["yes", "no", "maybe"],
			atmikoHome: path.join(os.homedir(), ".atmiko"),
			workingDirectory: process.cwd(),
			model: "gemini-2.5-flash",
			maxTurns: 5,
			systemPrompt:
				"You are a helpful assistant that answers questions concisely.",
		});

		log("   ✓ Runner created successfully\n", "green");

		// Example 1: Simple yes/no question
		log("2. Querying: 'Is TypeScript a programming language?'", "cyan");
		log("   Expecting response from: ['yes', 'no', 'maybe']\n", "blue");

		const result = await runner.query(
			"Is TypeScript a programming language? Please respond with just: yes, no, or maybe.",
		);

		log(`   Response: ${result.response}`, "green");
		log(`   Session ID: ${result.sessionId}`, "blue");
		log(
			`   Valid: ${result.validResponses.includes(result.response)}\n`,
			"green",
		);

		log("========================================", "bright");
		log("Test completed successfully!", "green");
		log("========================================\n", "bright");
	} catch (error) {
		log("\n❌ Error during test:", "yellow");
		if (error instanceof Error) {
			log(`   ${error.message}`, "yellow");
			if (error.stack) {
				log(`\nStack trace:`, "yellow");
				log(error.stack, "yellow");
			}
		} else {
			log(`   ${String(error)}`, "yellow");
		}
		process.exit(1);
	}
}

main().catch((error) => {
	console.error("Unhandled error:", error);
	process.exit(1);
});
