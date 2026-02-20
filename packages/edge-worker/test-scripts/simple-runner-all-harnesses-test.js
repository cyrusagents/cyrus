#!/usr/bin/env node

/**
 * Test script to verify all 4 SimpleRunner implementations work end-to-end.
 *
 * Tests: SimpleClaudeRunner, SimpleGeminiRunner, SimpleCodexRunner, SimpleCursorRunner
 *
 * Each runner is asked a simple yes/no/maybe question and must return a valid
 * constrained response from the enumerated set.
 *
 * To run: node test-scripts/simple-runner-all-harnesses-test.js
 */

import os from "node:os";
import path from "node:path";
import { SimpleCodexRunner } from "cyrus-codex-runner";
import { SimpleCursorRunner } from "cyrus-cursor-runner";
import { SimpleGeminiRunner } from "cyrus-gemini-runner";
// Import all SimpleRunner implementations
import { SimpleClaudeRunner } from "cyrus-simple-agent-runner";

const VALID_RESPONSES = ["yes", "no", "maybe"];
const TEST_PROMPT =
	"Is TypeScript a superset of JavaScript? Please respond with just one word: yes, no, or maybe.";

const results = [];

async function testRunner(name, RunnerClass, model) {
	console.log(`\n--- Testing ${name} (model: ${model}) ---`);
	const start = Date.now();

	try {
		const runner = new RunnerClass({
			validResponses: VALID_RESPONSES,
			cyrusHome: path.join(os.homedir(), ".cyrus"),
			workingDirectory: process.cwd(),
			model,
			maxTurns: 3,
			timeoutMs: 120000,
			systemPrompt:
				"You are a helpful assistant. Answer concisely with exactly one word.",
			onProgress: (event) => {
				if (event.type === "response-detected") {
					console.log(
						`  [progress] response-detected: ${event.candidateResponse}`,
					);
				} else if (event.type === "started") {
					console.log(`  [progress] started (sessionId: ${event.sessionId})`);
				}
			},
		});

		const result = await runner.query(TEST_PROMPT);
		const elapsed = Date.now() - start;

		console.log(`  Response: "${result.response}"`);
		console.log(`  Valid: ${VALID_RESPONSES.includes(result.response)}`);
		console.log(`  Session ID: ${result.sessionId}`);
		console.log(`  Duration: ${elapsed}ms`);

		results.push({
			runner: name,
			model,
			response: result.response,
			valid: VALID_RESPONSES.includes(result.response),
			sessionId: result.sessionId,
			elapsed,
			success: true,
		});
	} catch (error) {
		const elapsed = Date.now() - start;
		console.error(`  ERROR: ${error.message}`);
		results.push({
			runner: name,
			model,
			error: error.message,
			elapsed,
			success: false,
		});
	}
}

async function main() {
	console.log("=== SimpleRunner All-Harnesses Test ===");
	console.log(`Prompt: "${TEST_PROMPT}"`);
	console.log(`Valid responses: ${JSON.stringify(VALID_RESPONSES)}`);

	// Test each runner sequentially to avoid resource contention
	await testRunner("SimpleClaudeRunner", SimpleClaudeRunner, "haiku");
	await testRunner(
		"SimpleGeminiRunner",
		SimpleGeminiRunner,
		"gemini-2.5-flash",
	);
	await testRunner("SimpleCodexRunner", SimpleCodexRunner, "gpt-5");
	await testRunner(
		"SimpleCursorRunner",
		SimpleCursorRunner,
		"gpt-5.1-codex-mini",
	);

	// Summary
	console.log("\n=== RESULTS SUMMARY ===");
	console.log(JSON.stringify(results, null, 2));

	const allPassed = results.every((r) => r.success && r.valid);
	console.log(`\nOverall: ${allPassed ? "ALL PASSED" : "SOME FAILED"}`);

	process.exit(allPassed ? 0 : 1);
}

main().catch((error) => {
	console.error("Unhandled error:", error);
	process.exit(1);
});
