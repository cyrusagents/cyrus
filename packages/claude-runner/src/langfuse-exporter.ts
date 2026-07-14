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
 * ## Subagents (why a second set of files must be read)
 *
 * When the model delegates via the `Agent` tool, the subagent's turns are *not*
 * written into the session transcript — not even as sidechain records. Claude
 * Code writes each subagent to its own file:
 *
 *   ~/.claude/projects/<dir>/<sessionId>/subagents/agent-<agentId>.jsonl
 *
 * Those turns carry their own `message.usage`, and a subagent accumulates and
 * re-sends its own context every turn exactly like the main thread does — so on
 * a delegating session they are a large share of real spend (empirically the
 * majority, dominated by cache reads). Parsing only the session transcript
 * therefore under-reports a delegating session's cost, and would make any
 * "delegate more" change look free simply because the tokens left the trace.
 *
 * We read those files too and emit their turns as ordinary generations, parented
 * to the `Agent` tool span that spawned them so the nesting mirrors what actually
 * happened. The spawn link is recovered from the `Agent` tool_result text, which
 * embeds `agentId: <id>` — the same id as the transcript filename.
 *
 * Reference: https://langfuse.com/integrations/other/claude-code
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
	subtype?: string;
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
	/**
	 * Present on `type:"system", subtype:"compact_boundary"` records. Note the
	 * transcript spells these in camelCase, unlike the snake_case
	 * `compact_metadata` of the SDK's in-stream message.
	 */
	compactMetadata?: {
		trigger?: string;
		preTokens?: number;
		postTokens?: number;
		durationMs?: number;
		cumulativeDroppedTokens?: number;
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
 * Cache-write tokens, split by TTL.
 *
 * Anthropic bills a cache write by how long the entry lives: a 5-minute write
 * costs 1.25x the base input rate, a 1-hour write 2x. Langfuse prices those with
 * *separate* usage keys — `input_cache_creation_5m` and `input_cache_creation_1h`
 * — while the flat `cache_creation_input_tokens` key is priced at the 5-minute
 * rate.
 *
 * Cyrus sessions write 1-hour cache almost exclusively (the idle keep-alive
 * window is built on it — see `claudeSessionKeepAliveMinutes`), so reporting the
 * flat key charged every trace's cache writes at 62.5% of what they actually
 * cost. Measured across this fork's sessions, that hid $181 of real spend.
 *
 * Emit the TTL-split keys when the transcript records the breakdown, and fall
 * back to the flat key when it does not (older transcripts, other providers).
 * The keys are priced *independently*, so the same token must never appear under
 * two of them — any remainder the split does not account for is attributed to
 * the flat key rather than guessed into a TTL bucket.
 */
function cacheCreationUsage(
	usage: Record<string, unknown>,
): Record<string, number> {
	const total = num(usage.cache_creation_input_tokens);
	const detail = usage.cache_creation as Record<string, unknown> | undefined;
	const oneHour = num(detail?.ephemeral_1h_input_tokens);
	const fiveMin = num(detail?.ephemeral_5m_input_tokens);

	if (oneHour + fiveMin === 0) {
		return { cache_creation_input_tokens: total };
	}

	const remainder = Math.max(0, total - oneHour - fiveMin);
	return {
		input_cache_creation_1h: oneHour,
		input_cache_creation_5m: fiveMin,
		...(remainder > 0 ? { cache_creation_input_tokens: remainder } : {}),
	};
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

/**
 * A parsed transcript: the raw records plus the three indexes every emit step
 * needs. Session transcripts and subagent transcripts share this shape, so both
 * go through one parser rather than two that can drift apart.
 */
interface ParsedTranscript {
	toolResults: Map<string, string>;
	toolResultTimes: Map<string, Date>;
	turns: Map<string, AssistantTurn>;
	compactBoundaries: TranscriptRecord[];
	/** Timestamp of the first record that has one — when the transcript begins. */
	firstTimestamp?: Date;
}

/** Read a JSONL transcript, skipping partial/corrupt lines. */
function readRecords(path: string): TranscriptRecord[] {
	const raw = readFileSync(path, "utf8");
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
	return records;
}

/**
 * Parse a transcript into turns + tool-result indexes.
 *
 * Assistant turns are aggregated by `message.id` (see the module docblock: one
 * message spans several records that each repeat the full usage, so keying on
 * the record `uuid` would multiply the turn's cost by its block count).
 */
function parseTranscript(path: string): ParsedTranscript {
	const records = readRecords(path);

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

	const turns = new Map<string, AssistantTurn>();
	const compactBoundaries: TranscriptRecord[] = [];
	let lastUserText = "";
	// Timestamp of the previously-seen record (of any type). A turn's request
	// begins when the record that triggered it — the user prompt or the prior
	// tool_result — was written, so we stamp `startTime` from this rather than
	// from the assistant record itself (which marks when the response landed).
	let prevTimestamp: Date | undefined;

	for (const rec of records) {
		const ts = toDate(rec.timestamp);
		if (rec.type === "system" && rec.subtype === "compact_boundary") {
			compactBoundaries.push(rec);
			prevTimestamp = ts ?? prevTimestamp;
			continue;
		}
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

	return {
		toolResults,
		toolResultTimes,
		turns,
		compactBoundaries,
		firstTimestamp: toDate(records.find((r) => r.timestamp)?.timestamp),
	};
}

/** One subagent transcript belonging to a session. */
export interface SubagentTranscript {
	agentId: string;
	path: string;
}

/**
 * Locate the subagent transcripts for a session.
 *
 * Claude Code writes them beside the session transcript, in a directory named
 * after the session id:
 *   <dir>/<sessionId>.jsonl            <- the session transcript we were handed
 *   <dir>/<sessionId>/subagents/agent-<agentId>.jsonl
 *
 * Returns `[]` for the overwhelmingly common case of a session that never
 * delegated (no directory), and never throws — telemetry must not be able to
 * break a session's teardown.
 */
export function findSubagentTranscripts(
	transcriptPath: string,
): SubagentTranscript[] {
	try {
		const dir = join(
			dirname(transcriptPath),
			basename(transcriptPath, ".jsonl"),
			"subagents",
		);
		if (!existsSync(dir)) return [];
		return readdirSync(dir)
			.filter((f) => f.startsWith("agent-") && f.endsWith(".jsonl"))
			.map((f) => ({
				agentId: f.slice("agent-".length, -".jsonl".length),
				path: join(dir, f),
			}));
	} catch {
		return [];
	}
}

/**
 * Recover which `Agent` tool call spawned which subagent.
 *
 * There are two spawn modes and they leave different evidence:
 *
 *  - **async** — the tool result is a launch receipt that names the agent
 *    (`agentId: a379cd62836b5edec`), which is also the transcript filename. That
 *    is an exact link, so prefer it.
 *  - **sync** — the tool result is the subagent's finished report. It carries no
 *    id at all, so there is nothing to match on. This is the common case, and an
 *    id-only implementation silently leaves these subagents unparented.
 *
 * For the sync case fall back to time: a subagent runs strictly inside its Agent
 * call's window (between the `tool_use` and its `tool_result`), so a subagent
 * whose transcript opens inside exactly one unclaimed window belongs to it.
 * Ambiguity is left unlinked rather than guessed — a wrong parent is worse than
 * none, and an unparented subagent still reports its full cost at the trace root.
 *
 * Returns agentId -> spawning tool_use id.
 */
function linkSubagentsToAgentCalls(
	turns: Map<string, AssistantTurn>,
	toolResults: Map<string, string>,
	toolResultTimes: Map<string, Date>,
	subagents: { agentId: string; firstTimestamp?: Date }[],
): Map<string, string> {
	const byAgentId = new Map<string, string>();
	const claimed = new Set<string>();
	const calls: { toolUseId: string; start?: Date; end?: Date }[] = [];

	for (const turn of turns.values()) {
		for (const block of turn.toolUses) {
			if (block.name !== "Agent" || !block.id) continue;
			calls.push({
				toolUseId: block.id,
				// Open the window at the *start* of the turn that issued the call,
				// not when its record was flushed: the subagent's transcript is
				// opened as the call is dispatched, which lands a second or so
				// before the parent's assistant record is written. Using the
				// flush time excludes the very subagent the window is meant to
				// catch. The tool_result closes the window.
				start: turn.startTime ?? turn.endTime,
				end: toolResultTimes.get(block.id),
			});
			const match = /agentId:\s*([A-Za-z0-9_-]+)/.exec(
				toolResults.get(block.id) ?? "",
			);
			if (match?.[1]) {
				byAgentId.set(match[1], block.id);
				claimed.add(block.id);
			}
		}
	}

	for (const { agentId, firstTimestamp } of subagents) {
		if (byAgentId.has(agentId) || !firstTimestamp) continue;
		const t = firstTimestamp.getTime();
		const candidates = calls.filter(
			(c) =>
				!claimed.has(c.toolUseId) &&
				c.start !== undefined &&
				t >= c.start.getTime() &&
				// A missing tool_result means the call never returned — the session
				// was interrupted or ended while the subagent was still running.
				// The window is open-ended rather than empty; treating it as empty
				// would drop the link for exactly the sessions that were cut short.
				(c.end === undefined || t <= c.end.getTime()),
		);
		// Exactly one unclaimed Agent call was running when this subagent began.
		if (candidates.length === 1) {
			const only = candidates[0] as { toolUseId: string };
			byAgentId.set(agentId, only.toolUseId);
			claimed.add(only.toolUseId);
		}
	}

	return byAgentId;
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
/**
 * Observations are emitted through the **root** client with an explicit
 * `traceId`, not through the trace client returned by `trace()`.
 *
 * This is not a style preference. `LangfuseObjectClient.generation/span/event`
 * (which the trace client inherits) ends with:
 *
 *     parentObservationId: this.observationId
 *
 * — it *overwrites* whatever `parentObservationId` the caller passed, and on a
 * trace client `this.observationId` is `null`. Routing a subagent's turns
 * through `trace.generation(...)` would therefore silently discard their parent
 * link and flatten them to the trace root. The root `client.generation(...)`
 * spreads the body through untouched, so it is the only way to nest.
 */
export interface LangfuseLike {
	trace(body: Record<string, unknown>): unknown;
	generation(body: Record<string, unknown>): unknown;
	span(body: Record<string, unknown>): unknown;
	event(body: Record<string, unknown>): unknown;
	on?(
		event: "error" | "warning",
		listener: (error: unknown) => void,
	): () => void;
	flushAsync(): Promise<unknown>;
	shutdownAsync?(): Promise<unknown>;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
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
	/** Assistant turns on the main thread. */
	generations: number;
	/** Tool calls made by the main thread. */
	toolSpans: number;
	/** Context compactions the session went through. */
	compactions: number;
	/** Subagent transcripts found for this session (0 when it never delegated). */
	subagents: number;
	/** Assistant turns made *inside* subagents — invisible to the main transcript. */
	subagentGenerations: number;
	/** Tool calls made inside subagents. */
	subagentToolSpans: number;
}

/** How many observations one transcript contributed. */
interface EmitCounts {
	generations: number;
	toolSpans: number;
}

/**
 * Emit one generation per assistant turn, plus one child span per tool call.
 *
 * Shared by the main thread and by each subagent. `parentObservationId` nests a
 * subagent's turns under the `Agent` tool span that spawned it; it is omitted
 * for the main thread (whose turns hang off the trace root).
 */
function emitTurns(args: {
	client: LangfuseLike;
	traceId: string;
	parsed: ParsedTranscript;
	turnName: string;
	parentObservationId?: string;
	metadata?: Record<string, unknown>;
}): EmitCounts {
	const { client, traceId, parsed, turnName, parentObservationId, metadata } =
		args;
	const { turns, toolResults, toolResultTimes } = parsed;
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

		client.generation({
			id: `gen-${turn.id}`,
			traceId,
			name: turnName,
			model: turn.model,
			input: turn.inputText || undefined,
			output: turn.outputParts.join("\n") || undefined,
			...(parentObservationId ? { parentObservationId } : {}),
			// Break the input down by cache tier so Langfuse prices cache reads
			// and writes at their own rates instead of charging every input token
			// at the full uncached rate. Cache writes are further split by TTL —
			// a 1-hour write costs 2x base, not the 1.25x the flat key implies.
			// Langfuse derives `total`.
			usageDetails: {
				input: freshInput,
				cache_read_input_tokens: cacheRead,
				...cacheCreationUsage(usage),
				output: outputTokens,
			},
			startTime,
			endTime,
			metadata: {
				stopReason: turn.stopReason,
				rawUsage: usage,
				totalInputTokens: inputTokens,
				...metadata,
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
			client.span({
				id: `tool-${block.id ?? `${turn.id}-${toolSpans}`}`,
				traceId,
				name: `tool:${block.name ?? "unknown"}`,
				input: block.input,
				output: block.id ? toolResults.get(block.id) : undefined,
				...(parentObservationId ? { parentObservationId } : {}),
				startTime: toolStart,
				endTime: toolEnd,
			});
			toolSpans++;
		}
	}

	return { generations, toolSpans };
}

/**
 * Parse a Claude Code session transcript — plus any subagent transcripts it
 * spawned — and emit a single Langfuse trace. Never throws for malformed
 * transcript lines; bad lines are skipped. IO/network failures propagate so the
 * caller can log them.
 */
export async function exportTranscriptToLangfuse(
	options: ExportOptions,
): Promise<ExportResult> {
	const { transcriptPath, sessionId, config, metadata } = options;

	const parsed = parseTranscript(transcriptPath);

	const client = await (options.clientFactory
		? options.clientFactory(config)
		: defaultClientFactory(config));
	let ingestionFailure: unknown;
	const recordIngestionFailure = (error: unknown): void => {
		ingestionFailure ??= error;
	};
	const removeErrorListener = client.on?.("error", recordIngestionFailure);
	const removeWarningListener = client.on?.("warning", recordIngestionFailure);

	const version = resolveTraceVersion();
	const traceId = `cyrus-${sessionId}`;
	client.trace({
		id: traceId,
		name: options.traceName || `cyrus-session-${sessionId.slice(0, 8)}`,
		sessionId,
		timestamp: parsed.firstTimestamp,
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

	// A compaction is the one event that explains a sudden drop in a turn's
	// input tokens; without it the trace looks like the conversation simply
	// shrank. Deterministic id keeps a re-export idempotent.
	for (const rec of parsed.compactBoundaries) {
		const meta = rec.compactMetadata ?? {};
		client.event({
			id: `compact-${rec.uuid}`,
			traceId,
			name: "compact_boundary",
			startTime: toDate(rec.timestamp),
			metadata: {
				trigger: meta.trigger,
				preTokens: meta.preTokens,
				postTokens: meta.postTokens,
				durationMs: meta.durationMs,
				cumulativeDroppedTokens: meta.cumulativeDroppedTokens,
			},
		});
	}

	const main = emitTurns({
		client,
		traceId,
		parsed,
		turnName: "assistant-turn",
	});

	// Subagent turns live in their own files and carry their own usage; without
	// this pass a delegating session's cost is silently under-reported. Parse
	// them before emitting: linking a sync-spawned subagent to its Agent call
	// needs to know when its transcript begins.
	const subagentTranscripts = findSubagentTranscripts(transcriptPath).map(
		(s) => ({ ...s, parsed: parseTranscript(s.path) }),
	);
	const agentIdToToolUse = linkSubagentsToAgentCalls(
		parsed.turns,
		parsed.toolResults,
		parsed.toolResultTimes,
		subagentTranscripts.map((s) => ({
			agentId: s.agentId,
			firstTimestamp: s.parsed.firstTimestamp,
		})),
	);

	let subagentGenerations = 0;
	let subagentToolSpans = 0;

	for (const { agentId, parsed: subParsed } of subagentTranscripts) {
		const spawningToolUseId = agentIdToToolUse.get(agentId);
		const counts = emitTurns({
			client,
			traceId,
			parsed: subParsed,
			turnName: "subagent-turn",
			// Hang the subagent's work under the Agent tool call that spawned it.
			// Unlinkable subagents still export — they just sit at the trace root.
			parentObservationId: spawningToolUseId
				? `tool-${spawningToolUseId}`
				: undefined,
			metadata: { subagent: true, agentId },
		});
		subagentGenerations += counts.generations;
		subagentToolSpans += counts.toolSpans;
	}

	try {
		await client.flushAsync();
		if (client.shutdownAsync) await client.shutdownAsync();
	} finally {
		removeErrorListener?.();
		removeWarningListener?.();
	}
	if (ingestionFailure !== undefined) {
		throw new Error(
			`Langfuse ingestion failed: ${errorMessage(ingestionFailure)}`,
		);
	}

	const compactions = parsed.compactBoundaries.length;
	options.logger?.debug?.(
		`Langfuse export complete: ${main.generations} generations, ` +
			`${main.toolSpans} tool spans, ${compactions} compactions, ` +
			`${subagentTranscripts.length} subagents ` +
			`(${subagentGenerations} generations, ${subagentToolSpans} tool spans)`,
	);
	return {
		generations: main.generations,
		toolSpans: main.toolSpans,
		compactions,
		subagents: subagentTranscripts.length,
		subagentGenerations,
		subagentToolSpans,
	};
}
