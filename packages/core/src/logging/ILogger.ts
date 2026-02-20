export enum LogLevel {
	DEBUG = 0,
	INFO = 1,
	WARN = 2,
	ERROR = 3,
	SILENT = 4,
}

export interface LogContext {
	sessionId?: string;
	platform?: string;
	issueIdentifier?: string;
	repository?: string;
}

export interface ILogger {
	debug(message: string, ...args: unknown[]): void;
	info(message: string, ...args: unknown[]): void;
	warn(message: string, ...args: unknown[]): void;
	error(message: string, ...args: unknown[]): void;
	withContext(context: LogContext): ILogger;
	getLevel(): LogLevel;
	setLevel(level: LogLevel): void;
}
