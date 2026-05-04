/**
 * SimpleGeminiRunner usage example
 *
 * This example demonstrates:
 * - Creating a SimpleGeminiRunner for enumerated responses
 * - Handling yes/no questions
 * - Multiple choice scenarios
 * - Classification tasks
 * - Progress event handling
 * - Cost tracking
 */

import * as os from "node:os";
import * as path from "node:path";
import type { SimpleAgentProgressEvent } from "cyrus-simple-agent-runner";
import { SimpleGeminiRunner } from "../src/SimpleGeminiRunner";

// Example 1: Yes/No Question
async function yesNoExample() {
	console.log("=== Example 1: Yes/No Question ===\n");

	const runner = new SimpleGeminiRunner({
		// Required: Valid response options
		validResponses: ["yes", "no"],

		// Required: Home directory for logs
		cyrusHome: path.join(os.homedir(), ".cyrus"),

		// Optional: Working directory (defaults to cwd)
		workingDirectory: process.cwd(),

		// Optional: Model to use
		model: "gemini-2.5-flash",

		// Optional: Maximum conversation turns
		maxTurns: 5,

		// Optional: Timeout in milliseconds
		timeout: 60000, // 1 minute

		// Optional: Progress event handler
		onProgress: (event: SimpleAgentProgressEvent) => {
			console.log(`   [Progress] ${event.type}`);
			if (event.type === "validating" && event.response) {
				console.log(`      Candidate response: "${event.response}"`);
			}
		},
	});

	const prompt = `Is TypeScript a superset of JavaScript?

Please answer with just "yes" or "no".`;

	console.log(`Question: ${prompt}\n`);

	try {
		const result = await runner.query(prompt);

		console.log("\n✅ Response received:");
		console.log(`   Answer: ${result.response}`);
		console.log(`   Cost: $${result.cost.toFixed(4)}`);
		console.log(`   Messages: ${result.messages.length}`);
	} catch (error) {
		console.error("❌ Error:", error);
	}
}

// Example 2: Multiple Choice Question
async function multipleChoiceExample() {
	console.log("\n\n=== Example 2: Multiple Choice Question ===\n");

	const runner = new SimpleGeminiRunner({
		validResponses: ["easy", "medium", "hard", "expert"],
		cyrusHome: path.join(os.homedir(), ".cyrus"),
		workingDirectory: process.cwd(),
		model: "gemini-2.5-flash",
		maxTurns: 5,
		onProgress: (event) => {
			if (event.type === "thinking") {
				console.log("   🤔 Thinking...");
			} else if (event.type === "tool-use") {
				console.log("   🔧 Using tools...");
			} else if (event.type === "validating") {
				console.log(`   ✓ Validating response...`);
			}
		},
	});

	const prompt = `Rate the difficulty of this coding problem:

Write a function that finds the longest palindromic substring in a given string.
Use dynamic programming to achieve O(n²) time complexity.

Rate the difficulty as: easy, medium, hard, or expert`;

	console.log(`Question: ${prompt}\n`);

	try {
		const result = await runner.query(prompt);

		console.log("\n✅ Classification result:");
		console.log(`   Difficulty: ${result.response}`);
		console.log(`   Cost: $${result.cost.toFixed(4)}`);
	} catch (error) {
		console.error("❌ Error:", error);
	}
}

// Example 3: Code Review Approval
async function codeReviewExample() {
	console.log("\n\n=== Example 3: Code Review Approval ===\n");

	const runner = new SimpleGeminiRunner({
		validResponses: ["approve", "reject", "needs-changes"],
		cyrusHome: path.join(os.homedir(), ".cyrus"),
		model: "gemini-2.5-flash",
		maxTurns: 10, // More turns for complex analysis
		systemPrompt: `You are a code reviewer. Analyze code carefully and provide one of the valid responses.`,
	});

	const codeToReview = `
function calculateTotal(items) {
  let total = 0;
  for (let i = 0; i < items.length; i++) {
    total += items[i].price * items[i].quantity;
  }
  return total;
}
`;

	const prompt = `Review this code and decide: approve, reject, or needs-changes

${codeToReview}

Consider:
- Code quality
- Potential bugs
- TypeScript types missing
- Error handling

Respond with ONLY one word: approve, reject, or needs-changes`;

	console.log(`Code to review:\n${codeToReview}\n`);

	try {
		const result = await runner.query(prompt);

		console.log("✅ Review decision:");
		console.log(`   Decision: ${result.response}`);
		console.log(`   Cost: $${result.cost.toFixed(4)}`);

		// Take action based on the result
		switch (result.response) {
			case "approve":
				console.log("\n   ✓ Code approved! Ready to merge.");
				break;
			case "reject":
				console.log("\n   ✗ Code rejected. Major issues found.");
				break;
			case "needs-changes":
				console.log("\n   ⚠ Code needs changes before approval.");
				break;
		}
	} catch (error) {
		console.error("❌ Error:", error);
	}
}

// Example 4: Sentiment Analysis
async function sentimentAnalysisExample() {
	console.log("\n\n=== Example 4: Sentiment Analysis ===\n");

	const runner = new SimpleGeminiRunner({
		validResponses: ["positive", "negative", "neutral"],
		cyrusHome: path.join(os.homedir(), ".cyrus"),
		model: "gemini-2.5-flash",
		maxTurns: 3,
	});

	const texts = [
		"This product exceeded my expectations! Highly recommend.",
		"Terrible experience. Would not buy again.",
		"It works as described. Nothing special.",
	];

	console.log("Analyzing sentiment for multiple texts:\n");

	for (const text of texts) {
		try {
			console.log(`Text: "${text}"`);
			const result = await runner.query(
				`Analyze the sentiment of this text and respond with ONLY one word: positive, negative, or neutral

Text: "${text}"`,
			);

			console.log(`Sentiment: ${result.response}`);
			console.log(`Cost: $${result.cost.toFixed(4)}\n`);
		} catch (error) {
			console.error(`Failed to analyze: ${error}\n`);
		}
	}
}

// Example 5: Advanced - Custom System Prompt and Progress Tracking
async function advancedExample() {
	console.log(
		"\n=== Example 5: Advanced Usage with Custom System Prompt ===\n",
	);

	let progressSteps = 0;

	const runner = new SimpleGeminiRunner({
		validResponses: ["refactor", "keep", "delete"],
		cyrusHome: path.join(os.homedir(), ".cyrus"),
		model: "gemini-2.5-flash",
		maxTurns: 8,

		// Custom system prompt for specific behavior
		systemPrompt: `You are an expert software architect specializing in code quality.
When analyzing code, consider:
- SOLID principles
- Code duplication
- Maintainability
- Performance implications

Be decisive and respond with exactly one of the valid options.`,

		// Detailed progress tracking
		onProgress: (event) => {
			progressSteps++;
			const timestamp = new Date().toISOString();

			switch (event.type) {
				case "thinking":
					console.log(
						`   [${timestamp}] Step ${progressSteps}: Analyzing code...`,
					);
					break;
				case "tool-use":
					console.log(
						`   [${timestamp}] Step ${progressSteps}: Using analysis tools...`,
					);
					break;
				case "validating":
					console.log(
						`   [${timestamp}] Step ${progressSteps}: Validating response: "${event.response}"`,
					);
					break;
			}
		},
	});

	const code = `
// Legacy utility function
function add(a, b) {
  return a + b;
}

function subtract(a, b) {
  return a - b;
}

function multiply(a, b) {
  return a * b;
}

// Only used once in the codebase
function divide(a, b) {
  if (b === 0) throw new Error('Division by zero');
  return a / b;
}
`;

	const prompt = `Should we refactor, keep, or delete this code?

${code}

Context: This is in a large TypeScript codebase. The functions are used frequently except divide() which is used only once.

Respond with ONLY: refactor, keep, or delete`;

	console.log(`Analyzing code...\n`);

	try {
		const result = await runner.query(prompt);

		console.log(`\n✅ Architectural decision: ${result.response}`);
		console.log(`   Total progress steps: ${progressSteps}`);
		console.log(`   Cost: $${result.cost.toFixed(4)}`);
		console.log(`   Total messages: ${result.messages.length}`);
	} catch (error) {
		console.error("❌ Analysis failed:", error);
	}
}

// Example 6: Error Handling and Timeout
async function errorHandlingExample() {
	console.log("\n\n=== Example 6: Error Handling and Timeout ===\n");

	const runner = new SimpleGeminiRunner({
		validResponses: ["valid-response"],
		cyrusHome: path.join(os.homedir(), ".cyrus"),
		model: "gemini-2.5-flash",
		maxTurns: 2, // Very low to trigger potential failure
		timeout: 10000, // 10 second timeout
	});

	// Intentionally difficult prompt that may not get the exact response
	const prompt = `This is a test of error handling.
Please respond with the exact text "valid-response" (this is unlikely to happen naturally).`;

	console.log("Testing error handling with difficult constraints...\n");

	try {
		const result = await runner.query(prompt);
		console.log(`✅ Got response: ${result.response}`);
	} catch (error) {
		if (error instanceof Error) {
			console.log(`✓ Caught expected error: ${error.message}`);
			console.log(
				`   This demonstrates proper error handling when validation fails.`,
			);
		} else {
			console.error("❌ Unexpected error type:", error);
		}
	}
}

// Main execution
async function main() {
	console.log("=== SimpleGeminiRunner Examples ===\n");
	console.log(
		"This demo shows various use cases for enumerated response scenarios.\n",
	);

	try {
		// Run examples sequentially
		await yesNoExample();
		await multipleChoiceExample();
		await codeReviewExample();
		await sentimentAnalysisExample();
		await advancedExample();
		await errorHandlingExample();

		console.log("\n\n✅ All examples completed!\n");
	} catch (error) {
		console.error("\n❌ Fatal error running examples:", error);
		process.exit(1);
	}
}

// Run if executed directly
if (require.main === module) {
	main();
}

export {
	advancedExample,
	codeReviewExample,
	errorHandlingExample,
	multipleChoiceExample,
	sentimentAnalysisExample,
	yesNoExample,
};
