/**
 * Basic usage example for miko-simple-agent-runner
 *
 * This example demonstrates how to use SimpleClaudeRunner to get
 * yes/no answers from an agent.
 */

import { InvalidResponseError, SimpleClaudeRunner } from "../src/index.js";

// Define valid responses as a const array for type safety
const VALID_RESPONSES = ["yes", "no"] as const;
type YesNoResponse = (typeof VALID_RESPONSES)[number]; // "yes" | "no"

async function main() {
	// Create runner
	const runner = new SimpleClaudeRunner<YesNoResponse>({
		validResponses: VALID_RESPONSES,
		mikoHome: process.env.MIKO_HOME || "/tmp/miko",
		model: "sonnet",
		maxTurns: 3,
		timeoutMs: 30000, // 30 seconds
		onProgress: (event) => {
			console.log(`[Progress] ${event.type}`);
		},
	});

	try {
		// Execute query
		const result = await runner.query(
			"Is TypeScript better than JavaScript for large projects?",
		);

		console.log("Response:", result.response); // "yes" or "no"
		console.log("Duration:", result.durationMs, "ms");
		console.log("Cost:", result.costUSD || "N/A");
		console.log("Session ID:", result.sessionId || "N/A");

		// Type-safe switch statement
		switch (result.response) {
			case "yes":
				console.log("✅ Agent agrees!");
				break;
			case "no":
				console.log("❌ Agent disagrees!");
				break;
		}
	} catch (error) {
		if (error instanceof InvalidResponseError) {
			console.error("Agent returned invalid response:", error.receivedResponse);
			console.error("Valid responses:", error.validResponses);
		} else {
			console.error("Error:", error);
		}
	}
}

main().catch(console.error);
