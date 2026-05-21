#!/usr/bin/env node
/**
 * @cyrus-ai/cursor-runner — Cursor SDK runner.
 *
 * A thin process boundary around `@cursor/sdk`'s `Agent.create()` +
 * `run.stream()`. Reads a prompt and options from argv, emits each
 * `SDKMessage` the SDK produces as a JSONL line on stdout, exits 0
 * when the run completes (1 on stream error, 2 on misuse).
 *
 * The point: spawning this CLI from another process is type-safe by
 * construction — every line on stdout IS an `SDKMessage` from the
 * Cursor SDK, so the spawner can import the same `@cursor/sdk` types
 * and narrow `JSON.parse(line)` to `SDKMessage` with no drift risk.
 * Compare to invoking `cursor-agent --output-format stream-json`,
 * whose schema is different from the SDK's and is not version-pinned
 * to anything you can import.
 *
 * **Usage** (after `npm install -g @cyrus-ai/cursor-runner`):
 *
 *   cursor-runner \
 *     --prompt <text>          # required
 *     [--model <id>]           # e.g. composer-2 (`Cursor.models.list()` for valid IDs)
 *     [--cwd <dir>]            # working directory for the local agent
 *     [--system-prompt <text>] # prepended to --prompt
 *     [--agent-id <id>]        # resume an existing agent (cross-turn)
 *     [--agent-id-file <path>] # writes the agentId here after Agent.create()
 *
 * **Auth:** reads `CURSOR_API_KEY` from the environment. Exits 2 if missing.
 *
 * **Stdout:** one JSON `SDKMessage` per line, nothing else.
 * **Stderr:** human-readable error text only when something goes wrong.
 */

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { Agent } from "@cursor/sdk";

interface Argv {
	prompt: string;
	model?: string;
	cwd?: string;
	systemPrompt?: string;
	agentId?: string;
	agentIdFile?: string;
}

function parseArgv(): Argv {
	const { values } = parseArgs({
		options: {
			prompt: { type: "string" },
			model: { type: "string" },
			cwd: { type: "string" },
			"system-prompt": { type: "string" },
			"agent-id": { type: "string" },
			"agent-id-file": { type: "string" },
		},
		strict: true,
		allowPositionals: false,
	});

	if (!values.prompt) {
		process.stderr.write("cursor-runner: --prompt is required\n");
		process.exit(2);
	}

	return {
		prompt: values.prompt,
		model: values.model,
		cwd: values.cwd,
		systemPrompt: values["system-prompt"],
		agentId: values["agent-id"],
		agentIdFile: values["agent-id-file"],
	};
}

async function main(): Promise<void> {
	const argv = parseArgv();

	const apiKey = process.env.CURSOR_API_KEY?.trim();
	if (!apiKey) {
		process.stderr.write(
			"cursor-runner: CURSOR_API_KEY is not set in the environment\n",
		);
		process.exit(2);
	}

	const agent = argv.agentId
		? await Agent.resume(argv.agentId, { apiKey })
		: await Agent.create({
				apiKey,
				model: argv.model ? { id: argv.model } : undefined,
				local: { cwd: argv.cwd ?? process.cwd() },
			});

	// Persist the agentId so the spawner can pass it back as
	// `--agent-id` on the next turn (mirrors Claude's --continue / codex's
	// thread-id resume). Best-effort: a write failure logs to stderr but
	// doesn't kill the run.
	if (argv.agentIdFile) {
		await writeFile(argv.agentIdFile, agent.agentId, "utf8").catch(
			(err: unknown) => {
				const msg = err instanceof Error ? err.message : String(err);
				process.stderr.write(
					`cursor-runner: failed to persist agent-id-file: ${msg}\n`,
				);
			},
		);
	}

	const promptText = argv.systemPrompt
		? `${argv.systemPrompt}\n\n${argv.prompt}`
		: argv.prompt;

	try {
		const run = await agent.send(promptText);
		try {
			for await (const message of run.stream()) {
				// One SDKMessage per line. JSON.stringify is safe — the SDK
				// union is plain serializable data, no live references.
				process.stdout.write(`${JSON.stringify(message)}\n`);
			}
			await run.wait();
		} catch (err: unknown) {
			const msg = err instanceof Error ? err.message : String(err);
			process.stderr.write(`cursor-runner: stream error: ${msg}\n`);
			process.exitCode = 1;
		}
	} finally {
		agent.close();
	}
}

main().catch((err: unknown) => {
	const msg = err instanceof Error ? err.message : String(err);
	process.stderr.write(`cursor-runner: fatal: ${msg}\n`);
	process.exit(1);
});
