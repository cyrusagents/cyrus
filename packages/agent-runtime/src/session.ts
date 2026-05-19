import { EventEmitter } from "node:events";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
	materializeFolderIntoSandbox,
	materializeRepositoryIntoSandbox,
	syncFolderBackToHost,
} from "./materializers/index.js";
import {
	materializePluginForClaude,
	materializePluginForCodex,
	materializePluginForCursor,
	resolvePlugin,
} from "./plugins/index.js";
// (Daytona stop/start support — see pauseSandboxIfApplicable.)
import type {
	AgentSession,
	AgentSessionResult,
	HarnessAdapter,
	NormalizedAgentSessionConfig,
	RunnerSandbox,
	RuntimeCallbacks,
	RuntimeFolderConfig,
	TranscriptEvent,
} from "./types.js";

class AsyncEventBuffer<T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiters: Array<(value: IteratorResult<T>) => void> = [];
	private closed = false;

	push(value: T): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter({ value, done: false });
			return;
		}
		this.queue.push(value);
	}

	close(): void {
		this.closed = true;
		while (this.waiters.length > 0) {
			this.waiters.shift()?.({ value: undefined, done: true });
		}
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return {
			next: () => {
				const value = this.queue.shift();
				if (value !== undefined) {
					return Promise.resolve({ value, done: false });
				}
				if (this.closed) {
					return Promise.resolve({ value: undefined, done: true });
				}
				return new Promise<IteratorResult<T>>((resolve) => {
					this.waiters.push(resolve);
				});
			},
		};
	}
}

/**
 * Splits incoming chunks into newline-terminated lines for harness adapters
 * to parse. Carries a partial-line buffer between chunks so an event that
 * arrives split across multiple TCP packets is still parsed as one line.
 */
class LineSplitter {
	private buffer = "";

	push(chunk: string, onLine: (line: string) => void): void {
		this.buffer += chunk;
		let nl = this.buffer.indexOf("\n");
		while (nl !== -1) {
			const line = this.buffer.slice(0, nl);
			this.buffer = this.buffer.slice(nl + 1);
			const stripped = line.endsWith("\r") ? line.slice(0, -1) : line;
			if (stripped.trim()) onLine(stripped);
			nl = this.buffer.indexOf("\n");
		}
	}

	flush(onLine: (line: string) => void): void {
		const remaining = this.buffer;
		this.buffer = "";
		if (remaining.trim()) onLine(remaining);
	}
}

const DEFAULT_AGENT_SESSIONS_ROOT = join(homedir(), ".cyrus-agent-sessions");

function resolveAgentSessionsRoot(configuredRoot: string | undefined): string {
	const root = configuredRoot ?? DEFAULT_AGENT_SESSIONS_ROOT;
	return isAbsolute(root) ? root : resolve(process.cwd(), root);
}

/**
 * Try to fetch a native @daytonaio/sdk Sandbox out of a ComputeSDK-
 * wrapped sandbox via the `getInstance()` escape hatch. Used by the
 * destroyWhileInactive code path to call `.start()` / `.stop()` on the
 * native sandbox (ComputeSDK doesn't expose lifecycle control).
 *
 * Returns `undefined` for sandboxes that aren't Daytona-shaped (e.g.
 * local provider, or a Daytona sandbox wrapped without `getInstance`).
 */
function tryNativeDaytonaSandbox(
	sandbox: RunnerSandbox,
): { start(): Promise<void>; stop(): Promise<void> } | undefined {
	const candidate = (
		sandbox as unknown as { sandbox?: { getInstance?: () => unknown } }
	).sandbox;
	const instance = candidate?.getInstance?.();
	if (!instance || typeof instance !== "object") return undefined;
	const obj = instance as { start?: unknown; stop?: unknown };
	if (typeof obj.start === "function" && typeof obj.stop === "function") {
		return obj as { start(): Promise<void>; stop(): Promise<void> };
	}
	return undefined;
}

export class RuntimeAgentSession extends EventEmitter implements AgentSession {
	readonly sessionId: string;
	readonly harness: NormalizedAgentSessionConfig["harness"]["kind"];
	readonly events: AsyncIterable<TranscriptEvent>;

	private readonly eventBuffer = new AsyncEventBuffer<TranscriptEvent>();
	private readonly observedEvents: TranscriptEvent[] = [];
	private readonly queuedMessages: string[] = [];
	private readonly sessionStateDir: string;
	/**
	 * Per-readwrite-folder ledger of files we materialized in, so sync-back
	 * (at session.destroy()) can re-read them even if the agent didn't
	 * touch them.
	 */
	private readonly folderLedger = new Map<
		RuntimeFolderConfig,
		readonly string[]
	>();

	private materializationDone = false;
	private turnCount = 0;
	private sandboxDestroyed = false;
	private sandboxDestroyPromise?: Promise<void>;
	/**
	 * Outputs from plugin materialization on the first turn, persisted
	 * for re-use on subsequent turns (the adapter's `buildCommand` needs
	 * them every turn to wire CLI flags consistently).
	 */
	private pluginOutputs: {
		claudePluginDirs: string[];
		claudeMcpConfigPath?: string;
		cursorHasMcpServers: boolean;
		codexConfigOverrides: string[];
		codexHomeOverride?: string;
	} = {
		claudePluginDirs: [],
		cursorHasMcpServers: false,
		codexConfigOverrides: [],
	};

	private readonly sandbox: RunnerSandbox;
	/**
	 * When `true`, the session pauses the underlying sandbox between
	 * runs (Daytona: `stop()`) and resumes it on the next `run()`. The
	 * sandbox itself is the same object across runs — only its
	 * running/stopped state toggles. State on disk inside the sandbox
	 * (including `~/.claude/`) is preserved by Daytona during stop.
	 */
	private readonly destroyWhileInactive: boolean;
	private sandboxIsPaused = false;

	// Per-run state — created fresh in run(), cleared in finally.
	private currentRunAbort?: AbortController;
	private currentInputBuffer?: AsyncEventBuffer<string>;
	private currentRunStreaming = false;

	constructor(
		private readonly config: NormalizedAgentSessionConfig,
		private readonly adapter: HarnessAdapter,
		sandbox: RunnerSandbox,
		private readonly callbacks: RuntimeCallbacks = {},
	) {
		super();
		this.sessionId = config.sessionId;
		this.harness = adapter.kind;
		this.events = this.eventBuffer;
		this.sandbox = sandbox;
		this.sessionStateDir = join(
			resolveAgentSessionsRoot(config.agentSessionsRoot),
			this.sessionId,
		);
		this.destroyWhileInactive =
			Boolean(config.sandbox.destroyWhileInactive) &&
			config.sandbox.provider === "daytona";
	}

	/**
	 * Resume the sandbox if it was paused after a previous run.
	 * No-op on first run (sandbox is freshly created and running) and
	 * when destroyWhileInactive is off.
	 */
	private async resumeSandboxIfApplicable(): Promise<void> {
		if (!this.destroyWhileInactive) return;
		if (!this.sandboxIsPaused) return;
		const native = tryNativeDaytonaSandbox(this.sandbox);
		if (!native) {
			await this.emitEvent(
				this.createEvent("sandbox.resume.skipped", {
					reason: "no native start/stop on sandbox (provider not Daytona?)",
				}),
			);
			return;
		}
		await this.emitEvent(this.createEvent("sandbox.resume.started", {}));
		const t0 = Date.now();
		await native.start();
		this.sandboxIsPaused = false;
		await this.emitEvent(
			this.createEvent("sandbox.resume.completed", {
				durationMs: Date.now() - t0,
			}),
		);
	}

	/**
	 * Pause the sandbox between runs so the operator stops paying for
	 * idle compute. State on disk inside the sandbox is preserved.
	 */
	private async pauseSandboxIfApplicable(): Promise<void> {
		if (!this.destroyWhileInactive) return;
		if (this.sandboxIsPaused) return;
		const native = tryNativeDaytonaSandbox(this.sandbox);
		if (!native) return;
		await this.emitEvent(this.createEvent("sandbox.pause.started", {}));
		const t0 = Date.now();
		try {
			await native.stop();
			this.sandboxIsPaused = true;
			await this.emitEvent(
				this.createEvent("sandbox.pause.completed", {
					durationMs: Date.now() - t0,
				}),
			);
		} catch (err) {
			await this.emitEvent(
				this.createEvent("sandbox.pause.failed", {
					error: err instanceof Error ? err.message : String(err),
				}),
			);
		}
	}

	/**
	 * Run one turn of the harness. First call materializes files/folders/
	 * repos and runs setup commands; subsequent calls skip all of that and
	 * invoke the harness with its resume flag so it continues the prior
	 * conversation from the session's persistent state backing.
	 */
	async run(userPrompt: string): Promise<AgentSessionResult> {
		const turnIndex = this.turnCount;
		const continueSession = turnIndex > 0;

		const abortCtrl = new AbortController();
		const inputBuffer = new AsyncEventBuffer<string>();
		this.currentRunAbort = abortCtrl;
		this.currentInputBuffer = inputBuffer;

		const eventStartIndex = this.observedEvents.length;
		const startedAt = Date.now();
		let runStopped = false;

		try {
			// destroyWhileInactive mode: resume the sandbox if we paused it
			// after a previous run. State on disk (incl. `~/.claude/`)
			// persists across stop/start so this is cheap and Claude's
			// `--continue` still finds the prior session.
			await this.resumeSandboxIfApplicable();

			if (!this.materializationDone) {
				await this.ensureSessionStateDir();
				await this.materializeFiles();
				await this.materializeFolders();
				await this.materializeRepositories();
				await this.materializePlugins();
				await this.runSetupCommands();
				this.materializationDone = true;
			}

			const command = this.adapter.buildCommand(this.config, {
				userPrompt,
				continueSession,
				pluginOutputs: {
					claudePluginDirs: this.pluginOutputs.claudePluginDirs,
					claudeMcpConfigPath: this.pluginOutputs.claudeMcpConfigPath,
					cursorHasMcpServers: this.pluginOutputs.cursorHasMcpServers,
					codexConfigOverrides: this.pluginOutputs.codexConfigOverrides,
					codexHomeOverride: this.pluginOutputs.codexHomeOverride,
				},
			});
			const fullCommand = [
				command.command,
				...command.args.map(shellQuote),
			].join(" ");
			// HOME defaults to the sandbox's natural HOME (host's real one
			// for local; /home/daytona inside Daytona), so Claude's
			// `~/.claude/` is naturally visible / survives stop/start.
			// Codex is the exception: skill discovery is rooted at
			// `$HOME/.agents/skills/` (verified empirically), so when the
			// codex materializer wrote skills to a per-session HOME root,
			// we need to override HOME in the harness env for codex to
			// see them.
			const codexHomeOverride: Record<string, string> =
				this.harness === "codex" && this.pluginOutputs.codexHomeOverride
					? { HOME: this.pluginOutputs.codexHomeOverride }
					: {};
			const env: Record<string, string> = {
				...codexHomeOverride,
				...this.config.env,
				...(command.env ?? {}),
				...this.materializeSecrets(),
			};
			const cwd = this.config.sandbox.workingDirectory;

			const canStream =
				typeof this.sandbox.streamCommand === "function" &&
				this.sandbox.capabilities.streamingProcess === true;

			let exitCode: number;
			if (canStream) {
				this.currentRunStreaming = true;
				const stdoutSplitter = new LineSplitter();
				const stderrSplitter = new LineSplitter();
				const inputIterable = this.config.interactiveInput
					? inputBuffer
					: undefined;
				const result = await this.sandbox.streamCommand!(fullCommand, {
					cwd,
					env,
					signal: abortCtrl.signal,
					input: inputIterable,
					onStdout: (chunk) => {
						stdoutSplitter.push(chunk, (line) => {
							const event = this.adapter.parseStdoutLine(line, {
								sessionId: this.sessionId,
								harness: this.harness,
							});
							if (event) void this.emitEvent(event);
						});
					},
					onStderr: (chunk) => {
						stderrSplitter.push(chunk, (line) => {
							const event = this.adapter.parseStderrLine?.(line, {
								sessionId: this.sessionId,
								harness: this.harness,
							});
							if (event) void this.emitEvent(event);
						});
					},
				});
				stdoutSplitter.flush((line) => {
					const event = this.adapter.parseStdoutLine(line, {
						sessionId: this.sessionId,
						harness: this.harness,
					});
					if (event) void this.emitEvent(event);
				});
				stderrSplitter.flush((line) => {
					const event = this.adapter.parseStderrLine?.(line, {
						sessionId: this.sessionId,
						harness: this.harness,
					});
					if (event) void this.emitEvent(event);
				});
				exitCode = result.exitCode;
			} else {
				const result = await this.sandbox.runCommand(fullCommand, { cwd, env });
				await this.parseBufferedOutput(result.stdout, "stdout");
				await this.parseBufferedOutput(result.stderr, "stderr");
				exitCode = result.exitCode;
			}

			runStopped = abortCtrl.signal.aborted;
			this.turnCount += 1;

			const turnEvents = this.observedEvents.slice(eventStartIndex);
			return {
				sessionId: this.sessionId,
				harness: this.harness,
				success: exitCode === 0 && !runStopped,
				exitCode,
				result: this.adapter.extractResult?.(turnEvents),
				events: turnEvents,
				destroy: () => this.destroy(),
			};
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const failedEvent = this.createEvent("error", {
				message: err.message,
				durationMs: Date.now() - startedAt,
			});
			await this.emitEvent(failedEvent);
			const turnEvents = this.observedEvents.slice(eventStartIndex);
			return {
				sessionId: this.sessionId,
				harness: this.harness,
				success: false,
				error: err,
				events: turnEvents,
				destroy: () => this.destroy(),
			};
		} finally {
			this.currentRunStreaming = false;
			inputBuffer.close();
			this.currentInputBuffer = undefined;
			this.currentRunAbort = undefined;
			// destroyWhileInactive: pause the sandbox so the operator stops
			// paying for idle compute. State on disk is preserved by Daytona
			// during stop, so the next run()'s resumeSandboxIfApplicable()
			// brings it back instantly with `--continue`-friendly state.
			await this.pauseSandboxIfApplicable();
		}
	}

	async addMessage(message: string): Promise<void> {
		this.queuedMessages.push(message);
		await this.emitEvent(this.createEvent("message.queued", { message }));
		// Route into the current run's stdin only when interactive input is on
		// AND a run is actively streaming. Outside a run, messages stay in
		// the queue (observable via getQueuedMessages()) — callers can drain
		// them or feed them to the next run() themselves.
		if (
			this.currentRunStreaming &&
			this.config.interactiveInput &&
			this.currentInputBuffer
		) {
			const wire = message.endsWith("\n") ? message : `${message}\n`;
			this.currentInputBuffer.push(wire);
		}
	}

	async interrupt(reason?: string): Promise<void> {
		await this.emitEvent(this.createEvent("interrupt.requested", { reason }));
	}

	async stop(reason?: string): Promise<void> {
		// Per-run cancel only. Does NOT destroy the sandbox or close the
		// session-wide event stream — those live until destroy().
		if (!this.currentRunAbort) return;
		await this.emitEvent(this.createEvent("stop.requested", { reason }));
		this.currentRunAbort.abort();
		this.currentInputBuffer?.close();
	}

	async destroy(): Promise<void> {
		// If a run is still in flight, cancel it first so the harness exits.
		if (this.currentRunAbort) {
			await this.stop("destroy");
		}
		// If we paused the sandbox after the last run, resume it briefly
		// so the syncFoldersBack walk has something to read from.
		await this.resumeSandboxIfApplicable();
		await this.syncFoldersBack();
		await this.destroySandboxOnce();
		this.eventBuffer.close();
	}

	/**
	 * Idempotent sandbox teardown. Backs both `AgentSession.destroy()` and
	 * `AgentSessionResult.destroy()`, so callers can call either or both
	 * without double-destroying the underlying sandbox.
	 */
	private async destroySandboxOnce(): Promise<void> {
		if (this.sandboxDestroyed) return;
		if (this.sandboxDestroyPromise) {
			await this.sandboxDestroyPromise;
			return;
		}
		this.sandboxDestroyPromise = (async () => {
			try {
				await this.sandbox.destroy();
			} finally {
				this.sandboxDestroyed = true;
			}
		})();
		await this.sandboxDestroyPromise;
	}

	getQueuedMessages(): readonly string[] {
		return this.queuedMessages;
	}

	/**
	 * Snapshot of every event observed so far on this session, in
	 * insertion order. See {@link AgentSession.transcript} for usage.
	 *
	 * Returns a fresh copy of the internal buffer so callers can't
	 * accidentally mutate session state.
	 */
	transcript(): readonly TranscriptEvent[] {
		return [...this.observedEvents];
	}

	private async parseBufferedOutput(
		output: string,
		stream: "stdout" | "stderr",
	): Promise<void> {
		for (const line of output.split(/\r?\n/)) {
			if (!line.trim()) {
				continue;
			}
			const event =
				stream === "stdout"
					? this.adapter.parseStdoutLine(line, {
							sessionId: this.sessionId,
							harness: this.harness,
						})
					: this.adapter.parseStderrLine?.(line, {
							sessionId: this.sessionId,
							harness: this.harness,
						});
			if (event) {
				await this.emitEvent(event);
			}
		}
	}

	private createEvent(kind: string, raw: unknown): TranscriptEvent {
		return {
			sessionId: this.sessionId,
			harness: this.harness,
			timestamp: new Date().toISOString(),
			kind,
			raw,
		};
	}

	private async emitEvent(event: TranscriptEvent): Promise<void> {
		this.observedEvents.push(event);
		this.eventBuffer.push(event);
		this.emit("transcript", event);
		await this.callbacks.onTranscriptEvent?.(event);
	}

	/**
	 * Ensure the per-session state-backing directory exists on the host.
	 * The harness process's HOME is set to this directory so that, for
	 * Claude / Codex / Gemini, the per-session `.claude` / `.codex` /
	 * `.gemini` subdir is isolated and resumable.
	 */
	private async ensureSessionStateDir(): Promise<void> {
		await mkdir(this.sessionStateDir, { recursive: true });
		// For each state directory the harness declares, pre-create it so
		// the harness CLI doesn't fail on first write to a missing parent.
		for (const rel of this.adapter.stateDirectories) {
			await mkdir(join(this.sessionStateDir, rel), { recursive: true });
		}
	}

	private async materializeFiles(): Promise<void> {
		for (const file of this.config.files ?? []) {
			await this.emitEvent(
				this.createEvent("file.write.started", {
					path: file.path,
					sensitive: file.sensitive ?? false,
				}),
			);
			await this.sandbox.filesystem.mkdir(dirname(file.path));
			await this.sandbox.filesystem.writeFile(file.path, file.content);
			await this.emitEvent(
				this.createEvent("file.write.completed", {
					path: file.path,
					bytes: file.content.length,
					content: file.sensitive ? "[redacted]" : file.content,
				}),
			);
		}
	}

	private async materializeFolders(): Promise<void> {
		for (const folder of this.config.folders ?? []) {
			const access = folder.access ?? "read";
			await this.emitEvent(
				this.createEvent("folder.materialize.started", {
					source: folder.source,
					mountPath: folder.mountPath,
					access,
					exclude: folder.exclude,
				}),
			);
			try {
				const result = await materializeFolderIntoSandbox(folder, this.sandbox);
				if (access === "readwrite") {
					this.folderLedger.set(folder, result.filesWritten);
				}
				await this.emitEvent(
					this.createEvent("folder.materialize.completed", {
						source: folder.source,
						mountPath: folder.mountPath,
						access,
						filesWritten: result.filesWritten.length,
						bytes: result.bytes,
					}),
				);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("folder.materialize.failed", {
						source: folder.source,
						mountPath: folder.mountPath,
						access,
						error: err.message,
					}),
				);
				throw err;
			}
		}
	}

	private async materializeRepositories(): Promise<void> {
		const env = {
			...this.config.env,
			...this.materializeSecrets(),
		};
		for (const repo of this.config.repositories ?? []) {
			const access = repo.access ?? "readwrite";
			await this.emitEvent(
				this.createEvent("repository.materialize.started", {
					source: repo.source,
					mountPath: repo.mountPath,
					branch: repo.branch,
					access,
					depth: repo.depth,
				}),
			);
			try {
				const result = await materializeRepositoryIntoSandbox(
					repo,
					this.sandbox,
					env,
				);
				await this.emitEvent(
					this.createEvent("repository.materialize.completed", {
						source: repo.source,
						mountPath: repo.mountPath,
						branch: repo.branch,
						access,
						depth: result.depth,
						resolvedSource: result.resolvedSource,
					}),
				);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("repository.materialize.failed", {
						source: repo.source,
						mountPath: repo.mountPath,
						branch: repo.branch,
						access,
						error: err.message,
					}),
				);
				throw err;
			}
		}
	}

	private async materializePlugins(): Promise<void> {
		const plugins = this.config.plugins ?? [];
		if (plugins.length === 0) return;

		// Per-harness root paths inside the sandbox.
		const workspaceRoot = this.config.sandbox.workingDirectory ?? "/";
		const claudePluginsRoot = `${workspaceRoot.replace(/\/$/, "")}/.cyrus-plugins`;
		// Codex skills live at $HOME/.agents/skills/. For local provider use
		// a per-session tmp HOME so we don't trample the user's real one;
		// for remote sandboxes use the sandbox's natural home (/home/daytona)
		// which is isolated by being a fresh container.
		const codexHomeRoot =
			this.config.sandbox.provider === "local"
				? this.sessionStateDir
				: workspaceRoot;

		for (const input of plugins) {
			const plugin = await resolvePlugin(input);
			await this.emitEvent(
				this.createEvent("plugin.materialize.started", {
					name: plugin.name,
					harness: this.harness,
				}),
			);
			try {
				if (this.harness === "claude") {
					const out = await materializePluginForClaude(
						plugin,
						this.sandbox,
						claudePluginsRoot,
					);
					this.pluginOutputs.claudePluginDirs.push(out.pluginDir);
					if (out.mcpConfigPath) {
						this.pluginOutputs.claudeMcpConfigPath = out.mcpConfigPath;
					}
					await this.emitEvent(
						this.createEvent("plugin.materialize.completed", {
							name: plugin.name,
							harness: "claude",
							pluginDir: out.pluginDir,
							filesWritten: out.filesWritten.length,
						}),
					);
				} else if (this.harness === "cursor") {
					const out = await materializePluginForCursor(
						plugin,
						this.sandbox,
						workspaceRoot,
					);
					this.pluginOutputs.cursorHasMcpServers =
						this.pluginOutputs.cursorHasMcpServers || out.hasMcpServers;
					await this.emitEvent(
						this.createEvent("plugin.materialize.completed", {
							name: plugin.name,
							harness: "cursor",
							filesWritten: out.filesWritten.length,
						}),
					);
				} else if (this.harness === "codex") {
					const out = await materializePluginForCodex(
						plugin,
						this.sandbox,
						codexHomeRoot,
					);
					this.pluginOutputs.codexConfigOverrides.push(
						...out.cliConfigOverrides,
					);
					this.pluginOutputs.codexHomeOverride = out.homeOverride;
					await this.emitEvent(
						this.createEvent("plugin.materialize.completed", {
							name: plugin.name,
							harness: "codex",
							configOverrides: out.cliConfigOverrides.length,
							filesWritten: out.filesWritten.length,
						}),
					);
				} else {
					await this.emitEvent(
						this.createEvent("plugin.materialize.skipped", {
							name: plugin.name,
							harness: this.harness,
							reason: "no materializer for this harness",
						}),
					);
				}
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("plugin.materialize.failed", {
						name: plugin.name,
						harness: this.harness,
						error: err.message,
					}),
				);
				throw err;
			}
		}
	}

	private async syncFoldersBack(): Promise<void> {
		for (const [folder, originalFiles] of this.folderLedger.entries()) {
			await this.emitEvent(
				this.createEvent("folder.syncback.started", {
					source: folder.source,
					mountPath: folder.mountPath,
				}),
			);
			try {
				const result = await syncFolderBackToHost(
					folder,
					this.sandbox,
					originalFiles,
				);
				await this.emitEvent(
					this.createEvent("folder.syncback.completed", {
						source: folder.source,
						mountPath: folder.mountPath,
						filesWritten: result.filesWritten.length,
						bytes: result.bytes,
					}),
				);
			} catch (error) {
				const err = error instanceof Error ? error : new Error(String(error));
				await this.emitEvent(
					this.createEvent("folder.syncback.failed", {
						source: folder.source,
						mountPath: folder.mountPath,
						error: err.message,
					}),
				);
				// Sync-back failures are non-fatal — the agent's work in-sandbox
				// already completed; we surface the error in the transcript and
				// keep going.
			}
		}
		this.folderLedger.clear();
	}

	private async runSetupCommands(): Promise<void> {
		const commands = [
			...(this.config.packages?.system?.map(
				(pkg) => `apt-get update && apt-get install -y ${shellQuote(pkg)}`,
			) ?? []),
			...(this.config.packages?.npm?.map(
				(pkg) => `npm install -g ${shellQuote(pkg)}`,
			) ?? []),
			...(this.config.packages?.commands ?? []),
		];

		for (const setupCommand of commands) {
			await this.emitEvent(
				this.createEvent("setup.started", { command: setupCommand }),
			);
			const result = await this.sandbox.runCommand(setupCommand, {
				cwd: this.config.sandbox.workingDirectory,
				env: {
					...this.config.env,
					...this.materializeSecrets(),
				},
			});
			await this.emitEvent(
				this.createEvent("setup.completed", {
					command: setupCommand,
					exitCode: result.exitCode,
					stdout: result.stdout,
					stderr: result.stderr,
				}),
			);
			if (result.exitCode !== 0) {
				throw new Error(
					`Setup command failed with exit code ${result.exitCode}: ${setupCommand}`,
				);
			}
		}
	}

	private materializeSecrets(): Record<string, string> {
		const entries = Object.entries(this.config.secrets).map(([key, secret]) => [
			key,
			secret.value,
		]);
		return Object.fromEntries(entries);
	}
}

function shellQuote(value: string): string {
	if (/^[A-Za-z0-9_./:=@+-]+$/.test(value)) {
		return value;
	}
	return `'${value.replaceAll("'", "'\\''")}'`;
}
