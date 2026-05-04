import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
	ErrorReporter,
	ErrorReporterContext,
	ErrorReporterLogAttributes,
	ErrorReporterLogLevel,
	ErrorReporterSeverity,
} from "../../src/error-reporting/ErrorReporter.js";
import {
	resetGlobalErrorReporter,
	setGlobalErrorReporter,
	setGlobalErrorTags,
} from "../../src/error-reporting/globalReporter.js";
import { createLogger, LogLevel } from "../../src/logging/index.js";

class FakeReporter implements ErrorReporter {
	readonly isEnabled = true;
	exceptions: Array<{ error: unknown; context?: ErrorReporterContext }> = [];
	messages: Array<{
		message: string;
		severity?: ErrorReporterSeverity;
		context?: ErrorReporterContext;
	}> = [];
	captureException(error: unknown, context?: ErrorReporterContext): void {
		this.exceptions.push({ error, context });
	}
	captureMessage(
		message: string,
		severity?: ErrorReporterSeverity,
		context?: ErrorReporterContext,
	): void {
		this.messages.push({ message, severity, context });
	}
	logs: Array<{
		level: ErrorReporterLogLevel;
		message: string;
		attributes?: ErrorReporterLogAttributes;
	}> = [];
	log(
		level: ErrorReporterLogLevel,
		message: string,
		attributes?: ErrorReporterLogAttributes,
	): void {
		this.logs.push({ level, message, attributes });
	}
	async flush(): Promise<boolean> {
		return true;
	}
}

describe("Logger error → reporter forwarding", () => {
	let reporter: FakeReporter;

	beforeEach(() => {
		vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		reporter = new FakeReporter();
		setGlobalErrorReporter(reporter);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		resetGlobalErrorReporter();
	});

	it("forwards an Error arg to captureException with component tag", () => {
		const log = createLogger({ component: "EdgeWorker" });
		const err = new Error("boom");
		log.error("Failed to fetch:", err);

		expect(reporter.exceptions).toHaveLength(1);
		expect(reporter.exceptions[0]?.error).toBe(err);
		expect(reporter.exceptions[0]?.context?.tags).toMatchObject({
			component: "EdgeWorker",
		});
		expect(reporter.exceptions[0]?.context?.extra).toMatchObject({
			message: "Failed to fetch:",
		});
	});

	it("captures a message at error severity when no Error arg is present", () => {
		const log = createLogger({ component: "PersistenceManager" });
		log.error("Disk full");

		expect(reporter.exceptions).toHaveLength(0);
		expect(reporter.messages).toHaveLength(1);
		expect(reporter.messages[0]?.severity).toBe("error");
		expect(reporter.messages[0]?.message).toBe("Disk full");
	});

	it("propagates LogContext fields as tags", () => {
		const log = createLogger({
			component: "ClaudeRunner",
			context: {
				sessionId: "session-abc",
				platform: "linear",
				issueIdentifier: "CYPACK-42",
				repository: "cyrus",
			},
		});
		log.error("Session error:", new Error("x"));

		expect(reporter.exceptions[0]?.context?.tags).toMatchObject({
			component: "ClaudeRunner",
			sessionId: "session-abc",
			platform: "linear",
			issueIdentifier: "CYPACK-42",
			repository: "cyrus",
		});
	});

	it("unwraps `{ error: Error }` shapes", () => {
		const log = createLogger({ component: "Transport" });
		const inner = new Error("inner");
		log.error("Webhook failed", { error: inner });

		expect(reporter.exceptions[0]?.error).toBe(inner);
	});

	it("does not forward when reporter is disabled (default Noop)", () => {
		resetGlobalErrorReporter(); // back to default Noop
		const log = createLogger({ component: "EdgeWorker" });
		expect(() => log.error("boom", new Error("x"))).not.toThrow();
		// No assertions on reporter — by definition Noop swallows
	});

	it("does not capture debug/info/warn as Issues, only warn forwards to Logs", () => {
		const log = createLogger({ component: "EdgeWorker" });
		log.debug("d", new Error("d"));
		log.info("i", new Error("i"));
		log.warn("w", new Error("w"));
		expect(reporter.exceptions).toHaveLength(0);
		expect(reporter.messages).toHaveLength(0);
		// debug/info are local-only now to keep Sentry Logs volume bounded;
		// warn/error continue to forward unconditionally.
		expect(reporter.logs.map((l) => l.level)).toEqual(["warn"]);
	});

	it("forwards only warn/error logs by default; events ride through unconditionally", () => {
		setGlobalErrorTags({ team_id: "team-42" });
		const log = createLogger({
			component: "EdgeWorker",
			context: { sessionId: "s-1", issueIdentifier: "CYPACK-7" },
		});
		log.debug("d");
		log.info("i");
		log.warn("w");
		log.error("e");
		log.event("session_started", { claudeSessionId: "abc" });

		expect(reporter.logs.map((l) => l.level)).toEqual([
			"warn",
			"error",
			"info", // event() is forwarded at info level
		]);
		for (const entry of reporter.logs) {
			expect(entry.attributes).toMatchObject({
				team_id: "team-42",
				component: "EdgeWorker",
				sessionId: "s-1",
				issueIdentifier: "CYPACK-7",
			});
		}
		const eventEntry = reporter.logs.at(-1);
		expect(eventEntry?.attributes).toMatchObject({
			event: "session_started",
			claudeSessionId: "abc",
		});
	});

	it("forwards warn/error and events to Sentry Logs even when console is silenced", () => {
		// CYRUS_LOG_LEVEL controls the local console only; warn/error and
		// explicit events are the always-on backbone.
		const log = createLogger({ component: "X", level: LogLevel.SILENT });
		log.debug("d");
		log.info("i");
		log.warn("w");
		log.error("e", new Error("boom"));
		log.event("session_completed");
		expect(reporter.logs.map((l) => l.level)).toEqual([
			"warn",
			"error",
			"info",
		]);
		// And errors still capture as Issues regardless.
		expect(reporter.exceptions).toHaveLength(1);
	});

	it("summarises Error trailing args into a primitive attribute", () => {
		const log = createLogger({ component: "Transport" });
		log.error("Failed", new Error("boom"));
		const errLog = reporter.logs.find((l) => l.level === "error");
		expect(errLog?.attributes?.args).toContain("Error: boom");
	});

	it("merges process-wide tags (e.g. team_id) into every forwarded event", () => {
		setGlobalErrorTags({ team_id: "team-42" });
		const log = createLogger({ component: "EdgeWorker" });
		log.error("Boom", new Error("x"));
		log.error("Plain message");

		expect(reporter.exceptions[0]?.context?.tags).toMatchObject({
			team_id: "team-42",
			component: "EdgeWorker",
		});
		expect(reporter.messages[0]?.context?.tags).toMatchObject({
			team_id: "team-42",
			component: "EdgeWorker",
		});
	});

	it("sets a stable fingerprint that templatizes IDs and paths", () => {
		const log = createLogger({ component: "EdgeWorker" });
		log.error("Failed for issue CYPACK-42 at /Users/x/work/foo.ts");
		log.error("Failed for issue CYPACK-99 at /Users/y/work/bar.ts");

		// Both messages should collapse to the same fingerprint group.
		const fp0 = reporter.messages[0]?.context?.fingerprint;
		const fp1 = reporter.messages[1]?.context?.fingerprint;
		expect(fp0).toBeDefined();
		expect(fp0).toEqual(fp1);
		expect(fp0?.[0]).toBe("logger");
		expect(fp0?.[1]).toBe("EdgeWorker");
		expect(fp0?.[2]).toContain("<id>");
		expect(fp0?.[2]).toContain("<path>");
	});

	it("attaches a fingerprint when forwarding an Error", () => {
		const log = createLogger({ component: "ClaudeRunner" });
		log.error(
			"Session failed for c5c1fc00-1234-1234-1234-c5c1fc00aaaa",
			new Error("x"),
		);
		const fp = reporter.exceptions[0]?.context?.fingerprint;
		expect(fp?.[2]).toContain("<uuid>");
	});

	it("per-call context tags override global tags on key collision", () => {
		setGlobalErrorTags({ component: "should-not-win", team_id: "team-42" });
		const log = createLogger({ component: "EdgeWorker" });
		log.error("Boom", new Error("x"));
		expect(reporter.exceptions[0]?.context?.tags).toMatchObject({
			component: "EdgeWorker",
			team_id: "team-42",
		});
	});
});
