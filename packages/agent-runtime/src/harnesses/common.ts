import type {
	HarnessCommand,
	HarnessKind,
	NormalizedAgentSessionConfig,
	TranscriptEvent,
	TranscriptParseContext,
} from "../types.js";

export function resolveHarnessConfig(config: NormalizedAgentSessionConfig) {
	return config.harness;
}

export function resolveModel(
	config: NormalizedAgentSessionConfig,
): string | undefined {
	return config.model ?? resolveHarnessConfig(config).model;
}

export function resolveCommand(
	config: NormalizedAgentSessionConfig,
	defaultCommand: string,
): string {
	return resolveHarnessConfig(config).command ?? defaultCommand;
}

export function withHarnessArgs(
	config: NormalizedAgentSessionConfig,
	args: string[],
): string[] {
	return [...(resolveHarnessConfig(config).args ?? []), ...args];
}

export function createCommand(
	config: NormalizedAgentSessionConfig,
	defaultCommand: string,
	args: string[],
	options?: {
		env?: Record<string, string | undefined>;
		stdin?: string;
	},
): HarnessCommand {
	return {
		command: resolveCommand(config, defaultCommand),
		args: withHarnessArgs(config, args),
		env: filterEnv(options?.env),
		stdin: options?.stdin,
	};
}

export function parseJsonLine(
	kind: HarnessKind,
	line: string,
	context: TranscriptParseContext,
): TranscriptEvent | undefined {
	const trimmed = line.trim();
	if (!trimmed) {
		return undefined;
	}

	const raw = safeJsonParse(trimmed) ?? trimmed;
	return {
		sessionId: context.sessionId,
		harness: kind,
		timestamp: (context.now?.() ?? new Date()).toISOString(),
		kind: inferEventKind(raw),
		raw,
		normalized: normalizeEvent(raw),
	};
}

function safeJsonParse(value: string): unknown | null {
	try {
		return JSON.parse(value) as unknown;
	} catch {
		return null;
	}
}

function inferEventKind(raw: unknown): string {
	if (typeof raw === "string") {
		return "text";
	}

	if (!isRecord(raw)) {
		return "unknown";
	}

	return stringField(raw, "type") ?? stringField(raw, "event") ?? "json";
}

function normalizeEvent(raw: unknown): unknown {
	if (!isRecord(raw)) {
		return undefined;
	}

	const type = stringField(raw, "type") ?? stringField(raw, "event");
	const text =
		stringField(raw, "text") ??
		stringField(raw, "message") ??
		stringField(raw, "content") ??
		stringField(raw, "result");
	const toolName =
		stringField(raw, "tool_name") ??
		stringField(raw, "toolName") ??
		stringField(raw, "name");

	if (!type && !text && !toolName) {
		return undefined;
	}

	return {
		...(type ? { type } : {}),
		...(text ? { text } : {}),
		...(toolName ? { toolName } : {}),
	};
}

function filterEnv(
	env: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined {
	if (!env) {
		return undefined;
	}
	const filtered = Object.fromEntries(
		Object.entries(env).filter((entry): entry is [string, string] => {
			return entry[1] !== undefined;
		}),
	);
	return Object.keys(filtered).length > 0 ? filtered : undefined;
}

function stringField(
	record: Record<string, unknown>,
	key: string,
): string | undefined {
	const value = record[key];
	return typeof value === "string" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
