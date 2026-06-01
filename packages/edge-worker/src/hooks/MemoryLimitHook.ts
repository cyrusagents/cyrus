import { existsSync } from "node:fs";
import type {
	HookCallbackMatcher,
	HookEvent,
	HookJSONOutput,
	PostToolUseHookInput,
	PreToolUseHookInput,
} from "cyrus-claude-runner";
import { getCyrusAppUrl } from "cyrus-cloudflare-tunnel-client";
import type { ILogger } from "cyrus-core";

/**
 * Absolute path to the cgroup v2 wrapper installed by the cloud droplet image
 * (cyrus-images Section A). When present, it runs an inner command inside an
 * ephemeral cgroup with a `memory.max` budget and prints {@link OOM_MARKER} to
 * stderr on OOM. Its *existence* is the deploy-order-independence guard: if the
 * env gate is on but the image predates the wrapper, the PreToolUse hook stays
 * a no-op (otherwise every Bash call would fail with `127: command not found`).
 */
export const CYRUS_TOOL_EXEC_PATH = "/usr/local/bin/cyrus-tool-exec";

/**
 * The exact stderr prefix `cyrus-tool-exec` prints when the inner command is
 * OOM-killed. Must stay byte-for-byte in sync with the wrapper in cyrus-images.
 * Full line: `[cyrus-runtime] command killed: exceeded <cap>M memory budget
 * (peak <bytes> bytes).`
 */
export const OOM_MARKER = "[cyrus-runtime] command killed:";

/**
 * POSIX single-quote a string so it survives intact as one shell word: wrap in
 * `'…'`, and replace every embedded `'` with the four-char sequence `'\''`
 * (close-quote, escaped-quote, reopen-quote). This is safe for arbitrary
 * content — backticks, `$(...)`, double quotes, newlines, heredoc bodies — none
 * are interpreted inside single quotes.
 */
export function singleQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Regex matching the wrapper prefix the PreToolUse hook injects. */
const WRAPPER_PREFIX_RE = /^CYRUS_TOOL_MEMORY_MAX_MB=\d+\s+cyrus-tool-exec\s+/;

/**
 * Reverse {@link singleQuote}: if `value` is a single fully single-quoted shell
 * word, strip the wrapping quotes and undo the `'\''` escaping. Returns the
 * input unchanged when it isn't a single-quoted word.
 */
function unSingleQuote(value: string): string {
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1).replace(/'\\''/g, "'");
	}
	return value;
}

/**
 * Build a short, secret-light excerpt of the original command for the OOM
 * telemetry. If the command still carries the wrapper prefix the PreToolUse
 * hook injected, unwrap it back to the user's original command first, then
 * truncate. The server also truncates to ≤200 chars; we keep it short here too.
 */
export function buildCommandExcerpt(command: string, max = 200): string {
	let original = command;
	if (WRAPPER_PREFIX_RE.test(original)) {
		original = unSingleQuote(original.replace(WRAPPER_PREFIX_RE, ""));
	}
	return original.slice(0, max);
}

/** Parsed numbers from an {@link OOM_MARKER} line; fields are best-effort. */
export interface ParsedOomMarker {
	budgetMb?: number;
	peakBytes?: number;
}

/**
 * Extract the memory budget (`exceeded <cap>M`) and peak usage
 * (`peak <bytes> bytes`) from a result containing the OOM marker. Either field
 * is omitted if the corresponding token isn't found.
 */
export function parseOomMarker(text: string): ParsedOomMarker {
	const capMatch = text.match(/exceeded\s+(\d+)M/);
	const peakMatch = text.match(/peak\s+(\d+)\s+bytes/);
	const result: ParsedOomMarker = {};
	if (capMatch) {
		result.budgetMb = Number(capMatch[1]);
	}
	if (peakMatch) {
		result.peakBytes = Number(peakMatch[1]);
	}
	return result;
}

/**
 * Collapse a Bash `tool_response` (string, or `{ stdout, stderr, ... }`-shaped
 * object) into a single searchable string. Falls back to JSON for unexpected
 * shapes so the marker substring check still works.
 */
export function extractResultText(toolResponse: unknown): string {
	if (typeof toolResponse === "string") {
		return toolResponse;
	}
	if (toolResponse && typeof toolResponse === "object") {
		const parts: string[] = [];
		for (const value of Object.values(
			toolResponse as Record<string, unknown>,
		)) {
			if (typeof value === "string") {
				parts.push(value);
			}
		}
		if (parts.length > 0) {
			return parts.join("\n");
		}
		try {
			return JSON.stringify(toolResponse);
		} catch {
			return "";
		}
	}
	return "";
}

/** Injectable dependencies for {@link buildMemoryLimitHook} (for testing). */
export interface MemoryLimitHookDeps {
	/** Reads an environment variable. Defaults to `process.env`. */
	getEnv?: (name: string) => string | undefined;
	/** Returns true when the cgroup wrapper binary exists. Defaults to `fs`. */
	wrapperExists?: () => boolean;
}

/**
 * Build the PreToolUse hook that, on cloud droplets, transparently wraps every
 * Bash command in `cyrus-tool-exec` so it runs under a per-command cgroup v2
 * memory budget.
 *
 * The hook is a **strict no-op** (input unchanged) unless ALL of:
 *   - `CYRUS_RUNTIME === "cloud"` (explicit cloud gate — replaces any probe),
 *   - `CYRUS_TOOL_MEMORY_MAX_MB` is set (the per-tier budget), and
 *   - the wrapper binary exists on disk (deploy-order-independence guard).
 *
 * When it does fire, it rewrites the command to:
 *   `CYRUS_TOOL_MEMORY_MAX_MB=<cap> cyrus-tool-exec '<original>'`
 * The cap is injected **inline** (env prefix) so the budget reaches the wrapper
 * even if the SDK doesn't propagate env to the tool subprocess. The original is
 * single-quoted so arbitrary shell content survives untouched.
 *
 * The whole body is wrapped in try/catch and fails open — a broken hook must
 * never block Claude from running a command.
 */
export function buildMemoryLimitHook(
	log: ILogger,
	deps: MemoryLimitHookDeps = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
	const wrapperExists =
		deps.wrapperExists ?? (() => existsSync(CYRUS_TOOL_EXEC_PATH));

	return {
		PreToolUse: [
			{
				matcher: "Bash",
				hooks: [
					async (input): Promise<HookJSONOutput> => {
						try {
							const pre = input as PreToolUseHookInput;

							// Gates — any failure means leave the command untouched.
							const cap = getEnv("CYRUS_TOOL_MEMORY_MAX_MB");
							if (
								getEnv("CYRUS_RUNTIME") !== "cloud" ||
								!cap ||
								!wrapperExists()
							) {
								return { continue: true };
							}

							const toolInput = pre.tool_input as
								| { command?: unknown }
								| undefined;
							const command = toolInput?.command;
							if (typeof command !== "string" || command.length === 0) {
								return { continue: true };
							}

							const rewritten = `CYRUS_TOOL_MEMORY_MAX_MB=${cap} cyrus-tool-exec ${singleQuote(
								command,
							)}`;

							return {
								continue: true,
								hookSpecificOutput: {
									hookEventName: "PreToolUse",
									permissionDecision: "allow",
									updatedInput: {
										...(toolInput as Record<string, unknown>),
										command: rewritten,
									},
								},
							};
						} catch (err) {
							log.debug(
								`[MemoryLimitHook] failing open: ${(err as Error).message}`,
							);
							return { continue: true };
						}
					},
				],
			},
		],
	};
}

/** Injectable dependencies for {@link buildOomReportHook} (for testing). */
export interface OomReportHookDeps {
	/** Reads an environment variable. Defaults to `process.env`. */
	getEnv?: (name: string) => string | undefined;
	/** Resolves the cyrus-hosted control-plane base URL. Defaults to `getCyrusAppUrl`. */
	getBaseUrl?: () => string;
	/** Fetch implementation. Defaults to `globalThis.fetch`. */
	fetchImpl?: typeof fetch;
	/** Network timeout in ms. Defaults to 5s — OOM is rare, so a short await is fine. */
	timeoutMs?: number;
}

/**
 * Build the PostToolUse hook that reports per-command OOM kills back to the
 * cyrus-hosted control plane.
 *
 * It inspects the Bash result for {@link OOM_MARKER}; on a match it parses the
 * budget and peak usage and `POST`s them (plus a short, secret-light command
 * excerpt) to `<cyrus-app-url>/api/oom-event`, authenticated with the droplet's
 * `CYRUS_API_KEY` bearer — the same control-plane callback path that
 * failure-mode reporting already uses. No marker, or no `CYRUS_API_KEY`, is a
 * silent no-op. Every failure mode is swallowed: telemetry must never block or
 * fail a tool result.
 */
export function buildOomReportHook(
	log: ILogger,
	deps: OomReportHookDeps = {},
): Partial<Record<HookEvent, HookCallbackMatcher[]>> {
	const getEnv = deps.getEnv ?? ((name: string) => process.env[name]);
	const getBaseUrl = deps.getBaseUrl ?? getCyrusAppUrl;
	const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
	const timeoutMs = deps.timeoutMs ?? 5_000;

	return {
		PostToolUse: [
			{
				matcher: "Bash",
				hooks: [
					async (input): Promise<HookJSONOutput> => {
						try {
							const post = input as PostToolUseHookInput;
							const text = extractResultText(post.tool_response);
							if (!text.includes(OOM_MARKER)) {
								return {};
							}

							const apiKey = getEnv("CYRUS_API_KEY")?.trim();
							if (!apiKey) {
								return {};
							}

							const { budgetMb, peakBytes } = parseOomMarker(text);
							const command =
								(post.tool_input as { command?: unknown } | undefined)
									?.command ?? "";
							const commandExcerpt = buildCommandExcerpt(
								typeof command === "string" ? command : "",
							);

							const url = `${getBaseUrl().replace(/\/+$/, "")}/api/oom-event`;
							const controller = new AbortController();
							const timer = setTimeout(() => controller.abort(), timeoutMs);
							try {
								const res = await fetchImpl(url, {
									method: "POST",
									headers: {
										Authorization: `Bearer ${apiKey}`,
										"Content-Type": "application/json",
									},
									body: JSON.stringify({
										budgetMb,
										peakBytes,
										commandExcerpt,
									}),
									signal: controller.signal,
								});
								if (!res.ok) {
									log.debug(
										`[OomReportHook] /api/oom-event returned ${res.status}`,
									);
								} else {
									log.info(
										`[OomReportHook] reported OOM (budget=${budgetMb}M peak=${peakBytes}B)`,
									);
								}
							} finally {
								clearTimeout(timer);
							}
						} catch (err) {
							log.debug(
								`[OomReportHook] failing open: ${(err as Error).message}`,
							);
						}
						return {};
					},
				],
			},
		],
	};
}
