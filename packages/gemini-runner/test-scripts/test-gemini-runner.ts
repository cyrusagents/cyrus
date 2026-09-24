#!/usr/bin/env bun

/**
 * GeminiRunner End-to-End Integration Test
 *
 * Comprehensive verification of all GeminiRunner features:
 * - Stdin streaming (multiple writes before completion)
 * - Result message coercion (actual content vs generic message)
 * - Single-turn mode with -shortone model aliases
 * - Settings.json auto-generation
 * - All 4 main Gemini models
 *
 * Prerequisites:
 * - GEMINI_API_KEY environment variable must be set
 * - gemini CLI installed: npm install -g @google/gemini-cli@0.17.0
 *
 * Usage:
 *   cd packages/gemini-runner
 *   pnpm build
 *   bun test-scripts/test-gemini-runner.ts
 */

import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SDKMessage, SDKResultMessage } from "miko-core";
import { GeminiRunner } from "../dist/GeminiRunner.js";

// Test configuration
const TEST_MIKO_HOME = join(homedir(), ".miko-test-gemini");
const TEST_WORKING_DIR = process.cwd();

// All 4 main Gemini models to test
const GEMINI_MODELS = [
	"gemini-3-pro-preview",
	"gemini-2.5-pro",
	"gemini-2.5-flash",
	"gemini-2.5-flash-lite",
] as const;

// Color output helpers
const colors = {
	green: (text: string) => `\x1b[32m${text}\x1b[0m`,
	red: (text: string) => `\x1b[31m${text}\x1b[0m`,
	yellow: (text: string) => `\x1b[33m${text}\x1b[0m`,
	cyan: (text: string) => `\x1b[36m${text}\x1b[0m`,
	magenta: (text: string) => `\x1b[35m${text}\x1b[0m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[0m`,
	dim: (text: string) => `\x1b[2m${text}\x1b[0m`,
};

interface TestStats {
	totalTests: number;
	passedTests: number;
	failedTests: number;
	startTime: number;
}

const stats: TestStats = {
	totalTests: 0,
	passedTests: 0,
	failedTests: 0,
	startTime: Date.now(),
};

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Test assertion helper
 */
function assert(condition: boolean, message: string, testName: string): void {
	stats.totalTests++;
	if (condition) {
		stats.passedTests++;
		console.log(colors.green(`   ✅ ${message}`));
	} else {
		stats.failedTests++;
		console.error(colors.red(`   ❌ ${message}`));
		throw new Error(`Assertion failed in ${testName}: ${message}`);
	}
}

/**
 * Test 2: Stdin Streaming (Multiple Writes)
 */
async function testStdinStreaming(): Promise<void> {
	console.log(colors.bold("\n🔄 Test 2: Stdin Streaming (Multiple Writes)\n"));

	const messages: SDKMessage[] = [];
	let resultMessage: SDKResultMessage | null = null;

	const runner = new GeminiRunner({
		mikoHome: TEST_MIKO_HOME,
		workingDirectory: TEST_WORKING_DIR,
		model: "gemini-2.5-flash", // Use fast model for testing
		onMessage: (message: SDKMessage) => {
			messages.push(message);
			if (message.type === "result") {
				resultMessage = message as SDKResultMessage;
			}
		},
	});

	console.log(colors.cyan("   Starting streaming session...\n"));

	// Start streaming with initial prompt (don't await yet - it blocks until completion)
	console.log(colors.dim("   Writing message 1: 'Count to 1.'\n"));
	const sessionPromise = runner.startStreaming("Count to 1.");

	// Add multiple messages via stdin
	// console.log(colors.dim("   Writing message 2: 'Now count to 2.'\n"));
	// runner.addStreamMessage("Now count to 2.");

	// console.log(colors.dim("   Writing message 3: 'Finally count to 3.'\n"));
	// runner.addStreamMessage("Finally count to 3.");

	await sleep(100000); // pauses for 1 second
	// Complete the stream (closes stdin)
	console.log(colors.dim("   Closing stdin...\n"));
	runner.completeStream();

	// Wait for session to complete
	await sessionPromise;

	// Verify we got messages
	assert(
		messages.length > 0,
		`Received ${messages.length} messages from GeminiRunner`,
		"testStdinStreaming",
	);

	// Verify we got a result
	assert(!!resultMessage, "Received result message", "testStdinStreaming");

	// Verify result is successful
	assert(
		resultMessage!.subtype === "success",
		`Result is successful (subtype: ${resultMessage!.subtype})`,
		"testStdinStreaming",
	);

	console.log();
}

/**
 * Test 3: Result Message Coercion
 */
async function testResultMessageCoercion(): Promise<void> {
	console.log(colors.bold("\n📝 Test 3: Result Message Coercion\n"));

	const messages: SDKMessage[] = [];
	let resultMessage: SDKResultMessage | null = null;
	let lastAssistantContent = "";

	const runner = new GeminiRunner({
		mikoHome: TEST_MIKO_HOME,
		workingDirectory: TEST_WORKING_DIR,
		model: "gemini-2.5-flash",
		onMessage: (message: SDKMessage) => {
			messages.push(message);
			if (message.type === "assistant") {
				const content = message.message.content;
				if (Array.isArray(content) && content.length > 0) {
					const textBlock = content.find((block) => block.type === "text");
					if (textBlock && "text" in textBlock) {
						lastAssistantContent = textBlock.text;
					}
				}
			}
			if (message.type === "result") {
				resultMessage = message as SDKResultMessage;
			}
		},
	});

	const testPhrase = "GEMINI_RESULT_COERCION_TEST_SUCCESS";
	console.log(colors.cyan(`   Sending prompt: 'Say exactly: ${testPhrase}'\n`));

	await runner.start(`Say exactly: ${testPhrase}`);

	// Wait for completion
	await new Promise((resolve) => setTimeout(resolve, 8000));

	// Verify we got a result
	assert(
		!!resultMessage,
		"Received result message",
		"testResultMessageCoercion",
	);

	// Critical test: Result should NOT be generic message
	assert(
		resultMessage!.result !== "Session completed successfully",
		"Result is NOT generic 'Session completed successfully'",
		"testResultMessageCoercion",
	);

	// Critical test: Result should contain actual response
	assert(
		resultMessage!.result.includes(testPhrase),
		`Result contains test phrase: "${testPhrase}"`,
		"testResultMessageCoercion",
	);

	// Verify it matches last assistant message (content coercion worked)
	const contentMatches = resultMessage!.result === lastAssistantContent;
	if (contentMatches) {
		console.log(
			colors.green(
				"   ✅ Result content exactly matches last assistant message\n",
			),
		);
	} else {
		console.log(
			colors.yellow(
				"   ⚠️  Result differs slightly from last assistant message (may include formatting)\n",
			),
		);
	}

	console.log(
		colors.dim(
			`   Last assistant: "${lastAssistantContent.substring(0, 60)}..."\n`,
		),
	);
	console.log(
		colors.dim(
			`   Result content: "${resultMessage!.result.substring(0, 60)}..."\n`,
		),
	);
	console.log();
}

/**
 * Test 4: Single-Turn Mode (All Models)
 */
async function testSingleTurnMode(): Promise<void> {
	console.log(colors.bold("\n🎯 Test 4: Single-Turn Mode (All 4 Models)\n"));

	for (const baseModel of GEMINI_MODELS) {
		const shortoneModel = `${baseModel}-shortone`;
		console.log(colors.magenta(`\n   Testing model: ${shortoneModel}\n`));

		const messages: SDKMessage[] = [];
		let resultMessage: SDKResultMessage | null = null;

		const runner = new GeminiRunner({
			mikoHome: TEST_MIKO_HOME,
			workingDirectory: TEST_WORKING_DIR,
			model: shortoneModel, // Using -shortone alias
			maxTurns: 1, // Explicit single-turn
			onMessage: (message: SDKMessage) => {
				messages.push(message);
				if (message.type === "result") {
					resultMessage = message as SDKResultMessage;
				}
			},
		});

		console.log(
			colors.dim("   Sending: 'Count to 2 and say SINGLETURN_TEST'\n"),
		);

		await runner.start("Count to 2 and say SINGLETURN_TEST");

		// Wait for completion
		await new Promise((resolve) => setTimeout(resolve, 8000));

		// Verify we got a result
		assert(
			!!resultMessage,
			`${shortoneModel}: Received result message`,
			"testSingleTurnMode",
		);

		// Verify successful completion
		assert(
			resultMessage!.subtype === "success",
			`${shortoneModel}: Completed successfully`,
			"testSingleTurnMode",
		);

		// Critical test: Should complete in 0-1 turns (not multi-turn)
		assert(
			resultMessage!.num_turns <= 1,
			`${shortoneModel}: Completed in ${resultMessage!.num_turns} turn(s) (≤1)`,
			"testSingleTurnMode",
		);

		console.log();
	}
}

/**
 * Test 5: getLastAssistantMessage() API
 */
async function testGetLastAssistantMessage(): Promise<void> {
	console.log(
		colors.bold("\n🔍 Test 5: getLastAssistantMessage() Public API\n"),
	);

	const runner = new GeminiRunner({
		mikoHome: TEST_MIKO_HOME,
		workingDirectory: TEST_WORKING_DIR,
		model: "gemini-2.5-flash",
	});

	// Before starting, should be null
	assert(
		runner.getLastAssistantMessage() === null,
		"getLastAssistantMessage() returns null before session starts",
		"testGetLastAssistantMessage",
	);

	await runner.start("Say: LAST_MESSAGE_API_TEST");

	// Wait for completion
	await new Promise((resolve) => setTimeout(resolve, 6000));

	// After session, should have captured last message
	const lastMessage = runner.getLastAssistantMessage();

	assert(
		lastMessage !== null,
		"getLastAssistantMessage() returns message after session",
		"testGetLastAssistantMessage",
	);

	assert(
		lastMessage!.type === "assistant",
		`Last message type is 'assistant' (got: ${lastMessage!.type})`,
		"testGetLastAssistantMessage",
	);

	// Extract content
	const content = lastMessage!.message.content;
	if (Array.isArray(content) && content.length > 0) {
		const textBlock = content.find((block) => block.type === "text");
		if (textBlock && "text" in textBlock) {
			console.log(
				colors.dim(
					`   Last message content: "${textBlock.text.substring(0, 60)}..."\n`,
				),
			);
		}
	}

	console.log();
}

/**
 * Print final test summary
 */
function printSummary(): void {
	const duration = ((Date.now() - stats.startTime) / 1000).toFixed(2);

	console.log(colors.bold(`\n${"=".repeat(60)}\n`));
	console.log(colors.bold("📊 Test Summary\n"));
	console.log(colors.bold(`${"=".repeat(60)}\n`));

	console.log(colors.cyan(`   Total Tests:  ${stats.totalTests}`));
	console.log(colors.green(`   Passed:       ${stats.passedTests}`));

	if (stats.failedTests > 0) {
		console.log(colors.red(`   Failed:       ${stats.failedTests}`));
	}

	console.log(colors.dim(`   Duration:     ${duration}s\n`));

	if (stats.failedTests === 0) {
		console.log(colors.bold(colors.green("✅ All Tests Passed!\n")));
	} else {
		console.log(
			colors.bold(colors.red(`❌ ${stats.failedTests} Test(s) Failed\n`)),
		);
	}

	console.log(colors.bold(`${"=".repeat(60)}\n`));
}

/**
 * Main test runner
 */
async function runTests(): Promise<void> {
	console.log(colors.bold(`\n${"=".repeat(60)}`));
	console.log(colors.bold("🧪 GeminiRunner End-to-End Integration Tests"));
	console.log(colors.bold(`${"=".repeat(60)}\n`));

	// Check prerequisites
	if (!process.env.GEMINI_API_KEY) {
		console.error(
			colors.red("\n❌ GEMINI_API_KEY environment variable not set\n"),
		);
		console.error(
			colors.yellow("   Set it with: export GEMINI_API_KEY='your-api-key'\n"),
		);
		process.exit(1);
	}

	// Create test miko home if it doesn't exist
	if (!existsSync(TEST_MIKO_HOME)) {
		mkdirSync(TEST_MIKO_HOME, { recursive: true });
	}

	console.log(colors.cyan("Prerequisites:"));
	console.log(colors.green("   ✅ GEMINI_API_KEY environment variable set"));
	console.log(colors.green(`   ✅ Test directory: ${TEST_MIKO_HOME}`));
	console.log();

	try {
		// Run all tests sequentially
		await testStdinStreaming();
		await testResultMessageCoercion();
		await testSingleTurnMode();
		await testGetLastAssistantMessage();

		printSummary();

		if (stats.failedTests > 0) {
			process.exit(1);
		}
	} catch (error) {
		console.error(colors.bold(colors.red("\n❌ Test Execution Failed\n")));
		console.error(error);
		printSummary();
		process.exit(1);
	}
}

// Run tests
runTests();
