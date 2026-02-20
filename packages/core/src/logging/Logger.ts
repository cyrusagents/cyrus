import type { ILogger, LogContext } from "./ILogger.js";
import { LogLevel } from "./ILogger.js";

function formatContext(context: LogContext): string {
	const parts: string[] = [];
	if (context.sessionId) {
		parts.push(`session=${context.sessionId.slice(0, 8)}`);
	}
	if (context.platform) {
		parts.push(`platform=${context.platform}`);
	}
	if (context.issueIdentifier) {
		parts.push(`issue=${context.issueIdentifier}`);
	}
	if (context.repository) {
		parts.push(`repo=${context.repository}`);
	}
	return parts.length > 0 ? ` {${parts.join(", ")}}` : "";
}

function parseLevelFromEnv(): LogLevel | undefined {
	const envLevel = process.env.CYRUS_LOG_LEVEL?.toUpperCase();
	switch (envLevel) {
		case "DEBUG":
			return LogLevel.DEBUG;
		case "INFO":
			return LogLevel.INFO;
		case "WARN":
			return LogLevel.WARN;
		case "ERROR":
			return LogLevel.ERROR;
		case "SILENT":
			return LogLevel.SILENT;
		default:
			return undefined;
	}
}

const LEVEL_LABELS: Record<LogLevel, string> = {
	[LogLevel.DEBUG]: "DEBUG",
	[LogLevel.INFO]: "INFO",
	[LogLevel.WARN]: "WARN",
	[LogLevel.ERROR]: "ERROR",
	[LogLevel.SILENT]: "",
};

class Logger implements ILogger {
	private level: LogLevel;
	private component: string;
	private context: LogContext;

	constructor(options: {
		component: string;
		level?: LogLevel;
		context?: LogContext;
	}) {
		this.component = options.component;
		this.level = options.level ?? parseLevelFromEnv() ?? LogLevel.INFO;
		this.context = options.context ?? {};
	}

	private formatPrefix(level: LogLevel): string {
		const label = LEVEL_LABELS[level];
		const padded = label.padEnd(5);
		const ctx = formatContext(this.context);
		return `[${padded}] [${this.component}]${ctx}`;
	}

	debug(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.DEBUG) {
			console.log(`${this.formatPrefix(LogLevel.DEBUG)} ${message}`, ...args);
		}
	}

	info(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.INFO) {
			console.log(`${this.formatPrefix(LogLevel.INFO)} ${message}`, ...args);
		}
	}

	warn(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.WARN) {
			console.warn(`${this.formatPrefix(LogLevel.WARN)} ${message}`, ...args);
		}
	}

	error(message: string, ...args: unknown[]): void {
		if (this.level <= LogLevel.ERROR) {
			console.error(`${this.formatPrefix(LogLevel.ERROR)} ${message}`, ...args);
		}
	}

	withContext(context: LogContext): ILogger {
		return new Logger({
			component: this.component,
			level: this.level,
			context: { ...this.context, ...context },
		});
	}

	getLevel(): LogLevel {
		return this.level;
	}

	setLevel(level: LogLevel): void {
		this.level = level;
	}
}

export function createLogger(options: {
	component: string;
	level?: LogLevel;
	context?: LogContext;
}): ILogger {
	return new Logger(options);
}
