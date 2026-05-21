#!/usr/bin/env node
// End-to-end proof for AgentChatSessionHandler on real Daytona+Claude.
//
// Simulates two Slack mentions on the same thread:
//   Mention 1: "Remember code word BANANA-7. Reply: noted"
//   Mention 2: "What was the code word?"
//
// Validates:
//   - First mention spawns Daytona sandbox + installs Claude + answers
//   - Sandbox is paused (Daytona stop) after the first answer is posted
//   - Second mention resumes the sandbox and Claude --continue knows the
//     code word from the first turn
//   - Posted replies include "BANANA-7" on the second turn
//
// Usage:
//   set -a; source ~/.cyrus/secrets/daytona.env; source ~/.cyrus/secrets/claude.env; set +a
//   pnpm --filter cyrus-agent-runtime build
//   pnpm --filter cyrus-edge-worker build
//   node packages/edge-worker/test-scripts/slack-handler-proof.mjs

import { AgentChatSessionHandler } from "../dist/index.js";

const CODE_WORD = "BANANA-7";

function fmt(ms) {
	return `${ms.toString().padStart(5, " ")}ms`;
}

// Minimal stub adapter — only the bits handler.handleEvent reads.
const postedReplies = [];
const adapter = {
	platformName: "slack",
	extractTaskInstructions(event) {
		return event.taskInstructions;
	},
	getThreadKey(event) {
		return event.threadKey;
	},
	getEventId(event) {
		return event.eventId;
	},
	buildSystemPrompt(_event) {
		return "You are a concise assistant. Reply in as few words as possible.";
	},
	async fetchThreadContext(_event) {
		return "";
	},
	async postReply(event, finalText) {
		console.log(
			`  [postReply for event=${event.eventId}] text=${JSON.stringify(finalText)}`,
		);
		postedReplies.push({ eventId: event.eventId, text: finalText });
	},
	async acknowledgeReceipt(_event) {
		/* no-op */
	},
	async notifyBusy(_event, threadKey) {
		console.log(`  [notifyBusy] thread=${threadKey}`);
	},
};

if (!process.env.DAYTONA_API_KEY?.trim()) {
	console.error("DAYTONA_API_KEY missing");
	process.exit(1);
}
if (
	!(
		process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ||
		process.env.ANTHROPIC_AUTH_TOKEN?.trim()
	)
) {
	console.error("CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN missing");
	process.exit(1);
}

const handler = new AgentChatSessionHandler(adapter, {
	onWebhookStart() {},
	onWebhookEnd() {},
	onError(err) {
		console.error("  [onError]", err.message);
	},
	// Don't auto-evict during a 60s test run.
	idleTtlMs: 30 * 60 * 1000,
});

const threadKey = `C-TEST:${Date.now()}`;

const event1 = {
	eventId: `evt-1-${Date.now()}`,
	threadKey,
	taskInstructions: `Remember this code word for me: ${CODE_WORD}. Reply with exactly one word: noted`,
};
const event2 = {
	eventId: `evt-2-${Date.now() + 1}`,
	threadKey,
	taskInstructions: `What was the code word? Reply with just the code word.`,
};

console.log(
	"\n=== AgentChatSessionHandler end-to-end (Daytona + Claude, destroyWhileInactive) ===\n",
);

try {
	console.log("Mention 1: send code word (cold start)…");
	const t0 = Date.now();
	await handler.handleEvent(event1);
	console.log(`  Mention 1 handled in ${fmt(Date.now() - t0)}`);

	console.log("\n  Sandbox should be paused now between mentions.");

	console.log("\nMention 2: ask for code word (sandbox resume + --continue)…");
	const t1 = Date.now();
	await handler.handleEvent(event2);
	console.log(`  Mention 2 handled in ${fmt(Date.now() - t1)}`);

	console.log("\n--- Replies posted to Slack ---");
	for (const r of postedReplies) {
		console.log(`  ${r.eventId}: ${JSON.stringify(r.text)}`);
	}

	const reply2 = postedReplies.find((r) => r.eventId === event2.eventId);
	if (!reply2) {
		console.error("\n  ✗ No reply was posted for mention 2.");
		process.exit(1);
	}
	if (reply2.text.toUpperCase().includes(CODE_WORD)) {
		console.log(
			`\n  ✓ End-to-end resume confirmed: mention-2 reply contains "${CODE_WORD}".`,
		);
	} else {
		console.error(
			`\n  ✗ Resume FAILED: mention-2 reply did not contain "${CODE_WORD}".`,
		);
		process.exit(1);
	}
} finally {
	console.log("\nShutting down handler (destroys all warm sessions)…");
	await handler.shutdown();
	console.log("  done.");
}
