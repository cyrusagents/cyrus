import { stripVTControlCharacters } from "node:util";

/** Bounded, selected tool inputs for Jira. Never serialize arbitrary arguments or output. */
export const MAX_TOOL_DETAIL_BYTES = 2048;
const MAX_SOURCE_LENGTH = 16 * 1024;
const SENSITIVE_KEY =
	/token|secret|password|passwd|api.?key|credential|authorization|cookie|private.?key/i;

/**
 * Redact known credential values and common credential syntax before truncation.
 * This is display redaction, not a claim to identify arbitrary secrets in prose.
 * Oversized source fields and private-key material are withheld altogether.
 */
export function redactToolDetail(source: string): string {
	if (source.length > MAX_SOURCE_LENGTH) return "[Detail omitted: too long]";
	let text = Array.from(stripVTControlCharacters(source))
		.filter((ch) => {
			const cp = ch.codePointAt(0)!;
			return ch === "\n" || ch === "\t" || (cp >= 32 && cp !== 127);
		})
		.join("");
	if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text))
		return "[Credential material omitted]";
	// Shell payloads can contain whole files or request bodies. Do not attempt
	// to parse shell/JSON quoting in order to publish a partially redacted body.
	if (/<<|(?:^|\s)(?:--data(?:-[a-z]+)?|--json|-d)(?:\s|=|["'])/i.test(text))
		return "[Command payload omitted]";
	if (
		Array.from(
			text.matchAll(/["'\\]*([A-Za-z_][A-Za-z0-9_-]*)["'\\]*\s*:/g),
		).some((match) => SENSITIVE_KEY.test(match[1]!)) ||
		/(?:^|\s)(?:--?(?:password|passwd|token|api[_-]?key|secret|authorization|cookie|user|header)|-[Hu])(?:\s|=|["']|(?<=-[Hu])\S)/i.test(
			text,
		)
	)
		return "[Credential-bearing detail omitted]";
	for (const [key, value] of Object.entries(process.env)) {
		if (SENSITIVE_KEY.test(key) && value && value.length >= 4) {
			for (const form of new Set([
				value,
				encodeURIComponent(value),
				JSON.stringify(value).slice(1, -1),
			]))
				text = text.split(form).join("[REDACTED]");
		}
	}
	text = text
		.replace(
			/\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi,
			"[REDACTED authentication]",
		)
		.replace(
			/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g,
			"[REDACTED]",
		)
		// All shell assignment values are private; variable names remain useful.
		.replace(
			/\b([A-Za-z_][A-Za-z0-9_]*)=(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/g,
			"$1=[REDACTED]",
		)
		.replace(
			/((?:--?(?:password|passwd|token|api-key|secret|authorization|cookie|user)|-u|-H|--header)\s+)(?:"(?:\\.|[^"\\])*"|'[^']*'|[^\s;|&]+)/gi,
			"$1[REDACTED]",
		)
		.replace(/https?:\/\/[^\s<>"'`]+/gi, (url) => {
			try {
				const parsed = new URL(url);
				parsed.username = "";
				parsed.password = "";
				// Signed URLs and opaque query values are not needed to identify a page.
				return `${parsed.origin}${parsed.pathname}${parsed.search ? "?[REDACTED]" : ""}${parsed.hash ? "#[REDACTED]" : ""}`;
			} catch {
				return "[URL omitted]";
			}
		});
	let out = "";
	let bytes = 0;
	for (const ch of text.trim()) {
		const size = Buffer.byteLength(ch);
		if (bytes + size > MAX_TOOL_DETAIL_BYTES - 3) return `${out}…`;
		out += ch;
		bytes += size;
	}
	return out;
}

/** Match the useful fields Linear displays, without its arbitrary-JSON fallback. */
export function toolDetail(name: unknown, input: unknown): string | undefined {
	if (typeof name !== "string" || !input || typeof input !== "object") return;
	const data = input as Record<string, unknown>;
	let value: unknown;
	// Codex also projects shell commands as Read/Grep/Glob/Write.
	if (
		["Bash", "Read", "Write", "Edit", "MultiEdit", "Grep", "Glob"].includes(
			name,
		) &&
		typeof data.command === "string"
	) {
		value = data.command;
	} else if (
		["Read", "Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)
	) {
		value = data.file_path ?? data.notebook_path;
	} else if (name === "Grep" || name === "Glob") {
		value =
			typeof data.pattern === "string"
				? `${data.pattern}${typeof data.path === "string" ? ` in ${data.path}` : ""}`
				: undefined;
	} else if (name === "WebSearch") {
		value = data.query;
	} else if (name === "WebFetch") {
		value = data.url;
	} else if (name === "Task" || name === "Agent") {
		value = data.description;
	}
	return typeof value === "string"
		? redactToolDetail(value) || undefined
		: undefined;
}
