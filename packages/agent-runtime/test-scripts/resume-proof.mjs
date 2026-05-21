#!/usr/bin/env node
// Multi-turn resume proof — runs real Claude through createAgentSession +
// session.run() twice and checks the second turn remembers context from
// the first.
//
// Test:
//   Turn 1: "Remember this code word: BANANA-7. Respond with only: noted"
//   Turn 2: "What was the code word? Reply with just the code word."
//   Verify turn 2 response contains "BANANA-7".
//
// Modes:
//   local                          — local sandbox + local claude CLI
//   daytona-warm                   — Daytona, sandbox stays alive between turns
//   daytona-efficient              — Daytona, sandbox destroyed between turns;
//                                    state lives on a per-session volume
//
// Usage:
//   pnpm --filter cyrus-agent-runtime build
//
//   # Local (no remote secrets required if `claude` is on $PATH and the
//   # local user already has a Claude OAuth login):
//   node packages/agent-runtime/test-scripts/resume-proof.mjs local
//
//   # Daytona modes (need secrets):
//   set -a; source ~/.cyrus/secrets/daytona.env; source ~/.cyrus/secrets/claude.env; set +a
//   node packages/agent-runtime/test-scripts/resume-proof.mjs daytona-warm
//   node packages/agent-runtime/test-scripts/resume-proof.mjs daytona-efficient

import { mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession } from "../dist/runtime.js";
import { createComputeSdkSandboxProvider } from "../dist/sandbox/compute-sdk.js";

const mode = process.argv[2] ?? "local";
const CODE_WORD = "BANANA-7";

function fmt(ms) {
	return `${ms.toString().padStart(5, " ")}ms`;
}

function verifyResume(turn2Result) {
	const text = (turn2Result.result ?? "").toUpperCase();
	if (text.includes(CODE_WORD)) {
		console.log(
			`\n  ✓ Resume confirmed: turn-2 response contains "${CODE_WORD}".`,
		);
		console.log(`    Full response: ${JSON.stringify(turn2Result.result)}`);
		return true;
	}
	console.error(
		`\n  ✗ Resume FAILED: turn-2 response did not contain "${CODE_WORD}".`,
	);
	console.error(`    Got: ${JSON.stringify(turn2Result.result)}`);
	return false;
}

const TURN_1 = `Remember this code word for me: ${CODE_WORD}. Respond with exactly one word: noted`;
const TURN_2 = `What was the code word I asked you to remember? Reply with only the code word, nothing else.`;

async function runLocalMode() {
	console.log(
		"\n=== Multi-turn resume — LOCAL sandbox, local claude CLI ===\n",
	);
	const claudeToken =
		process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
	if (!claudeToken) {
		throw new Error(
			"CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_AUTH_TOKEN) must be set in the environment. " +
				"The local claude CLI uses this for headless `-p` mode.",
		);
	}
	const root = await mkdir(join(tmpdir(), `resume-proof-local-${Date.now()}`), {
		recursive: true,
	}).then((d) => d ?? join(tmpdir(), `resume-proof-local-${Date.now()}`));
	const agentSessionsRoot = join(tmpdir(), `resume-proof-state-${Date.now()}`);
	await mkdir(root, { recursive: true });
	await mkdir(agentSessionsRoot, { recursive: true });

	try {
		const session = await createAgentSession({
			sessionId: `resume-local-${Date.now()}`,
			harness: { kind: "claude" },
			sandbox: { provider: "local", workingDirectory: root },
			agentSessionsRoot,
			secrets: {
				CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
				ANTHROPIC_AUTH_TOKEN: claudeToken,
			},
		});

		console.log("turn 1: send code word…");
		const t0 = Date.now();
		const r1 = await session.run(TURN_1);
		console.log(
			`  turn 1 complete: success=${r1.success} duration=${fmt(Date.now() - t0)}`,
		);
		console.log(`  response: ${JSON.stringify(r1.result)}`);
		if (!r1.success) {
			console.error(`  turn 1 error: ${r1.error?.message}`);
			throw new Error("turn 1 failed");
		}

		console.log("\nturn 2: ask for the code word…");
		const t1 = Date.now();
		const r2 = await session.run(TURN_2);
		console.log(
			`  turn 2 complete: success=${r2.success} duration=${fmt(Date.now() - t1)}`,
		);

		const passed = verifyResume(r2);
		await session.destroy();
		if (!passed) process.exit(1);
	} finally {
		await rm(root, { recursive: true, force: true }).catch(() => {});
		await rm(agentSessionsRoot, { recursive: true, force: true }).catch(
			() => {},
		);
	}
}

async function runDaytonaWarmMode() {
	console.log(
		"\n=== Multi-turn resume — DAYTONA, sandbox WARM between turns ===\n",
	);
	if (!process.env.DAYTONA_API_KEY) {
		throw new Error("DAYTONA_API_KEY is not set.");
	}
	const claudeToken =
		process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
	if (!claudeToken) {
		throw new Error("CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN not set.");
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

	const sessionId = `resume-daytona-warm-${Date.now()}`;
	const session = await createAgentSession(
		{
			sessionId,
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
			sandbox: {
				provider: "daytona",
				name: `cyrus-resume-warm-${Date.now()}`,
				workingDirectory: "/home/daytona",
				timeoutMs: 300_000,
				metadata: { purpose: "resume-proof-warm" },
			},
		},
		{ sandboxProviders: { daytona: sandboxProvider } },
	);

	try {
		console.log("turn 1: send code word (cold start with install)…");
		const t0 = Date.now();
		const r1 = await session.run(TURN_1);
		console.log(
			`  turn 1: success=${r1.success} duration=${fmt(Date.now() - t0)} response=${JSON.stringify(r1.result)}`,
		);
		console.log(
			"  turn 1 event kinds:",
			r1.events.map((e) => e.kind),
		);
		// Dump the LAST event of each kind to see its shape — usually the
		// `result` envelope is the one extractResult cares about.
		const lastResult = [...r1.events]
			.reverse()
			.find((e) => e.kind === "result");
		if (lastResult) {
			console.log(
				"  turn 1 last result.raw =",
				JSON.stringify(lastResult.raw).slice(0, 400),
			);
		}
		if (!r1.success) {
			console.error(`  turn 1 error: ${r1.error?.message}`);
			throw new Error("turn 1 failed");
		}

		console.log("\nturn 2: ask for code word (warm sandbox, --continue)…");
		const t1 = Date.now();
		const r2 = await session.run(TURN_2);
		console.log(
			`  turn 2: success=${r2.success} duration=${fmt(Date.now() - t1)}`,
		);
		console.log(`  response: ${JSON.stringify(r2.result)}`);

		const passed = verifyResume(r2);
		await session.destroy();
		if (!passed) process.exit(1);
	} catch (err) {
		await session.destroy().catch(() => {});
		throw err;
	}
}

async function runDaytonaEfficientMode() {
	console.log(
		"\n=== Multi-turn resume — DAYTONA, sandbox DESTROYED between turns (efficiencies) ===\n",
	);
	if (!process.env.DAYTONA_API_KEY) {
		throw new Error("DAYTONA_API_KEY is not set.");
	}
	const claudeToken =
		process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
	if (!claudeToken) {
		throw new Error("CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN not set.");
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

	// destroyWhileInactive mode pauses the sandbox (Daytona stop()) after
	// each run and resumes (Daytona start()) on the next. State on disk
	// is preserved by Daytona during stop, so `/home/daytona/.claude/`
	// and the installed `claude` binary both survive.
	const sessionId = `resume-daytona-eff-${Date.now()}`;
	const session = await createAgentSession(
		{
			sessionId,
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
			sandbox: {
				provider: "daytona",
				name: `cyrus-resume-eff-${Date.now()}`,
				workingDirectory: "/home/daytona",
				timeoutMs: 300_000,
				metadata: { purpose: "resume-proof-efficient" },
				destroyWhileInactive: true,
			},
		},
		{ sandboxProviders: { daytona: sandboxProvider } },
	);

	try {
		console.log("turn 1: send code word (cold sandbox + install)…");
		const t0 = Date.now();
		const r1 = await session.run(TURN_1);
		console.log(
			`  turn 1: success=${r1.success} duration=${fmt(Date.now() - t0)} response=${JSON.stringify(r1.result)}`,
		);
		if (!r1.success) {
			console.error(`  turn 1 error: ${r1.error?.message}`);
			throw new Error("turn 1 failed");
		}

		// In efficiencies mode the runtime tears down the sandbox after
		// run() returns. We pause briefly so any in-flight destroy completes
		// and so the operator can verify the sandbox is gone if they want.
		console.log("\n  (sandbox should be destroyed now — pausing 3s)");
		await new Promise((r) => setTimeout(r, 3000));

		console.log(
			"\nturn 2: ask for code word (cold sandbox, mount volume, --continue)…",
		);
		const t1 = Date.now();
		const r2 = await session.run(TURN_2);
		console.log(
			`  turn 2: success=${r2.success} duration=${fmt(Date.now() - t1)}`,
		);
		console.log(`  response: ${JSON.stringify(r2.result)}`);

		const passed = verifyResume(r2);
		await session.destroy();
		if (!passed) process.exit(1);
	} catch (err) {
		await session.destroy().catch(() => {});
		throw err;
	}
}

(async () => {
	try {
		if (mode === "local") await runLocalMode();
		else if (mode === "daytona-warm") await runDaytonaWarmMode();
		else if (mode === "daytona-efficient") await runDaytonaEfficientMode();
		else {
			console.error(
				`unknown mode: ${mode} (expected 'local', 'daytona-warm', or 'daytona-efficient')`,
			);
			process.exit(1);
		}
	} catch (err) {
		console.error("\nProof FAILED:", err);
		process.exit(1);
	}
})();
