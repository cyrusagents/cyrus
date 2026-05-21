import { spawn } from "node:child_process";
import {
	access,
	mkdir,
	readdir,
	readFile,
	rm,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type {
	CommandExecutionResult,
	RunnerSandbox,
	RunnerSandboxCapabilities,
	RuntimeSandboxConfig,
	SandboxFileEntry,
	SandboxFilesystem,
	SandboxProvider,
	SandboxRunCommandOptions,
	SandboxStreamCommandOptions,
} from "../types.js";

export const UNSUPPORTED_STREAMING_PROCESS_REASON =
	"Streaming processes are unsupported until provider-specific APIs are available.";

export const DEFAULT_RUNNER_SANDBOX_CAPABILITIES: RunnerSandboxCapabilities = {
	filesystem: true,
	runCommand: true,
	streamingProcess: false,
};

/**
 * Local execution is always stream-capable via Node's child_process.spawn.
 */
export const LOCAL_RUNNER_SANDBOX_CAPABILITIES: RunnerSandboxCapabilities = {
	filesystem: true,
	runCommand: true,
	streamingProcess: true,
};

export interface LocalSandboxProviderOptions {
	workingDirectory?: string;
	capabilities?: RunnerSandboxCapabilities;
}

export class LocalSandboxProvider implements SandboxProvider {
	readonly provider = "local";
	private readonly defaultWorkingDirectory: string;
	private readonly capabilities: RunnerSandboxCapabilities;

	constructor(options: LocalSandboxProviderOptions = {}) {
		this.defaultWorkingDirectory = resolve(
			options.workingDirectory ?? process.cwd(),
		);
		this.capabilities =
			options.capabilities ?? LOCAL_RUNNER_SANDBOX_CAPABILITIES;
	}

	async create(config: RuntimeSandboxConfig = { provider: "local" }) {
		const workingDirectory = resolve(
			config.workingDirectory ?? this.defaultWorkingDirectory,
		);
		await mkdir(workingDirectory, { recursive: true });
		return new LocalRunnerSandbox({
			sandboxId: config.id ?? "local",
			workingDirectory,
			capabilities: this.capabilities,
		});
	}
}

interface LocalRunnerSandboxOptions {
	sandboxId: string;
	workingDirectory: string;
	capabilities: RunnerSandboxCapabilities;
}

export class LocalRunnerSandbox implements RunnerSandbox {
	readonly provider = "local";
	readonly sandboxId: string;
	readonly workingDirectory: string;
	readonly capabilities: RunnerSandboxCapabilities;
	readonly filesystem: SandboxFilesystem;

	constructor(options: LocalRunnerSandboxOptions) {
		this.sandboxId = options.sandboxId;
		this.workingDirectory = options.workingDirectory;
		this.capabilities = options.capabilities;
		this.filesystem = new LocalSandboxFilesystem(this.workingDirectory);
	}

	async runCommand(
		command: string,
		options: SandboxRunCommandOptions = {},
	): Promise<CommandExecutionResult> {
		return runLocalCommand(command, this.workingDirectory, options);
	}

	async streamCommand(
		command: string,
		options: SandboxStreamCommandOptions = {},
	): Promise<CommandExecutionResult> {
		return runLocalCommand(command, this.workingDirectory, options, {
			onStdout: options.onStdout,
			onStderr: options.onStderr,
			signal: options.signal,
			input: options.input,
		});
	}

	async destroy() {
		return;
	}
}

export class LocalSandboxFilesystem implements SandboxFilesystem {
	constructor(private readonly workingDirectory: string) {}

	async readFile(path: string) {
		return readFile(this.resolvePath(path), "utf8");
	}

	async writeFile(path: string, content: string) {
		await writeFile(this.resolvePath(path), content);
	}

	async readdir(path: string): Promise<SandboxFileEntry[]> {
		const entries = await readdir(this.resolvePath(path), {
			withFileTypes: true,
		});
		return Promise.all(
			entries.map(async (entry) => {
				const childPath = this.resolvePath(join(path, entry.name));
				const entryStat = await stat(childPath);
				return {
					name: entry.name,
					type: entry.isDirectory() ? "directory" : "file",
					size: entryStat.size,
					modified: entryStat.mtime,
				};
			}),
		);
	}

	async mkdir(path: string) {
		await mkdir(this.resolvePath(path), { recursive: true });
	}

	async exists(path: string) {
		try {
			await access(this.resolvePath(path));
			return true;
		} catch {
			return false;
		}
	}

	async remove(path: string) {
		await rm(this.resolvePath(path), { recursive: true, force: true });
	}

	private resolvePath(path: string) {
		return isAbsolute(path) ? path : resolve(this.workingDirectory, path);
	}
}

interface LocalStreamHooks {
	onStdout?: (chunk: string) => void;
	onStderr?: (chunk: string) => void;
	signal?: AbortSignal;
	input?: AsyncIterable<string>;
}

function runLocalCommand(
	command: string,
	workingDirectory: string,
	options: SandboxRunCommandOptions,
	stream: LocalStreamHooks = {},
): Promise<CommandExecutionResult> {
	if (options.background) {
		return Promise.reject(
			new Error(
				"Background commands are not supported by LocalSandboxProvider.",
			),
		);
	}

	return new Promise((resolveCommand, reject) => {
		const startedAt = Date.now();
		// We always pipe stdout/stderr so we can capture + stream; stdin is
		// only piped when the caller supplies an input iterable. Either way,
		// child.stdout/stderr are guaranteed non-null below (asserted).
		const stdinMode: "ignore" | "pipe" = stream.input ? "pipe" : "ignore";
		const child = spawn(command, {
			cwd: options.cwd
				? resolveCommandCwd(workingDirectory, options.cwd)
				: workingDirectory,
			env: { ...process.env, ...options.env },
			shell: true,
			stdio: [stdinMode, "pipe", "pipe"],
		});
		const childStdout = child.stdout!;
		const childStderr = child.stderr!;

		let settled = false;
		let stdout = "";
		let stderr = "";
		let timeout: NodeJS.Timeout | undefined;
		let inputDrainer: Promise<void> | undefined;

		if (options.timeout !== undefined) {
			timeout = setTimeout(() => {
				child.kill("SIGTERM");
			}, options.timeout);
		}

		const onAbort = () => {
			child.kill("SIGTERM");
		};
		if (stream.signal) {
			if (stream.signal.aborted) {
				child.kill("SIGTERM");
			} else {
				stream.signal.addEventListener("abort", onAbort, { once: true });
			}
		}

		if (stream.input && child.stdin) {
			const stdin = child.stdin;
			const inputIterable = stream.input;
			inputDrainer = (async () => {
				try {
					for await (const chunk of inputIterable) {
						if (stream.signal?.aborted) return;
						if (!stdin.writable) return;
						stdin.write(chunk);
					}
				} catch {
					// Iterable errors close stdin below.
				} finally {
					try {
						stdin.end();
					} catch {
						// stdin may already be closed by the process exiting.
					}
				}
			})();
			// stdin errors should not crash the run.
			stdin.on("error", () => {});
		}

		childStdout.setEncoding("utf8");
		childStderr.setEncoding("utf8");
		childStdout.on("data", (chunk: string) => {
			stdout += chunk;
			if (stream.onStdout) {
				try {
					stream.onStdout(chunk);
				} catch {
					// Caller-supplied callbacks must not break the run; swallow.
				}
			}
		});
		childStderr.on("data", (chunk: string) => {
			stderr += chunk;
			if (stream.onStderr) {
				try {
					stream.onStderr(chunk);
				} catch {
					// Caller-supplied callbacks must not break the run; swallow.
				}
			}
		});
		child.on("error", (error) => {
			if (timeout) clearTimeout(timeout);
			stream.signal?.removeEventListener("abort", onAbort);
			if (!settled) {
				settled = true;
				reject(error);
			}
		});
		child.on("close", (exitCode) => {
			if (timeout) clearTimeout(timeout);
			stream.signal?.removeEventListener("abort", onAbort);
			if (!settled) {
				settled = true;
				// Resolve as soon as the child exits. The input drainer (if any)
				// is intentionally orphaned — the caller owns the input
				// iterable's lifetime and closes it after the command returns.
				// Awaiting it here would deadlock when the iterable outlives
				// the process.
				void inputDrainer;
				resolveCommand({
					stdout,
					stderr,
					exitCode: exitCode ?? 0,
					durationMs: Date.now() - startedAt,
				});
			}
		});
	});
}

function resolveCommandCwd(workingDirectory: string, cwd: string) {
	return isAbsolute(cwd) ? cwd : resolve(workingDirectory, cwd);
}

export function createLocalSandboxProvider(
	options?: LocalSandboxProviderOptions,
) {
	return new LocalSandboxProvider(options);
}
