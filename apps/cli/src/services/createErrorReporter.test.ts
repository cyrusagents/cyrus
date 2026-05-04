import { NoopErrorReporter } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("@sentry/node", () => ({
	init: vi.fn(),
	captureException: vi.fn(),
	captureMessage: vi.fn(),
	flush: vi.fn().mockResolvedValue(true),
	withScope: (cb: (s: unknown) => void) =>
		cb({ setTag: vi.fn(), setExtra: vi.fn(), setUser: vi.fn() }),
	extraErrorDataIntegration: vi.fn(() => ({ name: "ExtraErrorData" })),
	consoleIntegration: vi.fn(() => ({ name: "Console" })),
	logger: {
		trace: vi.fn(),
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		fatal: vi.fn(),
	},
}));

import * as Sentry from "@sentry/node";
import { createErrorReporter } from "./createErrorReporter.js";
import { SentryErrorReporter } from "./SentryErrorReporter.js";

describe("createErrorReporter", () => {
	it("returns a NoopErrorReporter when CYRUS_SENTRY_DISABLED is truthy", () => {
		const reporter = createErrorReporter({
			env: { CYRUS_SENTRY_DISABLED: "1", CYRUS_SENTRY_DSN: "https://x@y/1" },
		});
		expect(reporter).toBeInstanceOf(NoopErrorReporter);
		expect(reporter.isEnabled).toBe(false);
		expect(Sentry.init).not.toHaveBeenCalled();
	});

	it("returns Noop when CYRUS_TEAM_ID is unset (gates both Issues and Logs)", () => {
		const reporter = createErrorReporter({ env: {} });
		expect(reporter).toBeInstanceOf(NoopErrorReporter);
		expect(reporter.isEnabled).toBe(false);
		expect(Sentry.init).not.toHaveBeenCalled();
	});

	it("falls back to the bundled DEFAULT_SENTRY_DSN when no env DSN is configured", async () => {
		const { DEFAULT_SENTRY_DSN } = await import("./createErrorReporter.js");
		const reporter = createErrorReporter({
			env: { CYRUS_TEAM_ID: "team-42" },
		});
		if (DEFAULT_SENTRY_DSN) {
			expect(reporter).toBeInstanceOf(SentryErrorReporter);
		} else {
			expect(reporter).toBeInstanceOf(NoopErrorReporter);
			expect(reporter.isEnabled).toBe(false);
		}
	});

	it.each([
		"true",
		"yes",
		"on",
		"TRUE",
		"1",
	])("treats CYRUS_SENTRY_DISABLED=%s as opt-out", (value) => {
		const reporter = createErrorReporter({
			env: {
				CYRUS_SENTRY_DISABLED: value,
				CYRUS_SENTRY_DSN: "https://x@y/1",
				CYRUS_TEAM_ID: "team-42",
			},
		});
		expect(reporter.isEnabled).toBe(false);
	});

	it("returns a SentryErrorReporter when a DSN and CYRUS_TEAM_ID are provided", () => {
		const reporter = createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
			},
			release: "1.2.3",
		});
		expect(reporter).toBeInstanceOf(SentryErrorReporter);
		expect(reporter.isEnabled).toBe(true);
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({
				dsn: "https://abc@sentry.io/1",
				release: "1.2.3",
				environment: "production",
			}),
		);
	});

	it("applies CYRUS_TEAM_ID as the team_id tag and structured cyrus context on initialScope", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
			},
			release: "1.2.3",
		});
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({
				initialScope: {
					tags: { team_id: "team-42" },
					contexts: {
						cyrus: {
							team_id: "team-42",
							environment: "production",
							release: "1.2.3",
						},
					},
				},
			}),
		);
	});

	it("includes optional CYRUS_LINEAR_WORKSPACE / CYRUS_DEPLOYMENT_ID in the structured context", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
				CYRUS_LINEAR_WORKSPACE: "ceedar",
				CYRUS_DEPLOYMENT_ID: "fly-iad-1",
			},
		});
		const initArg = (
			Sentry.init as unknown as { mock: { calls: unknown[][] } }
		).mock.calls.at(-1)?.[0] as {
			initialScope: { contexts: { cyrus: Record<string, unknown> } };
		};
		expect(initArg.initialScope.contexts.cyrus).toMatchObject({
			team_id: "team-42",
			linear_workspace: "ceedar",
			deployment_id: "fly-iad-1",
		});
	});

	it("forwards CYRUS_SENTRY_ENVIRONMENT", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
				CYRUS_SENTRY_ENVIRONMENT: "staging",
			},
		});
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({ environment: "staging" }),
		);
	});

	it("forwards CYRUS_SENTRY_SAMPLE_RATE when valid", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
				CYRUS_SENTRY_SAMPLE_RATE: "0.25",
			},
		});
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({ sampleRate: 0.25 }),
		);
	});

	it.each([
		"foo",
		"-1",
		"2",
		"",
	])("falls back to default sampleRate when CYRUS_SENTRY_SAMPLE_RATE=%s is invalid", (value) => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
				CYRUS_SENTRY_SAMPLE_RATE: value,
			},
		});
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({ sampleRate: 1 }),
		);
	});

	it("enables Sentry Logs whenever the reporter is constructed (gate is upstream)", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
			},
		});
		expect(Sentry.init).toHaveBeenCalledWith(
			expect.objectContaining({ enableLogs: true }),
		);
	});

	it("does not capture Issues when CYRUS_TEAM_ID is unset", () => {
		const reporter = createErrorReporter({
			env: { CYRUS_SENTRY_DSN: "https://abc@sentry.io/1" },
		});
		expect(reporter.isEnabled).toBe(false);
		reporter.captureException(new Error("boom"));
		expect(Sentry.captureException).not.toHaveBeenCalled();
	});

	it("does not forward logs when CYRUS_TEAM_ID is unset", () => {
		const reporter = createErrorReporter({
			env: { CYRUS_SENTRY_DSN: "https://abc@sentry.io/1" },
		});
		reporter.log("info", "hello", { component: "EdgeWorker" });
		expect(Sentry.logger.info).not.toHaveBeenCalled();
	});

	it("forwards logger.* calls to Sentry.logger.* with team_id attribute", () => {
		const reporter = createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
			},
		});
		reporter.log("info", "hello world", { component: "EdgeWorker" });
		expect(Sentry.logger.info).toHaveBeenCalledWith(
			"hello world",
			expect.objectContaining({ team_id: "team-42", component: "EdgeWorker" }),
		);

		reporter.log("warn", "rate limit");
		expect(Sentry.logger.warn).toHaveBeenCalledWith(
			"rate limit",
			expect.objectContaining({ team_id: "team-42" }),
		);
	});

	it("installs the scrub hook as beforeSend", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
			},
		});
		const call = (Sentry.init as unknown as { mock: { calls: unknown[][] } })
			.mock.calls[0]?.[0] as { beforeSend?: (e: unknown) => unknown };
		expect(typeof call.beforeSend).toBe("function");
		// Smoke-check it actually scrubs.
		const scrubbed = call.beforeSend!({
			extra: { token: "ghp_abcdefghijklmnopqrstuvwxyz" },
		}) as { extra: Record<string, unknown> };
		expect(scrubbed.extra.token).toBe("[REDACTED]");
	});

	it("installs the log scrub hook as beforeSendLog", () => {
		createErrorReporter({
			env: {
				CYRUS_SENTRY_DSN: "https://abc@sentry.io/1",
				CYRUS_TEAM_ID: "team-42",
			},
		});
		const call = (Sentry.init as unknown as { mock: { calls: unknown[][] } })
			.mock.calls[0]?.[0] as { beforeSendLog?: (l: unknown) => unknown };
		expect(typeof call.beforeSendLog).toBe("function");
		const scrubbed = call.beforeSendLog!({
			level: "info",
			message: "Bearer abcdefghijklmnopqrstuvwxyz",
			attributes: { token: "ghp_abcdefghijklmnopqrstuvwxyz" },
		}) as { message: string; attributes: Record<string, unknown> };
		expect(scrubbed.message).toContain("Bearer [REDACTED]");
		expect(scrubbed.attributes.token).toBe("[REDACTED]");
	});

	it("Noop reporter flush resolves true and no-ops capture methods", async () => {
		const reporter = createErrorReporter({
			env: { CYRUS_SENTRY_DISABLED: "1" },
		});
		expect(() => reporter.captureException(new Error("x"))).not.toThrow();
		expect(() => reporter.captureMessage("hello")).not.toThrow();
		await expect(reporter.flush()).resolves.toBe(true);
	});
});
