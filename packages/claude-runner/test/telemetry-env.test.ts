import { describe, expect, it } from "vitest";
import { buildLangfuseTelemetryEnv } from "../src/telemetry-env";

const PK = "pk-lf-1234";
const SK = "sk-lf-5678";
const EXPECTED_AUTH = Buffer.from(`${PK}:${SK}`).toString("base64");

describe("buildLangfuseTelemetryEnv", () => {
	it("returns an empty object when no Langfuse keys are set", () => {
		expect(buildLangfuseTelemetryEnv({})).toEqual({});
	});

	it("returns an empty object when only the public key is set", () => {
		expect(buildLangfuseTelemetryEnv({ LANGFUSE_PUBLIC_KEY: PK })).toEqual({});
	});

	it("returns an empty object when only the secret key is set", () => {
		expect(buildLangfuseTelemetryEnv({ LANGFUSE_SECRET_KEY: SK })).toEqual({});
	});

	it("enables OTLP export with a Basic auth header when both keys are set", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
		});

		expect(env).toEqual({
			CLAUDE_CODE_ENABLE_TELEMETRY: "1",
			OTEL_TRACES_EXPORTER: "otlp",
			OTEL_METRICS_EXPORTER: "otlp",
			OTEL_LOGS_EXPORTER: "otlp",
			OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
			OTEL_EXPORTER_OTLP_ENDPOINT: "https://cloud.langfuse.com/api/public/otel",
			OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Basic ${EXPECTED_AUTH}`,
		});
	});

	it("defaults to Langfuse Cloud when no host is provided", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
		});
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
			"https://cloud.langfuse.com/api/public/otel",
		);
	});

	it("honors a custom host and appends the OTLP path", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_HOST: "https://us.cloud.langfuse.com",
		});
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
			"https://us.cloud.langfuse.com/api/public/otel",
		);
	});

	it("strips a trailing slash from the host before appending the OTLP path", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_HOST: "https://langfuse.internal.example.com/",
		});
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
			"https://langfuse.internal.example.com/api/public/otel",
		);
	});

	it("does not double the OTLP path when the host already includes it", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			LANGFUSE_HOST: "https://cloud.langfuse.com/api/public/otel",
		});
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
			"https://cloud.langfuse.com/api/public/otel",
		);
	});

	it("trims whitespace around keys and host", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: `  ${PK}  `,
			LANGFUSE_SECRET_KEY: `  ${SK}  `,
			LANGFUSE_HOST: "  https://cloud.langfuse.com  ",
		});
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
			`Authorization=Basic ${EXPECTED_AUTH}`,
		);
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
			"https://cloud.langfuse.com/api/public/otel",
		);
	});

	it("stays off when CYRUS_TELEMETRY_DISABLED is truthy even with keys set", () => {
		for (const flag of ["1", "true", "yes", "on", "TRUE"]) {
			expect(
				buildLangfuseTelemetryEnv({
					LANGFUSE_PUBLIC_KEY: PK,
					LANGFUSE_SECRET_KEY: SK,
					CYRUS_TELEMETRY_DISABLED: flag,
				}),
			).toEqual({});
		}
	});

	it("ignores a falsey CYRUS_TELEMETRY_DISABLED value", () => {
		const env = buildLangfuseTelemetryEnv({
			LANGFUSE_PUBLIC_KEY: PK,
			LANGFUSE_SECRET_KEY: SK,
			CYRUS_TELEMETRY_DISABLED: "0",
		});
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
	});
});
