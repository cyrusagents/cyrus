import {
	type ErrorReporter,
	NoopErrorReporter,
	setGlobalErrorTags,
} from "cyrus-core";
import { SentryErrorReporter } from "./SentryErrorReporter.js";
import { scrubSentryEvent, scrubSentryLog } from "./sentryScrubber.js";

/**
 * Default DSN baked into release builds. Empty until an admin creates the
 * `ceedar/cyrus-cli` Sentry project and pastes the DSN here. Sentry DSNs are
 * safe to publish — they only authorise event ingestion.
 *
 * End users may override this with the `CYRUS_SENTRY_DSN` env var, or disable
 * reporting entirely with `CYRUS_SENTRY_DISABLED=1`.
 */
export const DEFAULT_SENTRY_DSN =
	"https://4a343e39f7439cb5669604657fca148e@o4509685010399232.ingest.us.sentry.io/4511293576839168";

export interface CreateErrorReporterParams {
	release?: string;
	/**
	 * Reads default to `process.env`. Injected for tests.
	 */
	env?: NodeJS.ProcessEnv;
}

/**
 * Build the application's {@link ErrorReporter}.
 *
 * Order of resolution:
 *   1. If `CYRUS_SENTRY_DISABLED` is truthy → noop.
 *   2. If `CYRUS_TEAM_ID` is unset → noop. Both Issues and Logs require a
 *      tenant tag so we can slice/filter per Cyrus install in Sentry; without
 *      it we send nothing rather than emit untenanted noise.
 *   3. Else if a DSN is available (env var or compiled default) → Sentry.
 *   4. Else → noop.
 *
 * Initialise this as early as possible during process startup so that
 * exceptions thrown by subsequent imports/bootstrap are captured.
 */
export function createErrorReporter(
	params: CreateErrorReporterParams = {},
): ErrorReporter {
	const env = params.env ?? process.env;

	if (isTruthyEnv(env.CYRUS_SENTRY_DISABLED)) {
		return new NoopErrorReporter();
	}

	const tags = buildInitialTags(env);
	// CYRUS_TEAM_ID is the single gate for *both* Issues and Logs — installs
	// without tenant tagging stay silent so the team's Sentry org isn't
	// flooded with untenanted self-hosted noise we can't slice.
	if (!tags?.team_id) {
		return new NoopErrorReporter();
	}

	const dsn = env.CYRUS_SENTRY_DSN?.trim() || DEFAULT_SENTRY_DSN;
	if (!dsn) {
		return new NoopErrorReporter();
	}

	// Mirror the tag set into the process-wide registry so Logger.error
	// forwarding (which builds its own per-event tag map) includes them too,
	// not just events emitted directly via the Sentry SDK's initialScope.
	setGlobalErrorTags(tags);

	const environment = env.CYRUS_SENTRY_ENVIRONMENT?.trim() || "production";

	return new SentryErrorReporter({
		dsn,
		release: params.release,
		environment,
		// Sentry SDK debug output is unrelated to app log level — gating it on
		// CYRUS_LOG_LEVEL=DEBUG floods stdout with OpenTelemetry tracing
		// inheritance / client-report flush messages that belong to the SDK,
		// not Cyrus. Use a dedicated opt-in env var.
		debug: isTruthyEnv(env.CYRUS_SENTRY_DEBUG),
		tags,
		structuredContext: buildStructuredContext({
			env,
			environment,
			release: params.release,
			tags,
		}),
		sampleRate: parseSampleRate(env.CYRUS_SENTRY_SAMPLE_RATE),
		// Always scrub. Cyrus' logger.error sites pass arbitrary args (request
		// bodies, configs, headers) that may carry tokens; we cannot trust call
		// sites to redact, so we filter on the way out.
		beforeSend: scrubSentryEvent,
		// Logs use a separate ingestion path from Issues — `beforeSend` does
		// not run on them, so we register a dedicated hook with the same scrub
		// rules to keep both paths symmetric.
		beforeSendLog: scrubSentryLog,
	});
}

/**
 * Build the structured `cyrus` context block attached to every event. This is
 * the structured-logging counterpart to {@link buildInitialTags}: tags get
 * the indexed/searchable subset (team_id), the context block carries the
 * richer typed fields that show up grouped in the Sentry UI.
 */
function buildStructuredContext(input: {
	env: NodeJS.ProcessEnv;
	environment: string;
	release: string | undefined;
	tags: Record<string, string> | undefined;
}): Record<string, unknown> | undefined {
	const ctx: Record<string, unknown> = {
		environment: input.environment,
	};
	if (input.release) ctx.release = input.release;
	if (input.tags?.team_id) ctx.team_id = input.tags.team_id;
	const linearWorkspace = input.env.CYRUS_LINEAR_WORKSPACE?.trim();
	if (linearWorkspace) ctx.linear_workspace = linearWorkspace;
	const deployment = input.env.CYRUS_DEPLOYMENT_ID?.trim();
	if (deployment) ctx.deployment_id = deployment;
	return Object.keys(ctx).length > 1 || ctx.team_id ? ctx : undefined;
}

/**
 * Parse a sample rate from env. Returns undefined for malformed/empty values
 * so the SentryErrorReporter default (1.0) applies.
 */
function parseSampleRate(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number.parseFloat(value);
	if (!Number.isFinite(n) || n < 0 || n > 1) return undefined;
	return n;
}

/**
 * Build the global tag set applied to every Sentry event. Currently picks up
 * `CYRUS_TEAM_ID` and exposes it as the `team_id` tag so events can be
 * filtered per Cyrus tenant in Sentry.
 *
 * Add additional process-wide tags here rather than at capture sites — keeps
 * call sites free of cross-cutting concerns.
 */
function buildInitialTags(
	env: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
	const tags: Record<string, string> = {};
	const teamId = env.CYRUS_TEAM_ID?.trim();
	if (teamId) tags.team_id = teamId;
	return Object.keys(tags).length > 0 ? tags : undefined;
}

function isTruthyEnv(value: string | undefined): boolean {
	if (!value) return false;
	const v = value.trim().toLowerCase();
	return v === "1" || v === "true" || v === "yes" || v === "on";
}
