/**
 * Langfuse LLMOps export for Claude Code sessions.
 *
 * ## Why this exists (and why the previous OTLP approach did not work)
 *
 * The first cut of this feature (see git history for `telemetry-env.ts`) set
 * `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus `OTEL_*` exporter variables and pointed
 * them at Langfuse's OTLP receiver, on the assumption that the Claude Agent SDK
 * emits OpenTelemetry **spans** around each model request. That assumption is
 * wrong for shipped Claude Code: with telemetry enabled it exports OTLP
 * **logs** (`/v1/logs`) and **metrics** (`/v1/metrics`) only — never traces
 * (`/v1/traces`). Langfuse's OTLP endpoint, in turn, only ingests **spans**;
 * `/v1/logs` 404s and `/v1/metrics` is accepted-but-discarded. The two sides
 * therefore never overlap and nothing is ever ingested (verified empirically
 * against Claude Code 2.1.x and Langfuse v3.206).
 *
 * ## What this does instead
 *
 * Langfuse's own Claude Code integration reconstructs a trace from the session
 * **transcript** rather than from OTLP. We do the same, but natively in
 * TypeScript against Langfuse's first-class ingestion API (which every Langfuse
 * version supports), so there is no Python runtime, no vendored hook script,
 * and no private-SDK-attribute dependency. `ClaudeRunner` registers a
 * `SessionEnd` hook that hands us the transcript path; we parse the JSONL and
 * emit one Langfuse trace per Claude Code session:
 *   - one `generation` per assistant turn (model, token usage, prompt, output),
 *   - one child `span` per tool call (input + matched tool_result output).
 *
 * Each observation carries a real wall-clock duration reconstructed from the
 * transcript record timestamps: a turn runs from the record that triggered it
 * (the user prompt or the prior `tool_result`) to the assistant record that
 * answered it, and a tool span runs until its `tool_result` lands. This lets
 * Langfuse show which turns dominate a session's latency instead of reporting
 * every span as zero-duration. Per-turn `timeToFirstToken` is deliberately left
 * unset — it needs streaming timing a post-hoc transcript does not record, so a
 * reported `0` would be a lie rather than a measurement.
 *
 * All Langfuse object IDs are derived deterministically from stable transcript
 * IDs (session id, assistant message id, tool_use id), so a re-export upserts
 * the same objects instead of duplicating them — safe to call more than once.
 * Crucially, a generation is keyed by the assistant `message.id`, not the
 * per-block record `uuid`: one message spans several JSONL records that each
 * repeat the full `message.usage`, so keying on `uuid` would emit a generation
 * per block and multiply the turn's cost by the number of blocks.
 *
 * Reference: https://langfuse.com/integrations/other/claude-code
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ILogger } from "cyrus-core";

/** Default Langfuse Cloud host (EU region), used when none is configured. */
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

/** Resolved credentials + endpoint for a Langfuse project. */
export interface LangfuseConfig {
	publicKey: string;
	secretKey: string;
	baseUrl: string;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve the Langfuse configuration from Cyrus-friendly env vars.
 *
 * Returns `null` (export stays off) when `CYRUS_TELEMETRY_DISABLED` is truthy
 * or when either key is missing — so this is safe to call for every session and
 * is a no-op until an operator pastes their Langfuse keys into `~/.cyrus/.env`.
 *
 * `LANGFUSE_HOST` is preferred (matches the name Cyrus already documents);
 * `LANGFUSE_BASE_URL` is accepted as an alias for parity with Langfuse's own
 * SDK naming.
 */
export function resolveLangfuseConfig(
	env: NodeJS.ProcessEnv = process.env,
): LangfuseConfig | null {
	if (isTruthyEnv(env.CYRUS_TELEMETRY_DISABLED)) return null;
	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	if (!publicKey || !secretKey) return null;
	const baseUrl =
		env.LANGFUSE_HOST?.trim() ||
		env.LANGFUSE_BASE_URL?.trim() ||
		DEFAULT_LANGFUSE_HOST;
	return { publicKey, secretKey, baseUrl: baseUrl.replace(/\/+$/, "") };
}

/**
 * Cyrus's own package version, read once from the runner package's
 * `package.json`. This is the dev/no-env fallback for the trace version; in the
 * deployed systemd runtime `CYRUS_VERSION` is set explicitly (see
 * `scripts/deploy-local.sh`) so this read is not relied upon there. Never
 * throws — an unreadable/renamed package.json degrades to `"unknown"` rather
 * than breaking the export.
 */
let cachedPackageVersion: string | undefined;
function readCyrusPackageVersion(): string {
	if (cachedPackageVersion !== undefined) return cachedPackageVersion;
	try {
		// dist/langfuse-exporter.js and src/langfuse-exporter.ts both sit one
		// level under the package root, so `../package.json` resolves for the
		// built output and for ts-run tests alike.
		const pkgPath = resolve(
			dirname(fileURLToPath(import.meta.url)),
			"..",
			"package.json",
		);
		const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
			version?: string;
		};
		cachedPackageVersion = pkg.version?.trim() || "unknown";
	} catch {
		cachedPackageVersion = "unknown";
	}
	return cachedPackageVersion;
}

/**
 * Compose the Langfuse trace `version` — the field Langfuse's version-comparison
 * view keys on — so traces are attributable to a specific Cyrus build.
 *
 * Shape: `<semver>` or `<semver>+<commit>` when a build commit is known. The
 * semver alone is static across a change (every package sits at the same
 * version), so the appended short commit is what makes each deploy distinct and
 * lets you compare newest-vs-previous even without a version bump.
 *
 * Sources (all optional; graceful fallbacks):
 *   - semver:  `CYRUS_VERSION` env → runner `package.json` version → `"unknown"`.
 *   - commit:  `CYRUS_BUILD_COMMIT` env (short SHA injected by the deploy
 *     script). Omitted from the string when unset (e.g. local dev).
 */
export function resolveTraceVersion(
	env: NodeJS.ProcessEnv = process.env,
): string {
	const semver = env.CYRUS_VERSION?.trim() || readCyrusPackageVersion();
	const commit = env.CYRUS_BUILD_COMMIT?.trim();
	return commit ? `${semver}+${commit}` : semver;
}

/** A single JSONL record from a Claude Code transcript (loosely typed). */
interface TranscriptRecord {
	type?: string;
	uuid?: string;
	timestamp?: string;
	message?: {
		id?: string;
		role?: string;
		model?: string;
		content?: unknown;
		usage?: Record<string, unknown>;
		stop_reason?: string | null;
	};
}

interface ContentBlock {
	type?: string;
	text?: string;
	thinking?: string;
	name?: string;
	id?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
}

/**
 * One assistant turn, aggregated from the several JSONL records Claude Code
 * writes per message (one per content block — thinking / text / each tool_use),
 * all of which repeat the same cumulative `message.usage`.
 */
interface AssistantTurn {
	id: string;
	model?: string;
	inputText: string;
	outputParts: string[];
	toolUses: ContentBlock[];
	usage: Record<string, unknown>;
	stopReason?: string;
	/** When the request began — timestamp of the record that triggered the turn. */
	startTime?: Date;
	/** When the response completed — timestamp of the turn's latest record. */
	endTime?: Date;
}

/** Coerce a message `content` field into an array of blocks. */
function asBlocks(content: unknown): ContentBlock[] {
	if (Array.isArray(content)) return content as ContentBlock[];
	if (typeof content === "string") return [{ type: "text", text: content }];
	return [];
}

/** Join all text blocks of a content array into a single string. */
function textOf(content: unknown): string {
	return asBlocks(content)
		.filter((b) => b.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n")
		.trim();
}

/** Render a tool_result block's content to a string for span output. */
function resultText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((b: ContentBlock) =>
				b?.type === "text" && typeof b.text === "string"
					? b.text
					: JSON.stringify(b),
			)
			.join("\n");
	}
	return content == null ? "" : JSON.stringify(content);
}

function toDate(ts: string | undefined): Date | undefined {
	if (!ts) return undefined;
	const d = new Date(ts);
	return Number.isNaN(d.getTime()) ? undefined : d;
}

function num(v: unknown): number {
	return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Ensure an observation never ends before it starts. Returns `end` when both
 * bounds exist and `end >= start`; otherwise falls back to `start` (a
 * zero-duration point) so Langfuse still receives a valid, orderable span even
 * when a timestamp is missing or records arrive out of order.
 */
function clampEnd(
	start: Date | undefined,
	end: Date | undefined,
): Date | undefined {
	if (!start) return end;
	if (!end) return start;
	return end.getTime() >= start.getTime() ? end : start;
}

export interface ExportOptions {
	transcriptPath: string;
	sessionId: string;
	config: LangfuseConfig;
	/** Optional human name for the trace (e.g. the Cyrus workspace/issue). */
	traceName?: string;
	/** Extra metadata merged onto the trace (issue id, platform, cwd, …). */
	metadata?: Record<string, unknown>;
	logger?: ILogger;
	/** Injectable Langfuse client constructor for tests. */
	clientFactory?: (config: LangfuseConfig) => LangfuseLike;
}

/**
 * Minimal structural type for the bits of the Langfuse SDK we use. Keeping our
 * own interface (rather than importing the SDK's types) lets tests inject a
 * fake and keeps the SDK an ordinary runtime dependency.
 */
export interface LangfuseLike {
	trace(body: Record<string, unknown>): {
		generation(body: Record<string, unknown>): unknown;
		span(body: Record<string, unknown>): unknown;
	};
	flushAsync(): Promise<unknown>;
	shutdownAsync?(): Promise<unknown>;
}

async function defaultClientFactory(
	config: LangfuseConfig,
): Promise<LangfuseLike> {
	// Imported lazily so the dependency is only touched when export is enabled.
	const { Langfuse } = await import("langfuse");
	return new Langfuse({
		publicKey: config.publicKey,
		secretKey: config.secretKey,
		baseUrl: config.baseUrl,
	}) as unknown as LangfuseLike;
}

/** Result summary for logging/tests. */
export interface ExportResult {
	generations: number;
	toolSpans: number;
}

/**
 * Parse a Claude Code transcript and emit a single Langfuse trace for the
 * session. Never throws for malformed transcript lines — bad lines are skipped.
 * IO/network failures propagate so the caller can log them.
 */
export async function exportTranscriptToLangfuse(
	options: ExportOptions,
): Promise<ExportResult> {
	const { transcriptPath, sessionId, config, metadata } = options;

	const raw = readFileSync(transcriptPath, "utf8");
	const records: TranscriptRecord[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			records.push(JSON.parse(trimmed) as TranscriptRecord);
		} catch {
			// Skip partial/corrupt lines rather than fail the whole export.
		}
	}

	// Pre-pass: map tool_use_id -> tool_result text (results live in later
	// `user` turns, so we resolve them before emitting spans).
	const toolResults = new Map<string, string>();
	const toolResultTimes = new Map<string, Date>();
	for (const rec of records) {
		if (rec.type !== "user") continue;
		const ts = toDate(rec.timestamp);
		for (const block of asBlocks(rec.message?.content)) {
			if (block.type === "tool_result" && block.tool_use_id) {
				toolResults.set(block.tool_use_id, resultText(block.content));
				if (ts) toolResultTimes.set(block.tool_use_id, ts);
			}
		}
	}

	const client = await (options.clientFactory
		? options.clientFactory(config)
		: defaultClientFactory(config));

	const firstTs = records.find((r) => r.timestamp)?.timestamp;
	const version = resolveTraceVersion();
	const trace = client.trace({
		id: `cyrus-${sessionId}`,
		name: options.traceName || `cyrus-session-${sessionId.slice(0, 8)}`,
		sessionId,
		timestamp: toDate(firstTs),
		// Langfuse keys its version-comparison view on `version`; stamping the
		// Cyrus build here lets a session's cost/latency be compared across
		// deploys (e.g. before vs. after an optimization change).
		version,
		metadata: {
			source: "cyrus",
			claudeSessionId: sessionId,
			version,
			...metadata,
		},
	});

	// A single assistant message is written to the transcript as several JSONL
	// records — one per content block — and every one repeats the same
	// cumulative `message.usage`. Keying an observation off the per-record
	// `uuid` therefore emits N generations for one turn, each stamped with the
	// full token usage, so Langfuse multiplies the turn's cost by N. Aggregate
	// by `message.id` and emit exactly one generation per assistant turn.
	const turns = new Map<string, AssistantTurn>();
	let lastUserText = "";
	// Timestamp of the previously-seen record (of any type). A turn's request
	// begins when the record that triggered it — the user prompt or the prior
	// tool_result — was written, so we stamp `startTime` from this rather than
	// from the assistant record itself (which marks when the response landed).
	let prevTimestamp: Date | undefined;

	for (const rec of records) {
		const ts = toDate(rec.timestamp);
		if (rec.type === "user") {
			const t = textOf(rec.message?.content);
			// Ignore pure tool_result turns — they are not a human/agent prompt.
			if (t) lastUserText = t;
			prevTimestamp = ts ?? prevTimestamp;
			continue;
		}
		if (rec.type !== "assistant" || !rec.message) {
			prevTimestamp = ts ?? prevTimestamp;
			continue;
		}

		const msg = rec.message;
		const key = msg.id ?? rec.uuid ?? `idx-${turns.size}`;
		let turn = turns.get(key);
		if (!turn) {
			turn = {
				id: key,
				model: msg.model,
				inputText: lastUserText,
				outputParts: [],
				toolUses: [],
				usage: {},
				stopReason: msg.stop_reason ?? undefined,
				// The request began at the triggering record; fall back to this
				// record's own timestamp when there is no predecessor.
				startTime: prevTimestamp ?? ts,
				endTime: ts,
			};
			turns.set(key, turn);
		}
		// One message spans several records; its response is complete at the
		// latest, so advance endTime as later records of the same turn arrive.
		if (ts && (!turn.endTime || ts.getTime() > turn.endTime.getTime())) {
			turn.endTime = ts;
		}
		// Records for one message repeat identical usage; keep the populated one.
		if (msg.usage && Object.keys(msg.usage).length > 0) turn.usage = msg.usage;
		if (msg.model && !turn.model) turn.model = msg.model;
		const text = textOf(msg.content);
		if (text) turn.outputParts.push(text);
		for (const block of asBlocks(msg.content)) {
			if (block.type === "tool_use") turn.toolUses.push(block);
		}
		prevTimestamp = ts ?? prevTimestamp;
	}

	let generations = 0;
	let toolSpans = 0;

	for (const turn of turns.values()) {
		const usage = turn.usage;
		const freshInput = num(usage.input_tokens);
		const cacheRead = num(usage.cache_read_input_tokens);
		const cacheCreation = num(usage.cache_creation_input_tokens);
		const inputTokens = freshInput + cacheRead + cacheCreation;
		const outputTokens = num(usage.output_tokens);
		const { startTime } = turn;
		// Real turn duration: request began at startTime, response landed at
		// endTime. Clamp so a turn never ends before it starts (defends against
		// clock skew / out-of-order records).
		const endTime = clampEnd(startTime, turn.endTime);

		trace.generation({
			id: `gen-${turn.id}`,
			name: "assistant-turn",
			model: turn.model,
			input: turn.inputText || undefined,
			output: turn.outputParts.join("\n") || undefined,
			// Break the input down by cache tier so Langfuse prices cache reads
			// and writes at their (much cheaper) rates instead of charging every
			// input token at the full uncached rate. Langfuse derives `total`.
			usageDetails: {
				input: freshInput,
				cache_read_input_tokens: cacheRead,
				cache_creation_input_tokens: cacheCreation,
				output: outputTokens,
			},
			startTime,
			endTime,
			metadata: {
				stopReason: turn.stopReason,
				rawUsage: usage,
				totalInputTokens: inputTokens,
			},
		});
		generations++;

		// One span per tool call, with its matched result as output. The
		// tool_use is emitted when the turn's response lands (endTime); the tool
		// finishes when its tool_result is written back, so the span covers real
		// tool-execution wall-clock.
		for (const block of turn.toolUses) {
			const toolStart = endTime;
			const toolEnd = clampEnd(
				toolStart,
				(block.id ? toolResultTimes.get(block.id) : undefined) ?? toolStart,
			);
			trace.span({
				id: `tool-${block.id ?? `${turn.id}-${toolSpans}`}`,
				name: `tool:${block.name ?? "unknown"}`,
				input: block.input,
				output: block.id ? toolResults.get(block.id) : undefined,
				startTime: toolStart,
				endTime: toolEnd,
			});
			toolSpans++;
		}
	}

	await client.flushAsync();
	if (client.shutdownAsync) await client.shutdownAsync();

	options.logger?.debug?.(
		`Langfuse export complete: ${generations} generations, ${toolSpans} tool spans`,
	);
	return { generations, toolSpans };
}
