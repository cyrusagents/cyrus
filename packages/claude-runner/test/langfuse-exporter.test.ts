import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportTranscriptToLangfuse,
	findSubagentTranscripts,
	type LangfuseConfig,
	type LangfuseLike,
	resolveLangfuseConfig,
	resolveTraceVersion,
} from "../src/langfuse-exporter";

const PK = "pk-lf-test";
const SK = "sk-lf-test";
const CONFIG: LangfuseConfig = {
	publicKey: PK,
	secretKey: SK,
	baseUrl: "https://lf.example.com",
};

describe("resolveLangfuseConfig", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.LANGFUSE_PUBLIC_KEY;
		delete process.env.LANGFUSE_SECRET_KEY;
		delete process.env.LANGFUSE_HOST;
		delete process.env.LANGFUSE_BASE_URL;
		delete process.env.CYRUS_TELEMETRY_DISABLED;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("returns null when keys are missing", () => {
		expect(resolveLangfuseConfig({})).toBeNull();
		expect(resolveLangfuseConfig({ LANGFUSE_PUBLIC_KEY: PK })).toBeNull();
		expect(resolveLangfuseConfig({ LANGFUSE_SECRET_KEY: SK })).toBeNull();
	});

	it("returns config when both keys are present, defaulting to cloud host", () => {
		const cfg = resolveLangfuseConfig({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
		});
		expect(cfg).toEqual({
			publicKey: PK,
			secretKey: SK,
			baseUrl: "https://cloud.langfuse.com",
		});
	});

	it("prefers LANGFUSE_HOST and strips trailing slashes", () => {
		const cfg = resolveLangfuseConfig({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_HOST: "http://100.93.103.32:3003/",
		});
		expect(cfg?.baseUrl).toBe("http://100.93.103.32:3003");
	});

	it("falls back to LANGFUSE_BASE_URL alias", () => {
		const cfg = resolveLangfuseConfig({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_BASE_URL: "https://lf.example.com",
		});
		expect(cfg?.baseUrl).toBe("https://lf.example.com");
	});

	it("returns null when CYRUS_TELEMETRY_DISABLED is truthy", () => {
		expect(
			resolveLangfuseConfig({
				LANGFUSE_PUBLIC_KEY: PK,
				LANGFUSE_SECRET_KEY: SK,
				CYRUS_TELEMETRY_DISABLED: "1",
			}),
		).toBeNull();
	});
});

describe("resolveTraceVersion", () => {
	it("composes <semver>+<commit> when both env vars are set", () => {
		expect(
			resolveTraceVersion({
				CYRUS_VERSION: "1.2.3",
				CYRUS_BUILD_COMMIT: "abc1234",
			}),
		).toBe("1.2.3+abc1234");
	});

	it("uses the semver alone when no build commit is known", () => {
		expect(resolveTraceVersion({ CYRUS_VERSION: "1.2.3" })).toBe("1.2.3");
	});

	it("trims whitespace from both env values", () => {
		expect(
			resolveTraceVersion({
				CYRUS_VERSION: "  1.2.3  ",
				CYRUS_BUILD_COMMIT: "  abc1234  ",
			}),
		).toBe("1.2.3+abc1234");
	});

	it("falls back to the runner package version (never 'unknown' in-repo) when CYRUS_VERSION is unset", () => {
		// import.meta.url resolves to src/, so ../package.json is readable here.
		const v = resolveTraceVersion({ CYRUS_BUILD_COMMIT: "abc1234" });
		expect(v).toMatch(/^\d+\.\d+\.\d+.*\+abc1234$/);
		expect(v.startsWith("unknown")).toBe(false);
	});

	it("returns a bare semver when neither env var is set", () => {
		expect(resolveTraceVersion({})).toMatch(/^\d+\.\d+\.\d+/);
	});
});

/**
 * Records every call to the fake Langfuse client for assertions.
 *
 * The trace-client methods deliberately reproduce the real SDK's behavior of
 * *overwriting* `parentObservationId` with the client's own `observationId`
 * (`null` on a trace client) — see `LangfuseObjectClient` in langfuse-core. If
 * the exporter ever routes a nested observation back through `trace.generation()`
 * instead of the root `client.generation()`, the parent link is silently lost;
 * modelling the overwrite here is what makes the nesting tests able to catch it.
 */
function makeFakeClient(): { client: LangfuseLike; calls: unknown[] } {
	const calls: unknown[] = [];
	const viaTraceClient = (kind: string) => (body: Record<string, unknown>) => {
		calls.push({
			kind,
			body: { ...body, parentObservationId: null, traceId: "from-trace" },
		});
	};
	const client: LangfuseLike = {
		trace(body) {
			calls.push({ kind: "trace", body });
			return {
				generation: viaTraceClient("generation"),
				span: viaTraceClient("span"),
				event: viaTraceClient("event"),
			};
		},
		generation(body) {
			calls.push({ kind: "generation", body });
		},
		span(body) {
			calls.push({ kind: "span", body });
		},
		event(body) {
			calls.push({ kind: "event", body });
		},
		async flushAsync() {
			calls.push({ kind: "flush" });
		},
		async shutdownAsync() {
			calls.push({ kind: "shutdown" });
		},
	};
	return { client, calls };
}

/** A small transcript matching the real Claude Code JSONL schema. */
function transcript(lines: string[]): string {
	return lines.join("\n");
}

describe("exportTranscriptToLangfuse", () => {
	it("rejects when the Langfuse SDK reports a failed ingestion batch", async () => {
		const { client: baseClient } = makeFakeClient();
		const listeners = new Map<string, (error: unknown) => void>();
		const client: LangfuseLike = {
			...baseClient,
			on(event, listener) {
				listeners.set(event, listener);
				return () => listeners.delete(event);
			},
			async flushAsync() {
				listeners.get("warning")?.(
					new Error("Langfuse ingestion failed with status 500"),
				);
			},
		};
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u-ingestion-failure",
					timestamp: "2026-07-14T10:00:00.000Z",
					message: { role: "user", content: "hello" },
				}),
			]),
		);

		await expect(
			exportTranscriptToLangfuse({
				transcriptPath,
				sessionId: "sess-ingestion-failure",
				config: CONFIG,
				clientFactory: () => client,
			}),
		).rejects.toThrow("Langfuse ingestion failed with status 500");
	});

	it("emits one generation per assistant turn + one span per tool_use", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: {
						role: "user",
						content: [{ type: "text", text: "hello" }],
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						stop_reason: "end_turn",
						content: [
							{ type: "text", text: "Hi! Let me read the file." },
							{
								type: "tool_use",
								id: "tu-1",
								name: "Read",
								input: { file_path: "/tmp/a.ts" },
							},
						],
						usage: {
							input_tokens: 100,
							cache_read_input_tokens: 50,
							output_tokens: 20,
						},
					},
				}),
				JSON.stringify({
					type: "user",
					uuid: "u2",
					timestamp: "2026-07-08T10:00:02.000Z",
					message: {
						role: "user",
						content: [
							{
								type: "tool_result",
								tool_use_id: "tu-1",
								content: "file contents here",
							},
						],
					},
				}),
			]),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-123",
			config: CONFIG,
			traceName: "DEV-120",
			clientFactory: () => client,
		});

		expect(result).toEqual({
			generations: 1,
			toolSpans: 1,
			compactions: 0,
			subagents: 0,
			subagentGenerations: 0,
			subagentToolSpans: 0,
		});
		const generations = calls.filter(
			(c) => (c as { kind: string }).kind === "generation",
		);
		const spans = calls.filter((c) => (c as { kind: string }).kind === "span");
		const traces = calls.filter(
			(c) => (c as { kind: string }).kind === "trace",
		);

		expect(traces).toHaveLength(1);
		expect((traces[0] as { body: Record<string, unknown> }).body).toMatchObject(
			{
				name: "DEV-120",
				sessionId: "sess-123",
				metadata: { source: "cyrus", claudeSessionId: "sess-123" },
			},
		);

		expect(generations).toHaveLength(1);
		expect(
			(generations[0] as { body: Record<string, unknown> }).body,
		).toMatchObject({
			name: "assistant-turn",
			model: "claude-opus-4-8",
			// Input is broken down by cache tier so Langfuse can price cache
			// reads separately from fresh (uncached) input.
			usageDetails: {
				input: 100,
				cache_read_input_tokens: 50,
				cache_creation_input_tokens: 0,
				output: 20,
			},
		});

		expect(spans).toHaveLength(1);
		expect((spans[0] as { body: Record<string, unknown> }).body).toMatchObject({
			name: "tool:Read",
			input: { file_path: "/tmp/a.ts" },
			output: "file contents here",
		});
	});

	it("stamps the trace (and its metadata) with the resolved build version", async () => {
		const prevVersion = process.env.CYRUS_VERSION;
		const prevCommit = process.env.CYRUS_BUILD_COMMIT;
		process.env.CYRUS_VERSION = "0.2.66";
		process.env.CYRUS_BUILD_COMMIT = "deadbee";
		try {
			const { client, calls } = makeFakeClient();
			const transcriptPath = writeTempTranscript(
				transcript([
					JSON.stringify({
						type: "user",
						uuid: "u1",
						timestamp: "2026-07-08T10:00:00.000Z",
						message: { role: "user", content: "hi" },
					}),
					JSON.stringify({
						type: "assistant",
						uuid: "a1",
						timestamp: "2026-07-08T10:00:01.000Z",
						message: {
							id: "msg-1",
							role: "assistant",
							model: "claude-opus-4-8",
							content: [{ type: "text", text: "hello" }],
							usage: { input_tokens: 10, output_tokens: 5 },
						},
					}),
				]),
			);

			await exportTranscriptToLangfuse({
				transcriptPath,
				sessionId: "sess-ver",
				config: CONFIG,
				clientFactory: () => client,
			});

			const trace = calls.find(
				(c) => (c as { kind: string }).kind === "trace",
			) as { body: Record<string, unknown> };
			expect(trace.body.version).toBe("0.2.66+deadbee");
			expect(trace.body.metadata).toMatchObject({ version: "0.2.66+deadbee" });
		} finally {
			if (prevVersion === undefined) delete process.env.CYRUS_VERSION;
			else process.env.CYRUS_VERSION = prevVersion;
			if (prevCommit === undefined) delete process.env.CYRUS_BUILD_COMMIT;
			else process.env.CYRUS_BUILD_COMMIT = prevCommit;
		}
	});

	it("uses deterministic trace + object ids (re-export is idempotent)", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: "hi" },
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "hello" }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				}),
			]),
		);

		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-xyz",
			config: CONFIG,
			clientFactory: () => client,
		});

		const trace = calls.find((c) => (c as { kind: string }).kind === "trace");
		const gen = calls.find(
			(c) => (c as { kind: string }).kind === "generation",
		);
		expect((trace as { body: { id: string } }).body.id).toBe("cyrus-sess-xyz");
		// Keyed by the assistant message id, not the per-record uuid.
		expect((gen as { body: { id: string } }).body.id).toBe("gen-msg-1");
	});

	it("emits one generation for a message split across multiple JSONL records", async () => {
		// Claude Code writes one assistant message as several records (one per
		// content block: thinking / text / each tool_use), all repeating the
		// same cumulative usage. We must collapse them into a single turn so the
		// token usage — and thus cost — is not counted once per block.
		const { client, calls } = makeFakeClient();
		const usage = {
			input_tokens: 200,
			cache_read_input_tokens: 1000,
			cache_creation_input_tokens: 300,
			output_tokens: 40,
		};
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: "do the thing" },
				}),
				// Three records, same message.id, distinct uuids, identical usage.
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-split",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "thinking", thinking: "hmm" }],
						usage,
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a2",
					timestamp: "2026-07-08T10:00:01.500Z",
					message: {
						id: "msg-split",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "Working on it." }],
						usage,
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a3",
					timestamp: "2026-07-08T10:00:02.000Z",
					message: {
						id: "msg-split",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [
							{
								type: "tool_use",
								id: "tu-9",
								name: "Bash",
								input: { command: "ls" },
							},
						],
						usage,
					},
				}),
			]),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-split",
			config: CONFIG,
			clientFactory: () => client,
		});

		// One turn, one tool span — NOT three generations.
		expect(result).toEqual({
			generations: 1,
			toolSpans: 1,
			compactions: 0,
			subagents: 0,
			subagentGenerations: 0,
			subagentToolSpans: 0,
		});
		const generations = calls.filter(
			(c) => (c as { kind: string }).kind === "generation",
		);
		expect(generations).toHaveLength(1);
		expect(
			(generations[0] as { body: Record<string, unknown> }).body,
		).toMatchObject({
			id: "gen-msg-split",
			output: "Working on it.",
			usageDetails: {
				input: 200,
				cache_read_input_tokens: 1000,
				cache_creation_input_tokens: 300,
				output: 40,
			},
		});
	});

	it("emits one event per compact_boundary record, keyed deterministically", async () => {
		const { client, calls } = makeFakeClient();
		// Field names mirror real transcripts: the JSONL spells the metadata in
		// camelCase, unlike the SDK's in-stream snake_case `compact_metadata`.
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "go" }] },
				}),
				JSON.stringify({
					type: "system",
					subtype: "compact_boundary",
					uuid: "cb-1",
					timestamp: "2026-07-08T10:00:05.000Z",
					content: "Conversation compacted",
					compactMetadata: {
						trigger: "auto",
						preTokens: 406100,
						postTokens: 12659,
						durationMs: 114565,
						cumulativeDroppedTokens: 393441,
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:06.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						stop_reason: "end_turn",
						content: [{ type: "text", text: "done" }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				}),
			]),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-compact",
			config: CONFIG,
			clientFactory: () => client,
		});

		expect(result).toEqual({
			generations: 1,
			toolSpans: 0,
			compactions: 1,
			subagents: 0,
			subagentGenerations: 0,
			subagentToolSpans: 0,
		});
		const events = calls.filter(
			(c) => (c as { kind: string }).kind === "event",
		);
		expect(events).toHaveLength(1);
		expect((events[0] as { body: Record<string, unknown> }).body).toMatchObject(
			{
				id: "compact-cb-1",
				name: "compact_boundary",
				metadata: {
					trigger: "auto",
					preTokens: 406100,
					postTokens: 12659,
					durationMs: 114565,
					cumulativeDroppedTokens: 393441,
				},
			},
		);
	});

	it("emits no compaction events for a transcript without a boundary", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: [{ type: "text", text: "go" }] },
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "done" }],
						usage: { input_tokens: 10, output_tokens: 5 },
					},
				}),
			]),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-plain",
			config: CONFIG,
			clientFactory: () => client,
		});

		expect(result.compactions).toBe(0);
		expect(
			calls.filter((c) => (c as { kind: string }).kind === "event"),
		).toHaveLength(0);
	});

	it("reconstructs real per-turn and per-tool durations from timestamps", async () => {
		// A two-turn session: the model spends 3s on turn 1 (ending in a tool
		// call), the tool runs 2s, then the model spends 4s on turn 2. Every
		// observation must report the real interval, not a zero-duration point.
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: "read the file" },
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:03.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [
							{
								type: "tool_use",
								id: "tu-1",
								name: "Read",
								input: { file_path: "/tmp/a.ts" },
							},
						],
						usage: { input_tokens: 100, output_tokens: 20 },
					},
				}),
				JSON.stringify({
					type: "user",
					uuid: "u2",
					timestamp: "2026-07-08T10:00:05.000Z",
					message: {
						role: "user",
						content: [
							{ type: "tool_result", tool_use_id: "tu-1", content: "contents" },
						],
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a2",
					timestamp: "2026-07-08T10:00:09.000Z",
					message: {
						id: "msg-2",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "done" }],
						usage: { input_tokens: 120, output_tokens: 8 },
					},
				}),
			]),
		);

		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-timing",
			config: CONFIG,
			clientFactory: () => client,
		});

		const bodyById = (kind: string, id: string) =>
			(
				calls.find(
					(c) =>
						(c as { kind: string; body?: { id?: string } }).kind === kind &&
						(c as { body?: { id?: string } }).body?.id === id,
				) as { body: { startTime?: Date; endTime?: Date } } | undefined
			)?.body;

		// Turn 1: 10:00:00 (triggering user prompt) -> 10:00:03 (response).
		const turn1 = bodyById("generation", "gen-msg-1");
		expect(turn1?.startTime?.toISOString()).toBe("2026-07-08T10:00:00.000Z");
		expect(turn1?.endTime?.toISOString()).toBe("2026-07-08T10:00:03.000Z");

		// Tool span: emitted at the turn's response (10:00:03) -> tool_result
		// lands (10:00:05).
		const tool = bodyById("span", "tool-tu-1");
		expect(tool?.startTime?.toISOString()).toBe("2026-07-08T10:00:03.000Z");
		expect(tool?.endTime?.toISOString()).toBe("2026-07-08T10:00:05.000Z");

		// Turn 2: 10:00:05 (prior tool_result triggered it) -> 10:00:09.
		const turn2 = bodyById("generation", "gen-msg-2");
		expect(turn2?.startTime?.toISOString()).toBe("2026-07-08T10:00:05.000Z");
		expect(turn2?.endTime?.toISOString()).toBe("2026-07-08T10:00:09.000Z");
	});

	it("collapses a split message's endTime to its latest record", async () => {
		// The three-record split turn spans 10:00:01 -> 10:00:02; startTime comes
		// from the 10:00:00 user prompt that triggered it.
		const { client, calls } = makeFakeClient();
		const usage = { input_tokens: 200, output_tokens: 40 };
		const transcriptPath = writeTempTranscript(
			transcript([
				JSON.stringify({
					type: "user",
					uuid: "u1",
					timestamp: "2026-07-08T10:00:00.000Z",
					message: { role: "user", content: "do the thing" },
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-split",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "thinking", thinking: "hmm" }],
						usage,
					},
				}),
				JSON.stringify({
					type: "assistant",
					uuid: "a2",
					timestamp: "2026-07-08T10:00:02.000Z",
					message: {
						id: "msg-split",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "done" }],
						usage,
					},
				}),
			]),
		);

		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-split-timing",
			config: CONFIG,
			clientFactory: () => client,
		});

		const gen = calls.find(
			(c) => (c as { kind: string }).kind === "generation",
		) as { body: { startTime?: Date; endTime?: Date } };
		expect(gen.body.startTime?.toISOString()).toBe("2026-07-08T10:00:00.000Z");
		expect(gen.body.endTime?.toISOString()).toBe("2026-07-08T10:00:02.000Z");
	});

	it("skips corrupt JSONL lines without failing", async () => {
		const { client } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			[
				"this is not json {{{",
				JSON.stringify({
					type: "assistant",
					uuid: "a1",
					timestamp: "2026-07-08T10:00:01.000Z",
					message: {
						id: "msg-1",
						role: "assistant",
						model: "claude-opus-4-8",
						content: [{ type: "text", text: "hi" }],
						usage: { input_tokens: 1, output_tokens: 1 },
					},
				}),
				"",
			].join("\n"),
		);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-bad",
			config: CONFIG,
			clientFactory: () => client,
		});
		expect(result.generations).toBe(1);
	});

	it("flushes and shuts down the client", async () => {
		const { client, calls } = makeFakeClient();
		const transcriptPath = writeTempTranscript("");
		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-empty",
			config: CONFIG,
			clientFactory: () => client,
		});
		expect(calls.some((c) => (c as { kind: string }).kind === "flush")).toBe(
			true,
		);
		expect(calls.some((c) => (c as { kind: string }).kind === "shutdown")).toBe(
			true,
		);
	});
});

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "langfuse-export-test-"));
let fileCounter = 0;
function writeTempTranscript(content: string): string {
	const path = join(tmpDir, `transcript-${fileCounter++}.jsonl`);
	writeFileSync(path, content, "utf8");
	return path;
}

/**
 * Write a subagent transcript into the location Claude Code actually uses:
 * `<transcript-without-.jsonl>/subagents/agent-<agentId>.jsonl`.
 */
function writeTempSubagent(
	transcriptPath: string,
	agentId: string,
	content: string,
): void {
	const dir = join(
		dirname(transcriptPath),
		basename(transcriptPath, ".jsonl"),
		"subagents",
	);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, `agent-${agentId}.jsonl`), content, "utf8");
}

/** The main-thread half of a delegating session: one Agent call + its result. */
function delegatingMainTranscript(agentId: string): string {
	return transcript([
		JSON.stringify({
			type: "user",
			uuid: "u1",
			timestamp: "2026-07-08T10:00:00.000Z",
			message: { role: "user", content: "where does auth live?" },
		}),
		JSON.stringify({
			type: "assistant",
			uuid: "a1",
			timestamp: "2026-07-08T10:00:01.000Z",
			message: {
				id: "msg-main",
				role: "assistant",
				model: "claude-opus-4-8",
				content: [
					{
						type: "tool_use",
						id: "toolu-agent-1",
						name: "Agent",
						input: { subagent_type: "Explore", prompt: "find auth" },
					},
				],
				usage: { input_tokens: 10, output_tokens: 5 },
			},
		}),
		JSON.stringify({
			type: "user",
			uuid: "u2",
			timestamp: "2026-07-08T10:00:30.000Z",
			message: {
				role: "user",
				content: [
					{
						type: "tool_result",
						tool_use_id: "toolu-agent-1",
						content: [
							{
								type: "text",
								text: `Async agent launched successfully.\nagentId: ${agentId} (internal ID - do not mention to user.`,
							},
						],
					},
				],
			},
		}),
	]);
}

/** A subagent's own transcript: one turn that burns real tokens + one tool call. */
const SUBAGENT_TRANSCRIPT = transcript([
	JSON.stringify({
		type: "user",
		uuid: "su1",
		isSidechain: true,
		timestamp: "2026-07-08T10:00:02.000Z",
		message: { role: "user", content: "find auth" },
	}),
	JSON.stringify({
		type: "assistant",
		uuid: "sa1",
		isSidechain: true,
		timestamp: "2026-07-08T10:00:20.000Z",
		message: {
			id: "msg-sub-1",
			role: "assistant",
			model: "claude-opus-4-8",
			content: [
				{
					type: "tool_use",
					id: "toolu-sub-grep",
					name: "Grep",
					input: { pattern: "auth" },
				},
			],
			// The whole point: this usage exists nowhere in the main transcript.
			usage: {
				input_tokens: 500,
				cache_read_input_tokens: 90_000,
				cache_creation_input_tokens: 2_000,
				output_tokens: 300,
			},
		},
	}),
]);

describe("subagent transcripts", () => {
	it("returns no subagents for a session that never delegated", () => {
		const transcriptPath = writeTempTranscript("");
		expect(findSubagentTranscripts(transcriptPath)).toEqual([]);
	});

	it("discovers subagent transcripts by their on-disk agent id", () => {
		const transcriptPath = writeTempTranscript("");
		writeTempSubagent(transcriptPath, "a379cd62836b5edec", SUBAGENT_TRANSCRIPT);
		expect(findSubagentTranscripts(transcriptPath)).toEqual([
			{
				agentId: "a379cd62836b5edec",
				path: expect.stringContaining("agent-a379cd62836b5edec.jsonl"),
			},
		]);
	});

	it("exports subagent turns — the tokens the main transcript never sees", async () => {
		const { client, calls } = makeFakeClient();
		const agentId = "a379cd62836b5edec";
		const transcriptPath = writeTempTranscript(
			delegatingMainTranscript(agentId),
		);
		writeTempSubagent(transcriptPath, agentId, SUBAGENT_TRANSCRIPT);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-delegating",
			config: CONFIG,
			clientFactory: () => client,
		});

		// Main thread: 1 turn, 1 tool call (the Agent call itself).
		// Subagent: 1 turn, 1 tool call — counted separately, not silently dropped.
		expect(result).toEqual({
			generations: 1,
			toolSpans: 1,
			compactions: 0,
			subagents: 1,
			subagentGenerations: 1,
			subagentToolSpans: 1,
		});

		const generations = calls.filter(
			(c) => (c as { kind: string }).kind === "generation",
		) as { body: Record<string, unknown> }[];
		const sub = generations.find((g) => g.body.id === "gen-msg-sub-1");

		// The subagent's usage must reach Langfuse, or a delegating session looks
		// far cheaper than it is.
		expect(sub?.body).toMatchObject({
			name: "subagent-turn",
			model: "claude-opus-4-8",
			usageDetails: {
				input: 500,
				cache_read_input_tokens: 90_000,
				cache_creation_input_tokens: 2_000,
				output: 300,
			},
			metadata: { subagent: true, agentId },
		});
	});

	it("nests subagent observations under the Agent tool span that spawned them", async () => {
		const { client, calls } = makeFakeClient();
		const agentId = "a379cd62836b5edec";
		const transcriptPath = writeTempTranscript(
			delegatingMainTranscript(agentId),
		);
		writeTempSubagent(transcriptPath, agentId, SUBAGENT_TRANSCRIPT);

		await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-nesting",
			config: CONFIG,
			clientFactory: () => client,
		});

		const bodyById = (kind: string, id: string) =>
			(
				calls.find(
					(c) =>
						(c as { kind: string; body?: { id?: string } }).kind === kind &&
						(c as { body?: { id?: string } }).body?.id === id,
				) as { body: Record<string, unknown> } | undefined
			)?.body;

		// The spawn link is recovered from `agentId:` in the Agent tool_result.
		expect(bodyById("generation", "gen-msg-sub-1")?.parentObservationId).toBe(
			"tool-toolu-agent-1",
		);
		expect(bodyById("span", "tool-toolu-sub-grep")?.parentObservationId).toBe(
			"tool-toolu-agent-1",
		);
		// Main-thread turns stay at the trace root.
		expect(
			bodyById("generation", "gen-msg-main")?.parentObservationId,
		).toBeUndefined();
	});

	it("nests a SYNC-spawned subagent, whose tool result carries no agentId", async () => {
		// The common case: the Agent tool returns the subagent's finished report,
		// not a launch receipt, so there is no `agentId:` to match on. Matching by
		// id alone left these unparented — the subagent ran inside the Agent call's
		// window, so fall back to that.
		const { client, calls } = makeFakeClient();
		const main = transcript([
			JSON.stringify({
				type: "user",
				uuid: "u1",
				timestamp: "2026-07-08T10:00:00.000Z",
				message: { role: "user", content: "where does auth live?" },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "a1",
				timestamp: "2026-07-08T10:00:01.000Z",
				message: {
					id: "msg-main",
					role: "assistant",
					model: "claude-opus-4-8",
					content: [
						{
							type: "tool_use",
							id: "toolu-sync-1",
							name: "Agent",
							input: { subagent_type: "Explore" },
						},
					],
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			}),
			JSON.stringify({
				type: "user",
				uuid: "u2",
				timestamp: "2026-07-08T10:00:30.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu-sync-1",
							// A finished report — no agentId anywhere.
							content: [
								{ type: "text", text: "## Report\nAuth lives in auth.ts:42" },
							],
						},
					],
				},
			}),
		]);
		const transcriptPath = writeTempTranscript(main);
		// Subagent transcript opens inside the Agent call's window (01s..30s).
		writeTempSubagent(transcriptPath, "syncagent01", SUBAGENT_TRANSCRIPT);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-sync",
			config: CONFIG,
			clientFactory: () => client,
		});

		expect(result.subagentGenerations).toBe(1);
		const gen = calls.find(
			(c) =>
				(c as { kind: string; body?: { id?: string } }).kind === "generation" &&
				(c as { body?: { id?: string } }).body?.id === "gen-msg-sub-1",
		) as { body: Record<string, unknown> };
		expect(gen.body.parentObservationId).toBe("tool-toolu-sync-1");
	});

	it("leaves a subagent unlinked rather than guessing when the window is ambiguous", async () => {
		// Two concurrent Agent calls, neither naming an agentId: a wrong parent is
		// worse than none, so it stays at the trace root (still fully costed).
		const { client, calls } = makeFakeClient();
		const main = transcript([
			JSON.stringify({
				type: "user",
				uuid: "u1",
				timestamp: "2026-07-08T10:00:00.000Z",
				message: { role: "user", content: "go" },
			}),
			JSON.stringify({
				type: "assistant",
				uuid: "a1",
				timestamp: "2026-07-08T10:00:01.000Z",
				message: {
					id: "msg-main",
					role: "assistant",
					model: "claude-opus-4-8",
					content: [
						{ type: "tool_use", id: "toolu-p1", name: "Agent", input: {} },
						{ type: "tool_use", id: "toolu-p2", name: "Agent", input: {} },
					],
					usage: { input_tokens: 10, output_tokens: 5 },
				},
			}),
			JSON.stringify({
				type: "user",
				uuid: "u2",
				timestamp: "2026-07-08T10:00:30.000Z",
				message: {
					role: "user",
					content: [
						{
							type: "tool_result",
							tool_use_id: "toolu-p1",
							content: "report A",
						},
						{
							type: "tool_result",
							tool_use_id: "toolu-p2",
							content: "report B",
						},
					],
				},
			}),
		]);
		const transcriptPath = writeTempTranscript(main);
		writeTempSubagent(transcriptPath, "ambiguous01", SUBAGENT_TRANSCRIPT);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-ambiguous",
			config: CONFIG,
			clientFactory: () => client,
		});

		// Still exported and costed — just not parented.
		expect(result.subagentGenerations).toBe(1);
		const gen = calls.find(
			(c) =>
				(c as { kind: string; body?: { id?: string } }).kind === "generation" &&
				(c as { body?: { id?: string } }).body?.id === "gen-msg-sub-1",
		) as { body: Record<string, unknown> };
		expect(gen.body.parentObservationId).toBeUndefined();
	});

	it("still exports a subagent whose spawning Agent call cannot be matched", async () => {
		// Defensive: if the tool_result text ever stops carrying `agentId:`, the
		// tokens must still be reported — orphaned at the trace root, not dropped.
		const { client } = makeFakeClient();
		const transcriptPath = writeTempTranscript(
			delegatingMainTranscript("some-other-id"),
		);
		writeTempSubagent(transcriptPath, "unmatched-agent", SUBAGENT_TRANSCRIPT);

		const result = await exportTranscriptToLangfuse({
			transcriptPath,
			sessionId: "sess-orphan",
			config: CONFIG,
			clientFactory: () => client,
		});

		expect(result.subagents).toBe(1);
		expect(result.subagentGenerations).toBe(1);
	});
});

/** Build a one-turn transcript whose single assistant turn carries `usage`. */
function turnWithUsage(usage: Record<string, unknown>): string {
	return transcript([
		JSON.stringify({
			type: "user",
			uuid: "u1",
			timestamp: "2026-07-08T10:00:00.000Z",
			message: { role: "user", content: "go" },
		}),
		JSON.stringify({
			type: "assistant",
			uuid: "a1",
			timestamp: "2026-07-08T10:00:01.000Z",
			message: {
				id: "msg-ttl",
				role: "assistant",
				model: "claude-opus-4-8",
				content: [{ type: "text", text: "done" }],
				usage,
			},
		}),
	]);
}

async function usageDetailsFor(
	usage: Record<string, unknown>,
): Promise<Record<string, number>> {
	const { client, calls } = makeFakeClient();
	await exportTranscriptToLangfuse({
		transcriptPath: writeTempTranscript(turnWithUsage(usage)),
		sessionId: `sess-ttl-${fileCounter}`,
		config: CONFIG,
		clientFactory: () => client,
	});
	const gen = calls.find(
		(c) => (c as { kind: string }).kind === "generation",
	) as { body: { usageDetails: Record<string, number> } };
	return gen.body.usageDetails;
}

/**
 * Anthropic bills a 1-hour cache write at 2x base and a 5-minute write at 1.25x.
 * Langfuse prices those under separate usage keys; its flat
 * `cache_creation_input_tokens` key is the 5-minute rate. Cyrus writes 1-hour
 * cache almost exclusively, so reporting the flat key charged cache writes at
 * 62.5% of their real cost.
 */
describe("cache-write TTL pricing", () => {
	it("reports a 1-hour cache write under the 1h key, not the flat (5m-priced) one", async () => {
		const details = await usageDetailsFor({
			input_tokens: 2_766,
			cache_creation_input_tokens: 32_040,
			cache_read_input_tokens: 0,
			output_tokens: 826,
			cache_creation: {
				ephemeral_1h_input_tokens: 32_040,
				ephemeral_5m_input_tokens: 0,
			},
		});

		expect(details.input_cache_creation_1h).toBe(32_040);
		// The flat key is priced at the 5m rate — emitting it here would undercharge.
		expect(details).not.toHaveProperty("cache_creation_input_tokens");
	});

	it("splits a mixed-TTL turn across both keys without double-counting", async () => {
		const details = await usageDetailsFor({
			input_tokens: 10,
			cache_creation_input_tokens: 1_000,
			cache_read_input_tokens: 0,
			output_tokens: 5,
			cache_creation: {
				ephemeral_1h_input_tokens: 700,
				ephemeral_5m_input_tokens: 300,
			},
		});

		expect(details.input_cache_creation_1h).toBe(700);
		expect(details.input_cache_creation_5m).toBe(300);
		// Each key is priced independently — a token counted twice is billed twice.
		const written =
			(details.input_cache_creation_1h ?? 0) +
			(details.input_cache_creation_5m ?? 0) +
			(details.cache_creation_input_tokens ?? 0);
		expect(written).toBe(1_000);
	});

	it("falls back to the flat key when the transcript records no TTL breakdown", async () => {
		const details = await usageDetailsFor({
			input_tokens: 10,
			cache_creation_input_tokens: 500,
			cache_read_input_tokens: 0,
			output_tokens: 5,
		});

		expect(details.cache_creation_input_tokens).toBe(500);
		expect(details).not.toHaveProperty("input_cache_creation_1h");
	});

	it("attributes an unexplained remainder to the flat key rather than guessing a TTL", async () => {
		const details = await usageDetailsFor({
			input_tokens: 10,
			cache_creation_input_tokens: 1_000,
			cache_read_input_tokens: 0,
			output_tokens: 5,
			cache_creation: {
				ephemeral_1h_input_tokens: 600,
				ephemeral_5m_input_tokens: 0,
			},
		});

		expect(details.input_cache_creation_1h).toBe(600);
		expect(details.cache_creation_input_tokens).toBe(400);
	});
});
