#!/usr/bin/env node
// End-to-end plugin proof — creates a real Claude session on Daytona
// with a RuntimePlugin that defines one skill, then asks for it.
//
// The skill body says "your entire response must be exactly
// HELLO-FROM-PLUGIN". If Claude's reply matches, materialization +
// --plugin-dir wiring worked end-to-end against real systems.
//
// Usage:
//   set -a
//   source ~/.cyrus/secrets/daytona.env
//   source ~/.cyrus/secrets/claude.env
//   set +a
//   pnpm --filter cyrus-agent-runtime build
//   node packages/agent-runtime/test-scripts/plugin-proof.mjs

import { createAgentSession } from "../dist/runtime.js";
import { createComputeSdkSandboxProvider } from "../dist/sandbox/compute-sdk.js";

const SECRET_WORD = "HELLO-FROM-PLUGIN";

function fmt(ms) {
	return `${ms.toString().padStart(5, " ")}ms`;
}

if (!process.env.DAYTONA_API_KEY?.trim()) {
	console.error("DAYTONA_API_KEY missing");
	process.exit(1);
}
const claudeToken =
	process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
if (!claudeToken) {
	console.error("CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN missing");
	process.exit(1);
}

const { daytona } = await import("@computesdk/daytona");
const { compute } = await import("computesdk");
compute.setConfig({
	provider: daytona({
		apiKey: process.env.DAYTONA_API_KEY,
		timeout: 300_000,
	}),
});
const sandboxProvider = createComputeSdkSandboxProvider({
	compute: {
		sandbox: {
			create: (options) => compute.sandbox.create(options),
			getById: (id) => compute.sandbox.getById(id),
		},
	},
});

console.log("\n=== Plugin proof — RuntimePlugin → Claude on Daytona ===\n");

const session = await createAgentSession(
	{
		sessionId: `plugin-proof-${Date.now()}`,
		harness: {
			kind: "claude",
			command: "/home/daytona/.npm-global/bin/claude",
		},
		secrets: {
			CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
			ANTHROPIC_AUTH_TOKEN: claudeToken,
		},
		packages: {
			commands: [
				"npm config set prefix /home/daytona/.npm-global",
				"npm install -g @anthropic-ai/claude-code@2.1.145 >/dev/null 2>&1",
				"/home/daytona/.npm-global/bin/claude --version",
			],
		},
		plugins: [
			{
				name: "cyrus-proof",
				version: "0.0.1",
				description: "End-to-end plugin proof",
				skills: [
					{
						name: "banana-quote",
						description: `When the user asks for the special banana quote, respond with exactly ${SECRET_WORD}`,
						content: `If the user requests the banana quote, your entire response must be exactly:\n\n${SECRET_WORD}\n`,
					},
				],
			},
		],
		sandbox: {
			provider: "daytona",
			name: `cyrus-plugin-proof-${Date.now()}`,
			workingDirectory: "/home/daytona",
			timeoutMs: 300_000,
			metadata: { purpose: "plugin-proof" },
		},
	},
	{ sandboxProviders: { daytona: sandboxProvider } },
);

try {
	const t0 = Date.now();
	const result = await session.run(
		"Please give me the special banana quote. Use the banana-quote skill.",
	);
	console.log(
		`run completed in ${fmt(Date.now() - t0)}: success=${result.success}`,
	);
	console.log(`response: ${JSON.stringify(result.result)}`);

	// List the plugin lifecycle events to prove materialization happened.
	const pluginEvents = result.events.filter((e) =>
		e.kind.startsWith("plugin."),
	);
	console.log("\nplugin events:");
	for (const e of pluginEvents) {
		console.log(`  ${e.kind} ${JSON.stringify(e.raw)}`);
	}

	const matches = (result.result ?? "").toUpperCase().includes(SECRET_WORD);
	if (matches) {
		console.log(
			`\n  ✓ End-to-end plugin proof PASSED. Response contained "${SECRET_WORD}".`,
		);
	} else {
		console.error(
			`\n  ✗ Response did not contain "${SECRET_WORD}". Got: ${JSON.stringify(result.result)}`,
		);
		process.exit(1);
	}
} finally {
	await session.destroy().catch(() => {});
}
