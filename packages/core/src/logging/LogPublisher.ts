import { formatWithOptions } from "node:util";
import type { LogContext } from "./ILogger.js";

export interface LocalLogRecord {
	timestamp: number;
	level: "debug" | "info" | "warning" | "error";
	component: string;
	context: LogContext;
	message: string;
}

const listeners = new Set<(record: LocalLogRecord) => void>();

/** Optional in-process observers. Does not replace console output or reporting. */
export function subscribeLocalLogs(
	listener: (record: LocalLogRecord) => void,
): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function publishLocalLog(
	level: LocalLogRecord["level"],
	component: string,
	context: LogContext,
	message: string,
	args: unknown[],
): void {
	if (!listeners.size) return;
	const record: LocalLogRecord = {
		timestamp: Date.now(),
		level,
		component,
		context: { ...context },
		message: formatWithOptions(
			{ depth: 3, maxArrayLength: 30, maxStringLength: 4000 },
			message,
			...args,
		).slice(0, 8000),
	};
	for (const listener of listeners) {
		// Monitoring must never prevent a runner or webhook from making progress.
		try {
			listener(record);
		} catch {
			/* Isolate optional observers. */
		}
	}
}
