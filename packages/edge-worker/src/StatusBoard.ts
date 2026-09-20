import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import {
	type AgentMessage,
	type CyrusAgentSession,
	type CyrusAgentSessionEntry,
	type LocalLogRecord,
	subscribeLocalLogs,
} from "cyrus-core";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { BoardHistory, type BoardTask } from "./BoardHistory.js";

const MAX_TASKS = 60;
const MAX_LOGS = 650;
const MAX_TEXT = 4000;

export interface BoardLog {
	at: number;
	source: string;
	level: "debug" | "info" | "warning" | "error";
	kind: "activity" | "tool" | "output" | "lifecycle" | "service";
	text: string;
	sessionId?: string;
	issue?: string;
	/** Opaque correlation within a runner session; never inferred from log order. */
	toolCallId?: string;
}

export interface BoardOptions {
	historyPath?: string;
	onSessionRemoved?(listener: (session: CyrusAgentSession) => void): () => void;
	getSessions(): CyrusAgentSession[];
	getEntries(sessionId: string): CyrusAgentSessionEntry[];
	getStatus(): "idle" | "busy";
	getRepositoryName(id: string): string;
	getLinearWorkspaceSlug?(repositoryId: string): string | undefined;
}

export function redactBoardText(value: string): string {
	return (
		value
			// biome-ignore lint/suspicious/noControlCharactersInRegex: Strip ANSI color sequences from runner output.
			.replace(/\x1b\[[0-9;]*m/g, "")
			.replace(
				/\b(?:gh[pousr]_[\w]+|github_pat_[\w]+|lin_(?:api|oauth)_[\w-]+|sk-[\w-]{12,})\b/g,
				"[REDACTED]",
			)
			.replace(/\bBearer\s+[\w.\-+/=]+/gi, "Bearer [REDACTED]")
			.replace(
				/(\b(?:[\w]*(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|webhook[_-]?secret|password|api[_-]?key)|(?:GH|GITHUB|LINEAR|SLACK)[_-]?TOKEN|token|secret)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
				"$1[REDACTED]",
			)
			.replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
	);
}

function text(value: unknown): string {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return "[Unserializable output]";
	}
}

function bounded(value: string): string {
	const clean = redactBoardText(value);
	return clean.length > MAX_TEXT
		? `${clean.slice(0, MAX_TEXT)}\n… [entry truncated]`
		: clean;
}

function toolCallId(id: unknown, runner: unknown): string | undefined {
	if (typeof id !== "string" || !id || typeof runner !== "string" || !runner)
		return;
	return createHash("sha256")
		.update(JSON.stringify([runner, id]))
		.digest("hex");
}

/** Explicit output allowlist: never forward prompts, reasoning, or SDK system data. */
export function boardMessageLogs(
	message: AgentMessage,
	at: number,
): BoardLog[] {
	const logs: BoardLog[] = [];
	const add = (
		value: string,
		kind: BoardLog["kind"],
		error = false,
		id?: string,
	) => {
		if (value || kind === "output")
			logs.push({
				at,
				source: "agent",
				level: error ? "error" : "info",
				kind,
				text: bounded(value),
				...(id ? { toolCallId: id } : {}),
			});
	};
	if (message.type === "assistant" || message.type === "user") {
		const content = message.message.content;
		if (typeof content === "string") {
			if (message.type === "assistant") add(content, "activity");
			return logs;
		}
		for (const block of content) {
			if (message.type === "assistant" && block.type === "text")
				add(block.text, "activity");
			else if (message.type === "assistant" && block.type === "tool_use")
				add(
					`${block.name}\n${text(block.input)}`,
					"tool",
					false,
					toolCallId(block.id, message.session_id),
				);
			else if (block.type === "tool_result") {
				const output =
					typeof block.content === "string"
						? block.content
						: (block.content
								?.filter((part) => part.type === "text")
								.map((part) => part.text)
								.join("\n") ?? "");
				add(
					output,
					"output",
					Boolean(block.is_error),
					toolCallId(block.tool_use_id, message.session_id),
				);
			}
		}
	} else if (message.type === "result") {
		const body =
			"result" in message ? message.result : message.errors?.join("\n");
		add(
			body || (message.is_error ? "Turn failed" : "Turn completed"),
			"lifecycle",
			message.is_error,
		);
	}
	return logs;
}

function savedEntryLog(
	entry: CyrusAgentSessionEntry,
	fallbackTime: number,
): BoardLog | undefined {
	const toolResult =
		entry.type === "user" && Boolean(entry.metadata?.toolUseId);
	if (entry.type !== "assistant" && entry.type !== "result" && !toolResult)
		return;
	const toolCall =
		entry.type === "assistant" && Boolean(entry.metadata?.toolName);
	const content =
		toolCall && entry.metadata?.toolInput !== undefined
			? `${entry.metadata.toolName}\n${text(entry.metadata.toolInput)}`
			: entry.content;
	if (!content && !toolResult) return;
	return {
		at: entry.metadata?.timestamp ?? fallbackTime,
		source: "agent",
		level:
			entry.metadata?.isError ||
			entry.metadata?.toolResultError ||
			entry.metadata?.sdkError
				? "error"
				: "info",
		kind: toolResult
			? "output"
			: toolCall
				? "tool"
				: entry.type === "result"
					? "lifecycle"
					: "activity",
		text: bounded(content),
	};
}

function outputKey(runnerSessionId: string, log: BoardLog): string {
	return JSON.stringify([runnerSessionId, log.kind, log.text]);
}

/** Live runners plus a bounded, persistent archive of removed sessions. */
export class StatusBoard {
	private history: BoardHistory;
	private unsubscribeRemoval?: () => void;
	private serviceLogs: BoardLog[] = [];
	private messageTimes = new WeakMap<AgentMessage, number>();
	private observed = new Map<
		string,
		{
			runner: CyrusAgentSession["agentRunner"];
			running: boolean;
			startedAt: number;
			seen: boolean;
		}
	>();
	private unsubscribe: () => void;

	constructor(private options: BoardOptions) {
		this.history = new BoardHistory(options.historyPath, bounded);
		this.unsubscribe = subscribeLocalLogs((record) => this.recordLog(record));
		this.unsubscribeRemoval = options.onSessionRemoved?.((session) => {
			try {
				const snapshot = this.liveSnapshot([session]);
				const task = snapshot.tasks[0];
				if (task)
					this.history.add(
						{ ...task, reason: "Archived after session cleanup." },
						snapshot.logs.filter(
							(log) => log.sessionId === session.id && log.source === "agent",
						),
					);
			} catch {
				this.history.warning = "A removed task could not be archived.";
			}
		});
	}

	ready(): Promise<void> {
		return this.history.ready();
	}
	historyLogs(id: string): BoardLog[] {
		return this.history.logs(id);
	}
	async close(): Promise<void> {
		this.unsubscribeRemoval?.();
		this.unsubscribe();
		await this.history.flush();
		this.serviceLogs = [];
		this.observed.clear();
	}

	private recordLog(record: LocalLogRecord): void {
		this.serviceLogs.push({
			at: record.timestamp,
			source: "cyrus",
			level: record.level,
			kind: "service",
			text: bounded(`[${record.component}] ${record.message}`),
			sessionId: record.context.sessionId,
			issue: record.context.issueIdentifier,
		});
		if (this.serviceLogs.length > MAX_LOGS)
			this.serviceLogs.splice(0, this.serviceLogs.length - MAX_LOGS);
	}

	snapshot() {
		const live = this.liveSnapshot();
		const ids = new Set(
			this.options.getSessions().map((session) => session.id),
		);
		return {
			...live,
			tasks: [
				...live.tasks,
				...this.history.tasks().filter((task) => !ids.has(task.id)),
			].sort(
				(a, b) =>
					Number(b.status === "running") - Number(a.status === "running") ||
					b.lastActivityAt - a.lastActivityAt,
			),
			warnings: this.history.warning ? [this.history.warning] : [],
		};
	}

	private liveSnapshot(sessions = this.options.getSessions()) {
		const now = Date.now();
		const ids = new Set(
			this.options.getSessions().map((session) => session.id),
		);
		for (const id of this.observed.keys())
			if (!ids.has(id)) this.observed.delete(id);
		// Prioritize real live runners before applying the retention limit.
		const active = sessions
			.map((session) => ({
				session,
				running: Boolean(session.agentRunner?.isRunning()),
			}))
			.sort(
				(a, b) =>
					Number(b.running) - Number(a.running) ||
					b.session.updatedAt - a.session.updatedAt,
			)
			.slice(0, MAX_TASKS);
		const logs = [...this.serviceLogs];
		const tasks: BoardTask[] = active.map(({ session, running }) => {
			const runner = session.agentRunner;
			const previous = this.observed.get(session.id);
			const startedAt =
				running && previous && (!previous.running || previous.runner !== runner)
					? now
					: (previous?.startedAt ?? session.updatedAt);
			this.observed.set(session.id, { runner, running, startedAt, seen: true });
			const messages = runner?.getMessages() ?? [];
			let lastActivityAt = session.updatedAt;
			// The manager retains previous turns even when a resumed runner starts
			// with an empty message buffer. Saved output is the history source.
			const savedCounts = new Map<string, number>();
			const savedEntries = this.options.getEntries(session.id).slice(-MAX_LOGS);
			for (const entry of savedEntries) {
				const log = savedEntryLog(entry, session.updatedAt);
				if (!log) continue;
				const runnerSessionId =
					entry.codexSessionId ??
					entry.claudeSessionId ??
					entry.geminiSessionId ??
					entry.cursorSessionId ??
					entry.opencodeSessionId ??
					"";
				const key = outputKey(runnerSessionId, log);
				if (log.kind === "tool" || log.kind === "output") {
					log.toolCallId = toolCallId(
						entry.metadata?.toolUseId,
						runnerSessionId,
					);
				}
				savedCounts.set(key, (savedCounts.get(key) ?? 0) + 1);
				lastActivityAt = Math.max(lastActivityAt, log.at);
				logs.push({
					...log,
					sessionId: session.id,
					issue: session.issue?.identifier,
				});
			}
			for (const message of messages.slice(-160)) {
				let at = this.messageTimes.get(message);
				if (at === undefined) {
					at = previous?.seen ? now : session.updatedAt;
					this.messageTimes.set(message, at);
				}
				const entries = boardMessageLogs(message, at);
				for (const entry of entries) {
					const runnerSessionId =
						"session_id" in message ? (message.session_id ?? "") : "";
					const key = outputKey(runnerSessionId, entry);
					const savedCount = savedCounts.get(key) ?? 0;
					if (savedCount > 0) {
						savedCounts.set(key, savedCount - 1);
						continue;
					}
					lastActivityAt = Math.max(lastActivityAt, at);
					logs.push({
						...entry,
						sessionId: session.id,
						issue: session.issue?.identifier,
					});
				}
			}
			const lastResult = [...messages]
				.reverse()
				.find((message) => message.type === "result");
			const status = running
				? "running"
				: session.status === "error" || lastResult?.is_error
					? "error"
					: session.status === "complete" || lastResult
						? "completed"
						: "idle";
			const workspaceSlugs = new Set(
				session.repositories.map((repo) =>
					this.options.getLinearWorkspaceSlug?.(repo.repositoryId),
				),
			);
			const workspaceSlug =
				(!session.issueContext ||
					session.issueContext.trackerId === "linear") &&
				workspaceSlugs.size === 1
					? [...workspaceSlugs][0]
					: undefined;
			return {
				id: session.id,
				linearWorkspaceSlug: workspaceSlug ? bounded(workspaceSlug) : undefined,
				issue: bounded(
					session.issue?.identifier ??
						session.issueContext?.issueIdentifier ??
						"",
				),
				title: bounded(session.issue?.title ?? "Chat session"),
				status,
				reason: running
					? "This session's runner is executing."
					: "This session's runner is not executing.",
				model: bounded(session.metadata?.model ?? ""),
				reasoningEffort: bounded(session.metadata?.reasoningEffort ?? ""),
				fastMode: session.metadata?.fastMode,
				createdAt: session.createdAt,
				lastActivityAt,
				turnStartedAt: startedAt,
				quiet: running && now - lastActivityAt > 120000,
				repositories: session.repositories.map((repo) =>
					bounded(this.options.getRepositoryName(repo.repositoryId)),
				),
			};
		});
		return {
			app: "cyrus-board",
			collectedAt: new Date(now).toISOString(),
			stale: false,
			service: { online: true, status: this.options.getStatus() },
			tasks,
			logs: logs.sort((a, b) => a.at - b.at).slice(-MAX_LOGS),
			warnings: [],
		};
	}
}

/** Check the socket, not Fastify's proxy-trusting request.ip. */
export function isLocalBoardRequest(request: FastifyRequest): boolean {
	const address = request.raw.socket.remoteAddress;
	if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address ?? ""))
		return false;
	for (const header of [
		"forwarded",
		"x-forwarded-for",
		"x-forwarded-host",
		"cf-connecting-ip",
	]) {
		if (request.headers[header] !== undefined) return false;
	}
	try {
		const url = new URL(`http://${request.headers.host}`);
		if (
			!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
			url.username ||
			url.password
		)
			return false;
		if (request.headers.origin && request.headers.origin !== url.origin)
			return false;
		return (
			!request.headers["sec-fetch-site"] ||
			request.headers["sec-fetch-site"] !== "cross-site"
		);
	} catch {
		return false;
	}
}

/** Registers on the existing application server; no listener or subprocess is created. */
export function registerStatusBoard(
	app: FastifyInstance,
	options: BoardOptions,
	assetsDirectory = new URL("./board/", import.meta.url),
): StatusBoard {
	const board = new StatusBoard(options);
	const clients = new Set<ServerResponse>();
	let timer: ReturnType<typeof setInterval> | undefined;
	const broadcast = () => {
		try {
			const data = `data: ${JSON.stringify(board.snapshot())}\n\n`;
			for (const client of clients) {
				if (client.writableLength > 2 * 1024 * 1024) client.destroy();
				else client.write(data);
			}
		} catch {
			for (const client of clients)
				client.write("event: unavailable\ndata: {}\n\n");
		}
	};
	const routes = new Map([
		["/board", ["index.html", "text/html; charset=utf-8"]],
		["/board/", ["index.html", "text/html; charset=utf-8"]],
		["/board/assets/app.js", ["app.js", "text/javascript; charset=utf-8"]],
		["/board/assets/app.css", ["app.css", "text/css; charset=utf-8"]],
		[
			"/board/assets/app.js.LEGAL.txt",
			["app.js.LEGAL.txt", "text/plain; charset=utf-8"],
		],
	]);
	app.register(async (scoped) => {
		await board.ready();
		scoped.addHook("onRequest", async (request, reply) => {
			if (!isLocalBoardRequest(request))
				return reply.code(403).send({ error: "Local access only" });
			reply
				.header("Cache-Control", "no-store")
				.header("X-Content-Type-Options", "nosniff")
				.header("Referrer-Policy", "no-referrer")
				.header(
					"Content-Security-Policy",
					"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'",
				);
			return undefined;
		});
		for (const [url, [file, type]] of routes) {
			scoped.get(url, async (_request, reply) =>
				reply.type(type!).send(await readFile(new URL(file!, assetsDirectory))),
			);
		}
		scoped.get("/board/api/snapshot", async () => board.snapshot());
		scoped.get<{ Params: { sessionId: string } }>(
			"/board/api/history/:sessionId",
			async (request) => ({
				logs: board.historyLogs(request.params.sessionId),
			}),
		);
		scoped.get("/board/events", (request, reply) => {
			for (const [name, value] of Object.entries(reply.getHeaders())) {
				if (value !== undefined) reply.raw.setHeader(name, value);
			}
			reply.raw.writeHead(200, {
				"Content-Type": "text/event-stream; charset=utf-8",
				Connection: "keep-alive",
			});
			reply.hijack();
			const response = reply.raw;
			clients.add(response);
			response.write("retry: 3000\n\n");
			broadcast();
			if (!timer) {
				timer = setInterval(broadcast, 2000);
				timer.unref();
			}
			const cleanup = () => {
				clients.delete(response);
				if (!clients.size && timer) {
					clearInterval(timer);
					timer = undefined;
				}
			};
			response.on("close", cleanup);
			request.raw.on("error", cleanup);
		});
	});
	// End SSE before Fastify waits for open responses to drain.
	app.addHook("preClose", async () => {
		if (timer) clearInterval(timer);
		for (const client of clients) client.end();
		clients.clear();
		await board.close();
	});
	return board;
}
