import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	exportTranscriptToLangfuse,
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

/** Records every call to the fake Langfuse client for assertions. */
function makeFakeClient(): { client: LangfuseLike; calls: unknown[] } {
	const calls: unknown[] = [];
	const client: LangfuseLike = {
		trace(body) {
			calls.push({ kind: "trace", body });
			return {
				generation(body) {
					calls.push({ kind: "generation", body });
				},
				span(body) {
					calls.push({ kind: "span", body });
				},
			};
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

		expect(result).toEqual({ generations: 1, toolSpans: 1 });
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
		expect(result).toEqual({ generations: 1, toolSpans: 1 });
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

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpDir = mkdtempSync(join(tmpdir(), "langfuse-export-test-"));
let fileCounter = 0;
function writeTempTranscript(content: string): string {
	const path = join(tmpDir, `transcript-${fileCounter++}.jsonl`);
	writeFileSync(path, content, "utf8");
	return path;
}
