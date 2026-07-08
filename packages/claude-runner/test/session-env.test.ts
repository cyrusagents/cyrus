import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildBaseSessionEnv } from "../src/session-env";

describe("buildBaseSessionEnv — Langfuse telemetry wiring", () => {
	let originalEnv: NodeJS.ProcessEnv;

	beforeEach(() => {
		originalEnv = { ...process.env };
		delete process.env.LANGFUSE_PUBLIC_KEY;
		delete process.env.LANGFUSE_SECRET_KEY;
		delete process.env.LANGFUSE_HOST;
		delete process.env.CYRUS_TELEMETRY_DISABLED;
	});

	afterEach(() => {
		process.env = originalEnv;
	});

	it("omits telemetry vars when Langfuse keys are absent", () => {
		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBeUndefined();
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBeUndefined();
	});

	it("injects telemetry vars into every session env when keys are present", () => {
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-def";

		const env = buildBaseSessionEnv();
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("1");
		expect(env.OTEL_EXPORTER_OTLP_ENDPOINT).toBe(
			"https://cloud.langfuse.com/api/public/otel",
		);
		expect(env.OTEL_EXPORTER_OTLP_HEADERS).toBe(
			`Authorization=Basic ${Buffer.from("pk-lf-abc:sk-lf-def").toString("base64")}`,
		);
	});

	it("lets caller-provided extra env override telemetry defaults", () => {
		process.env.LANGFUSE_PUBLIC_KEY = "pk-lf-abc";
		process.env.LANGFUSE_SECRET_KEY = "sk-lf-def";

		const env = buildBaseSessionEnv({ CLAUDE_CODE_ENABLE_TELEMETRY: "0" });
		expect(env.CLAUDE_CODE_ENABLE_TELEMETRY).toBe("0");
	});
});
