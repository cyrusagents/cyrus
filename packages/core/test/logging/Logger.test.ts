import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createLogger, LogLevel } from "../../src/logging/index.js";

describe("Logger", () => {
	let logSpy: ReturnType<typeof vi.spyOn>;
	let warnSpy: ReturnType<typeof vi.spyOn>;
	let errorSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
	});

	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.CYRUS_LOG_LEVEL;
	});

	describe("level filtering", () => {
		it("filters out messages below the configured level", () => {
			const logger = createLogger({
				component: "Test",
				level: LogLevel.WARN,
			});
			logger.debug("debug msg");
			logger.info("info msg");
			logger.warn("warn msg");
			logger.error("error msg");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledTimes(1);
		});

		it("defaults to INFO level", () => {
			const logger = createLogger({ component: "Test" });
			logger.debug("debug msg");
			logger.info("info msg");

			expect(logSpy).toHaveBeenCalledTimes(1);
			expect(logSpy.mock.calls[0]![0]).toContain("info msg");
		});

		it("SILENT suppresses all output", () => {
			const logger = createLogger({
				component: "Test",
				level: LogLevel.SILENT,
			});
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
			expect(errorSpy).not.toHaveBeenCalled();
		});

		it("DEBUG shows all messages", () => {
			const logger = createLogger({
				component: "Test",
				level: LogLevel.DEBUG,
			});
			logger.debug("d");
			logger.info("i");
			logger.warn("w");
			logger.error("e");

			expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
			expect(warnSpy).toHaveBeenCalledTimes(1);
			expect(errorSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("output formatting", () => {
		it("includes level label and component name", () => {
			const logger = createLogger({
				component: "EdgeWorker",
				level: LogLevel.DEBUG,
			});
			logger.info("Starting up");

			expect(logSpy).toHaveBeenCalledWith("[INFO ] [EdgeWorker] Starting up");
		});

		it("uses console.warn for warn level", () => {
			const logger = createLogger({
				component: "Router",
				level: LogLevel.DEBUG,
			});
			logger.warn("Missing config");

			expect(warnSpy).toHaveBeenCalledWith("[WARN ] [Router] Missing config");
		});

		it("uses console.error for error level", () => {
			const logger = createLogger({
				component: "Runner",
				level: LogLevel.DEBUG,
			});
			logger.error("Fatal crash");

			expect(errorSpy).toHaveBeenCalledWith("[ERROR] [Runner] Fatal crash");
		});

		it("passes extra args through to console", () => {
			const logger = createLogger({
				component: "Test",
				level: LogLevel.DEBUG,
			});
			const extra = { key: "value" };
			logger.info("Message", extra);

			expect(logSpy).toHaveBeenCalledWith("[INFO ] [Test] Message", extra);
		});
	});

	describe("context formatting", () => {
		it("includes context block when context is set", () => {
			const logger = createLogger({
				component: "EdgeWorker",
				level: LogLevel.DEBUG,
				context: {
					sessionId: "abc12345-full-uuid-here",
					platform: "linear",
					issueIdentifier: "CYPACK-456",
				},
			});
			logger.info("AI routing decision");

			expect(logSpy).toHaveBeenCalledWith(
				"[INFO ] [EdgeWorker] {session=abc12345, platform=linear, issue=CYPACK-456} AI routing decision",
			);
		});

		it("abbreviates session ID to first 8 characters", () => {
			const logger = createLogger({
				component: "Test",
				context: { sessionId: "abcdefgh-ijkl-mnop" },
			});
			logger.info("test");

			expect(logSpy).toHaveBeenCalledWith(
				"[INFO ] [Test] {session=abcdefgh} test",
			);
		});

		it("omits context block when no context values are set", () => {
			const logger = createLogger({ component: "Test" });
			logger.info("no context");

			expect(logSpy).toHaveBeenCalledWith("[INFO ] [Test] no context");
		});

		it("includes repository when set", () => {
			const logger = createLogger({
				component: "Test",
				context: { repository: "my-repo" },
			});
			logger.info("msg");

			expect(logSpy).toHaveBeenCalledWith("[INFO ] [Test] {repo=my-repo} msg");
		});
	});

	describe("withContext()", () => {
		it("returns a new logger with merged context", () => {
			const parent = createLogger({
				component: "EdgeWorker",
				level: LogLevel.DEBUG,
				context: { platform: "linear" },
			});

			const child = parent.withContext({
				sessionId: "sess1234-abcd",
				issueIdentifier: "DEF-1",
			});

			child.info("Processing");

			expect(logSpy).toHaveBeenCalledWith(
				"[INFO ] [EdgeWorker] {session=sess1234, platform=linear, issue=DEF-1} Processing",
			);
		});

		it("does not modify the parent logger", () => {
			const parent = createLogger({
				component: "Test",
				context: { platform: "cli" },
			});

			parent.withContext({ sessionId: "abc12345" });
			parent.info("unchanged");

			expect(logSpy).toHaveBeenCalledWith(
				"[INFO ] [Test] {platform=cli} unchanged",
			);
		});

		it("overrides existing context values", () => {
			const logger = createLogger({
				component: "Test",
				context: { platform: "linear", repository: "old" },
			});

			const updated = logger.withContext({ repository: "new" });
			updated.info("check");

			expect(logSpy).toHaveBeenCalledWith(
				"[INFO ] [Test] {platform=linear, repo=new} check",
			);
		});

		it("preserves the log level from parent", () => {
			const parent = createLogger({
				component: "Test",
				level: LogLevel.WARN,
			});

			const child = parent.withContext({ sessionId: "abc12345" });
			child.info("should be filtered");
			child.warn("should show");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("setLevel() and getLevel()", () => {
		it("allows changing the log level at runtime", () => {
			const logger = createLogger({
				component: "Test",
				level: LogLevel.INFO,
			});

			expect(logger.getLevel()).toBe(LogLevel.INFO);

			logger.setLevel(LogLevel.DEBUG);
			expect(logger.getLevel()).toBe(LogLevel.DEBUG);

			logger.debug("now visible");
			expect(logSpy).toHaveBeenCalledTimes(1);
		});
	});

	describe("CYRUS_LOG_LEVEL environment variable", () => {
		it("respects CYRUS_LOG_LEVEL=DEBUG", () => {
			process.env.CYRUS_LOG_LEVEL = "DEBUG";
			const logger = createLogger({ component: "Test" });
			logger.debug("visible");

			expect(logSpy).toHaveBeenCalledTimes(1);
		});

		it("respects CYRUS_LOG_LEVEL=WARN", () => {
			process.env.CYRUS_LOG_LEVEL = "WARN";
			const logger = createLogger({ component: "Test" });
			logger.info("filtered");
			logger.warn("visible");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).toHaveBeenCalledTimes(1);
		});

		it("is case-insensitive", () => {
			process.env.CYRUS_LOG_LEVEL = "debug";
			const logger = createLogger({ component: "Test" });
			logger.debug("visible");

			expect(logSpy).toHaveBeenCalledTimes(1);
		});

		it("explicit level option overrides env var", () => {
			process.env.CYRUS_LOG_LEVEL = "DEBUG";
			const logger = createLogger({
				component: "Test",
				level: LogLevel.ERROR,
			});
			logger.debug("filtered");
			logger.info("filtered");
			logger.warn("filtered");

			expect(logSpy).not.toHaveBeenCalled();
			expect(warnSpy).not.toHaveBeenCalled();
		});

		it("falls back to INFO for unrecognized values", () => {
			process.env.CYRUS_LOG_LEVEL = "FOOBAR";
			const logger = createLogger({ component: "Test" });
			logger.debug("filtered");
			logger.info("visible");

			expect(logSpy).toHaveBeenCalledTimes(1);
		});
	});
});
