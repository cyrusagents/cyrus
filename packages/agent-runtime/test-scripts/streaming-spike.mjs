#!/usr/bin/env node

// Streaming spike for the agent-runtime sandbox abstraction.
//
// Exercises RunnerSandbox.streamCommand() on two providers:
//   1. Local — Node child_process.spawn streams natively.
//   2. Daytona (via ComputeSDK) — uses async sessions + getSessionCommandLogs
//      callbacks, reached through ProviderSandbox.getInstance().
//
// The script prints arrival timestamps for each chunk so you can SEE that
// chunks land before the process exits. For Daytona it also exercises a real
// Claude stream-json run end-to-end.
//
// Usage:
//   # Local only (no secrets needed):
//   node packages/agent-runtime/test-scripts/streaming-spike.mjs local
//
//   # Daytona + Claude (requires DAYTONA_API_KEY + CLAUDE_CODE_OAUTH_TOKEN):
//   set -a; source ~/.cyrus/secrets/daytona.env; source ~/.cyrus/secrets/claude.env; set +a
//   pnpm --filter cyrus-agent-runtime build
//   node packages/agent-runtime/test-scripts/streaming-spike.mjs daytona

import { createAgentSession } from "../dist/runtime.js";
import { createComputeSdkSandboxProvider } from "../dist/sandbox/compute-sdk.js";
import { createLocalSandboxProvider } from "../dist/sandbox/local.js";

const mode = process.argv[2] ?? "local";

function fmt(ms) {
	return `${ms.toString().padStart(5, " ")}ms`;
}

async function runLocalSpike() {
	console.log("\n=== Local streamCommand spike ===\n");
	const provider = createLocalSandboxProvider({
		workingDirectory: process.cwd(),
	});
	const sandbox = await provider.create({ provider: "local" });

	console.log("capabilities:", sandbox.capabilities);
	if (!sandbox.streamCommand) {
		throw new Error("Local sandbox does not implement streamCommand.");
	}

	// Emit 5 lines, each 400ms apart. If streaming works, we'll see chunks
	// land at ~400/800/1200/1600/2000ms; if it doesn't, we'll see all of
	// them at the end.
	const command =
		'node -e "' +
		"let i = 0;" +
		"const t = setInterval(() => {" +
		"  i++; console.log('line ' + i + ' at ' + Date.now());" +
		"  if (i >= 5) { clearInterval(t); console.error('done'); }" +
		'}, 400);"';

	const startedAt = Date.now();
	const arrivals = [];
	const result = await sandbox.streamCommand(command, {
		onStdout: (chunk) => {
			const t = Date.now() - startedAt;
			arrivals.push(t);
			process.stdout.write(`  [stdout @ ${fmt(t)}] ${chunk}`);
		},
		onStderr: (chunk) => {
			const t = Date.now() - startedAt;
			process.stdout.write(`  [stderr @ ${fmt(t)}] ${chunk}`);
		},
	});

	console.log("\nresult:", {
		exitCode: result.exitCode,
		durationMs: result.durationMs,
		stdoutLen: result.stdout.length,
		stderrLen: result.stderr.length,
	});
	const firstArrival = arrivals[0] ?? Infinity;
	const lastArrival = arrivals.at(-1) ?? 0;
	console.log(
		"streaming evidence: first chunk @",
		fmt(firstArrival),
		"vs final duration",
		fmt(result.durationMs),
		"; spread across",
		fmt(lastArrival - firstArrival),
	);
	if (firstArrival >= result.durationMs - 50) {
		console.error("\n  WARNING: first chunk arrived at the very end —");
		console.error("  this looks buffered, not streamed.\n");
	} else {
		console.log("\n  ✓ Streaming confirmed: chunks arrived live.\n");
	}
}

async function runDaytonaSpike() {
	console.log("\n=== Daytona streamCommand spike (real remote) ===\n");
	if (!process.env.DAYTONA_API_KEY) {
		throw new Error("DAYTONA_API_KEY is not set in the environment.");
	}
	const claudeToken =
		process.env.CLAUDE_CODE_OAUTH_TOKEN ?? process.env.ANTHROPIC_AUTH_TOKEN;
	if (!claudeToken) {
		throw new Error(
			"CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_AUTH_TOKEN) is not set; needed for the Claude harness inside Daytona.",
		);
	}

	const { daytona } = await import("@computesdk/daytona");
	const { compute } = await import("computesdk");
	compute.setConfig({
		provider: daytona({
			apiKey: process.env.DAYTONA_API_KEY,
			timeout: 300_000,
		}),
	});

	console.log("creating remote sandbox…");
	const wrapped = await compute.sandbox.create({
		directory: "/home/daytona",
		timeout: 300_000,
		metadata: { purpose: "agent-runtime-streaming-spike" },
	});

	// Build a ComputeSdkRunnerSandbox by hand using the same provider wrapper
	// our runtime would use, so streamCommand can probe getInstance().
	const provider = createComputeSdkSandboxProvider({
		compute: {
			sandbox: {
				async create() {
					return wrapped;
				},
				async getById(id) {
					return wrapped.sandboxId === id ? wrapped : null;
				},
			},
		},
	});
	const sandbox = await provider.create({
		provider: "daytona",
		id: wrapped.sandboxId,
		workingDirectory: "/home/daytona",
		timeoutMs: 300_000,
	});

	console.log("capabilities:", sandbox.capabilities);
	if (!sandbox.streamCommand) {
		throw new Error("Daytona sandbox did not expose streamCommand.");
	}
	if (!sandbox.capabilities.streamingProcess) {
		throw new Error(
			"Daytona sandbox reported streamingProcess: false — getInstance() probe failed.",
		);
	}

	try {
		// First: a plain shell streaming probe. Confirms inter-chunk timing
		// without involving any agent CLI.
		console.log("\n--- probe 1: shell loop (5 lines, ~400ms apart) ---\n");
		const shellStartedAt = Date.now();
		const shellArrivals = [];
		const shellResult = await sandbox.streamCommand(
			'for i in 1 2 3 4 5; do echo "shell line $i @ $(date +%s%3N)"; sleep 0.4; done',
			{
				onStdout: (chunk) => {
					const t = Date.now() - shellStartedAt;
					shellArrivals.push(t);
					process.stdout.write(`  [stdout @ ${fmt(t)}] ${chunk}`);
				},
				onStderr: (chunk) => {
					const t = Date.now() - shellStartedAt;
					process.stdout.write(`  [stderr @ ${fmt(t)}] ${chunk}`);
				},
			},
		);
		console.log(
			"\nshell probe: exit",
			shellResult.exitCode,
			"duration",
			fmt(shellResult.durationMs),
			"first chunk @",
			fmt(shellArrivals[0] ?? -1),
			"spread",
			fmt((shellArrivals.at(-1) ?? 0) - (shellArrivals[0] ?? 0)),
		);

		// Second: install Claude Code and stream a real stream-json session.
		console.log("\n--- probe 2: install Claude Code remotely ---\n");
		const setupResult = await sandbox.runCommand(
			"npm config set prefix /home/daytona/.npm-global && " +
				"npm install -g @anthropic-ai/claude-code@2.1.145 >/dev/null 2>&1 && " +
				"/home/daytona/.npm-global/bin/claude --version",
			{ timeout: 240_000 },
		);
		console.log(
			"setup exit",
			setupResult.exitCode,
			"->",
			setupResult.stdout.trim(),
		);
		if (setupResult.exitCode !== 0) {
			throw new Error(
				`Claude install failed inside Daytona: ${setupResult.stderr}`,
			);
		}

		console.log("\n--- probe 3: Claude stream-json over streamCommand ---\n");
		const claudeStartedAt = Date.now();
		const eventArrivals = [];
		const lineBuffer = { stdout: "" };
		const claudeResult = await sandbox.streamCommand(
			"/home/daytona/.npm-global/bin/claude " +
				"-p 'Reply with exactly: streaming spike ok' " +
				"--output-format stream-json --verbose",
			{
				env: {
					PATH: "/home/daytona/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
					CLAUDE_CODE_OAUTH_TOKEN: claudeToken,
					ANTHROPIC_AUTH_TOKEN: claudeToken,
				},
				onStdout: (chunk) => {
					lineBuffer.stdout += chunk;
					let idx = lineBuffer.stdout.indexOf("\n");
					while (idx !== -1) {
						const line = lineBuffer.stdout.slice(0, idx);
						lineBuffer.stdout = lineBuffer.stdout.slice(idx + 1);
						if (line.trim().length > 0) {
							const t = Date.now() - claudeStartedAt;
							let kind = "unknown";
							try {
								kind = JSON.parse(line).type ?? "unknown";
							} catch {
								kind = `non-json(${line.slice(0, 40)}…)`;
							}
							eventArrivals.push({ kind, elapsedMs: t });
							console.log(`  [claude event @ ${fmt(t)}] ${kind}`);
						}
						idx = lineBuffer.stdout.indexOf("\n");
					}
				},
				onStderr: (chunk) => {
					const t = Date.now() - claudeStartedAt;
					process.stderr.write(`  [stderr @ ${fmt(t)}] ${chunk}`);
				},
			},
		);

		console.log(
			"\nclaude probe: exit",
			claudeResult.exitCode,
			"duration",
			fmt(claudeResult.durationMs),
			"events observed:",
			eventArrivals.length,
		);
		const systemEvent = eventArrivals.find((e) => e.kind === "system");
		const resultEvent = eventArrivals.find((e) => e.kind === "result");
		if (systemEvent && resultEvent) {
			const gap = resultEvent.elapsedMs - systemEvent.elapsedMs;
			console.log(
				"streaming evidence: system event @",
				fmt(systemEvent.elapsedMs),
				"→ result event @",
				fmt(resultEvent.elapsedMs),
				"(gap",
				fmt(gap),
				")",
			);
			if (gap < 200) {
				console.error(
					"\n  WARNING: system and result events arrived within 200ms —",
				);
				console.error("  this could still be buffered, double check.\n");
			} else {
				console.log(
					"\n  ✓ Live Daytona streaming confirmed: system event landed",
					fmt(gap),
					"before result event.\n",
				);
			}
		} else {
			console.error(
				"\n  WARNING: did not observe both system and result events;",
				"can't compare timing.\n",
			);
		}
	} finally {
		console.log("destroying sandbox…");
		await sandbox.destroy();
	}
}

async function runRuntimeLocalSpike() {
	console.log("\n=== createAgentSession local streaming spike ===\n");
	// Proves the session prefers streamCommand and emits TranscriptEvents
	// live, line-by-line, as the harness CLI emits them.
	const startedAt = Date.now();
	const arrivals = [];
	const session = await createAgentSession(
		{
			sessionId: "runtime-stream-spike",
			harness: { kind: "codex", model: "gpt-5.2" },
			sandbox: { provider: "local", workingDirectory: process.cwd() },
		},
		{
			callbacks: {
				onTranscriptEvent(event) {
					const t = Date.now() - startedAt;
					arrivals.push({ kind: event.kind, elapsedMs: t });
					console.log(`  [event @ ${fmt(t)}] ${event.kind}`);
				},
			},
		},
	);

	const result = await session.run(
		"Reply exactly: runtime stream spike ok. Do not call any tools.",
	);
	console.log("\nsession result:", {
		success: result.success,
		exitCode: result.exitCode,
		extracted: result.result,
		events: result.events.length,
	});

	// Look for two distinct event arrival times to prove streaming.
	const firstNonSetup = arrivals.find((a) => !a.kind.startsWith("setup."));
	const last = arrivals.at(-1);
	if (firstNonSetup && last && last !== firstNonSetup) {
		const gap = last.elapsedMs - firstNonSetup.elapsedMs;
		console.log(
			`streaming evidence: first non-setup event @ ${fmt(firstNonSetup.elapsedMs)} → last event @ ${fmt(last.elapsedMs)} (gap ${fmt(gap)})`,
		);
		if (gap < 50) {
			console.warn(
				"\n  WARNING: harness events landed within 50ms of each other —",
				"could be buffered. Inspect transcript carefully.\n",
			);
		} else {
			console.log("\n  ✓ Session-level streaming confirmed.\n");
		}
	} else {
		console.warn(
			"\n  WARNING: only one (or zero) harness events observed; not enough timing data.\n",
		);
	}
}

(async () => {
	try {
		if (mode === "local") {
			await runLocalSpike();
		} else if (mode === "runtime-local") {
			await runRuntimeLocalSpike();
		} else if (mode === "daytona") {
			await runDaytonaSpike();
		} else if (mode === "all") {
			await runLocalSpike();
			await runRuntimeLocalSpike();
			await runDaytonaSpike();
		} else {
			console.error(
				`unknown mode: ${mode} (expected 'local', 'runtime-local', 'daytona', or 'all')`,
			);
			process.exit(1);
		}
	} catch (error) {
		console.error("\nSpike failed:", error);
		process.exit(1);
	}
})();
