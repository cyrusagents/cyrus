import { describe, expect, it, vi } from "vitest";
import { createLogger, LogLevel } from "../src/logging/index.js";
import { subscribeLocalLogs } from "../src/logging/LogPublisher.js";

describe("local log observers", () => {
	it("preserves context and respects log levels, and stops after unsubscribe", () => {
		const listener = vi.fn();
		const unsubscribe = subscribeLocalLogs(listener);
		const logger = createLogger({
			component: "test",
			level: LogLevel.WARN,
		}).withContext({ sessionId: "task" });
		try {
			logger.info("hidden");
			logger.warn("Build failed", new Error("failure"));
			expect(listener).toHaveBeenCalledTimes(1);
			expect(listener.mock.calls[0]?.[0]).toMatchObject({
				component: "test",
				level: "warning",
				context: { sessionId: "task" },
			});
		} finally {
			unsubscribe();
		}
		logger.error("after unsubscribe");
		expect(listener).toHaveBeenCalledTimes(1);
	});
	it("isolates observer failures from execution", () => {
		const unsubscribe = subscribeLocalLogs(() => {
			throw new Error("observer failed");
		});
		try {
			expect(() =>
				createLogger({ component: "test" }).info("still running"),
			).not.toThrow();
		} finally {
			unsubscribe();
		}
	});
});
