/**
 * Langfuse / OpenTelemetry LLMOps wiring for Claude Code sessions.
 *
 * The Claude Agent SDK has OpenTelemetry instrumentation built in: it records
 * spans around each model request and tool execution, emits metrics for token
 * and cost counters, and emits structured log events for prompts and tool
 * results. Setting `CLAUDE_CODE_ENABLE_TELEMETRY=1` plus the standard `OTEL_*`
 * exporter variables in the subprocess environment turns this on and points it
 * at any OTLP backend.
 *
 * Langfuse exposes an OTLP endpoint at `<host>/api/public/otel` and
 * authenticates with an HTTP Basic header built from a project's public/secret
 * key pair. This helper turns a small set of Cyrus-friendly env vars
 * (`LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST`) into the full
 * `OTEL_*` variable set the SDK expects, so operators only have to paste their
 * Langfuse keys into `~/.cyrus/.env`.
 *
 * This mirrors the env-var-driven, auto-enabling pattern used by the Sentry
 * error reporter (`apps/cli/src/services/createErrorReporter.ts`): telemetry
 * turns on automatically when credentials are present and can be forced off
 * with `CYRUS_TELEMETRY_DISABLED`.
 *
 * Reference: https://langfuse.com/integrations/other/claude-code
 */

/** Default Langfuse Cloud host (EU region). */
const DEFAULT_LANGFUSE_HOST = "https://cloud.langfuse.com";

/** Path Langfuse mounts its OTLP receiver on. */
const LANGFUSE_OTEL_PATH = "/api/public/otel";

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Normalize a Langfuse host into an OTLP base endpoint.
 *
 * Accepts either a bare host (`https://cloud.langfuse.com`) or one that already
 * includes the OTLP path, and always returns `<host>/api/public/otel` with no
 * trailing slash. The per-signal exporters append `/v1/traces`, `/v1/metrics`,
 * and `/v1/logs` to this base automatically.
 */
function buildOtlpEndpoint(host: string): string {
	const trimmed = host.trim().replace(/\/+$/, "");
	if (trimmed.endsWith(LANGFUSE_OTEL_PATH)) {
		return trimmed;
	}
	return `${trimmed}${LANGFUSE_OTEL_PATH}`;
}

/**
 * Build the `OTEL_*` environment variables that route the Claude Agent SDK's
 * OpenTelemetry output to Langfuse.
 *
 * Returns an empty object (telemetry stays off) when:
 *   - `CYRUS_TELEMETRY_DISABLED` is truthy, or
 *   - either `LANGFUSE_PUBLIC_KEY` or `LANGFUSE_SECRET_KEY` is missing.
 *
 * When both keys are present it returns the full variable set enabling OTLP
 * traces, metrics, and logs over HTTP/protobuf with a Basic auth header.
 *
 * @param env Environment source, defaults to `process.env`. Injectable for tests.
 */
export function buildLangfuseTelemetryEnv(
	env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
	if (isTruthyEnv(env.CYRUS_TELEMETRY_DISABLED)) {
		return {};
	}

	const publicKey = env.LANGFUSE_PUBLIC_KEY?.trim();
	const secretKey = env.LANGFUSE_SECRET_KEY?.trim();
	if (!publicKey || !secretKey) {
		return {};
	}

	const host = env.LANGFUSE_HOST?.trim() || DEFAULT_LANGFUSE_HOST;
	const endpoint = buildOtlpEndpoint(host);
	const authString = Buffer.from(`${publicKey}:${secretKey}`).toString(
		"base64",
	);

	return {
		CLAUDE_CODE_ENABLE_TELEMETRY: "1",
		OTEL_TRACES_EXPORTER: "otlp",
		OTEL_METRICS_EXPORTER: "otlp",
		OTEL_LOGS_EXPORTER: "otlp",
		// Langfuse supports OTLP over HTTP (JSON or protobuf); gRPC is not
		// supported. protobuf is the SDK's most broadly compatible HTTP encoding.
		OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
		OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
		OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${authString}`,
	};
}
