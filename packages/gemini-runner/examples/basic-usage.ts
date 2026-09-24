/**
 * Basic usage example for GeminiRunner
 *
 * This example demonstrates:
 * - Creating a GeminiRunner instance
 * - Configuring basic options
 * - Subscribing to events
 * - Starting a session with a prompt
 * - Handling streaming events
 * - Retrieving messages
 */

import * as os from "node:os";
import * as path from "node:path";
import { GeminiRunner } from "../src/GeminiRunner";
import type { SDKMessage } from "../src/types";

async function main() {
	console.log("=== GeminiRunner Basic Usage Example ===\n");

	// Configure the runner
	const runner = new GeminiRunner({
		// Required: Home directory for logs
		mikoHome: path.join(os.homedir(), ".miko"),

		// Required: Working directory for Gemini to operate in
		workingDirectory: process.cwd(),

		// Model to use (Gemini 2.5 Flash is fast and cost-effective)
		model: "gemini-2.5-flash",

		// Auto-approve tool usage (enables --yolo flag)
		autoApprove: true,

		// Optional: Approval mode for more control
		// approvalMode: 'auto_edit',

		// Optional: Enable debug logging
		debug: false,
	});

	console.log("✓ GeminiRunner configured\n");

	// Subscribe to events

	// Event: New message received
	runner.on("message", (message: SDKMessage) => {
		console.log("\n📨 New message received:");
		console.log(`   Type: ${message.type}`);
		console.log(`   Role: ${message.message?.role || "N/A"}`);

		if (message.message?.content) {
			const content = Array.isArray(message.message.content)
				? message.message.content
				: [message.message.content];

			content.forEach((block, _i) => {
				if (typeof block === "string") {
					console.log(`   Content: ${block.substring(0, 100)}...`);
				} else if (block.type === "text") {
					console.log(`   Text: ${block.text.substring(0, 100)}...`);
				} else if (block.type === "tool_use") {
					console.log(`   Tool Use: ${block.name}`);
				} else if (block.type === "tool_result") {
					console.log(`   Tool Result: ${block.tool_use_id}`);
				}
			});
		}
	});

	// Event: Error occurred
	runner.on("error", (error: Error) => {
		console.error("\n❌ Error:", error.message);
	});

	// Event: Session completed
	runner.on("complete", (messages: SDKMessage[]) => {
		console.log("\n✅ Session completed!");
		console.log(`   Total messages: ${messages.length}`);
	});

	// Event: Raw stream events from Gemini CLI (for debugging)
	runner.on("streamEvent", (event) => {
		console.log(`   [Gemini Event] ${event.type}`);
	});

	console.log("✓ Event listeners registered\n");

	// Start a session with a prompt
	const prompt = `Analyze this basic TypeScript example and provide feedback:

function greet(name: string): string {
  return "Hello, " + name + "!";
}

console.log(greet("World"));

Keep your response brief (2-3 sentences).`;

	console.log("📤 Starting session with prompt...\n");
	console.log(`Prompt: ${prompt}\n`);

	try {
		await runner.start(prompt);

		// Session is now running and will emit events
		// Wait for completion (the 'complete' event will fire when done)

		console.log("\n⏳ Waiting for session to complete...\n");

		// In a real application, you would likely wait for the 'complete' event
		// For this example, we'll use a promise that resolves on 'complete'
		await new Promise<void>((resolve, reject) => {
			runner.once("complete", () => resolve());
			runner.once("error", (err) => reject(err));
		});

		// Retrieve all messages
		const messages = runner.getMessages();
		console.log("\n📋 Final Summary:");
		console.log(`   Total messages: ${messages.length}`);
		console.log(`   Session ID: ${messages[0]?.session_id || "N/A"}`);

		// Display the final assistant response
		const lastMessage = messages[messages.length - 1];
		if (lastMessage?.message?.role === "assistant") {
			console.log("\n💬 Final Response:");
			const content = lastMessage.message.content;
			if (Array.isArray(content)) {
				content.forEach((block) => {
					if (typeof block === "string") {
						console.log(block);
					} else if (block.type === "text") {
						console.log(block.text);
					}
				});
			} else if (typeof content === "string") {
				console.log(content);
			}
		}

		console.log("\n✓ Example completed successfully!");
	} catch (error) {
		console.error("\n❌ Session failed:", error);
		throw error;
	} finally {
		// Clean up
		if (runner.isRunning()) {
			await runner.stop();
		}
	}
}

// Example: Streaming prompt usage
async function streamingExample() {
	console.log("\n\n=== GeminiRunner Streaming Example ===\n");

	const runner = new GeminiRunner({
		mikoHome: path.join(os.homedir(), ".miko"),
		workingDirectory: process.cwd(),
		model: "gemini-2.5-flash",
		autoApprove: true,
	});

	runner.on("complete", (messages) => {
		console.log(
			`\n✅ Streaming session completed with ${messages.length} messages`,
		);
	});

	// Start with streaming capability
	console.log("📤 Starting streaming session...\n");
	await runner.startStreaming("I need help with a task.");

	// Add messages incrementally
	console.log("📤 Adding first message...");
	runner.addStreamMessage('First, analyze this code: console.log("hello");');

	// Simulate some delay
	await new Promise((resolve) => setTimeout(resolve, 1000));

	console.log("📤 Adding second message...");
	runner.addStreamMessage("Second, suggest an improvement.");

	// Signal that we\'re done sending messages
	console.log("📤 Completing stream...\n");
	runner.completeStream();

	// Wait for completion
	await new Promise<void>((resolve, reject) => {
		runner.once("complete", () => resolve());
		runner.once("error", (err) => reject(err));
	});

	const messages = runner.getMessages();
	console.log(`\n📋 Total messages: ${messages.length}`);

	if (runner.isRunning()) {
		await runner.stop();
	}
}

// Run the examples
if (require.main === module) {
	main()
		.then(() => streamingExample())
		.catch((error) => {
			console.error("Fatal error:", error);
			process.exit(1);
		});
}

export { main, streamingExample };
