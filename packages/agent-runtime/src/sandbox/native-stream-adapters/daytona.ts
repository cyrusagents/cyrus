import type {
	CommandExecutionResult,
	SandboxStreamCommandOptions,
} from "../../types.js";
import type { NativeStreamAdapter } from "./types.js";

/**
 * Structural shape of the Daytona @daytonaio/sdk Sandbox.process surface we
 * need for live log streaming. Typed loosely so this package does not take a
 * hard dependency on @daytonaio/sdk.
 */
export interface DaytonaProcessShape {
	createSession(sessionId: string): Promise<void>;
	executeSessionCommand(
		sessionId: string,
		req: {
			command: string;
			runAsync?: boolean;
			suppressInputEcho?: boolean;
		},
		timeout?: number,
	): Promise<{ cmdId?: string }>;
	getSessionCommandLogs(
		sessionId: string,
		commandId: string,
		onStdout: (chunk: string) => void,
		onStderr: (chunk: string) => void,
	): Promise<void>;
	getSessionCommand(
		sessionId: string,
		commandId: string,
	): Promise<{ exitCode?: number }>;
	deleteSession(sessionId: string): Promise<void>;
	sendSessionCommandInput?(
		sessionId: string,
		commandId: string,
		data: string,
	): Promise<void>;
}

export interface DaytonaNativeSandboxShape {
	process: DaytonaProcessShape;
}

export function hasDaytonaProcessShape(
	instance: unknown,
): instance is DaytonaNativeSandboxShape {
	if (!instance || typeof instance !== "object") return false;
	const proc = (instance as { process?: unknown }).process;
	if (!proc || typeof proc !== "object") return false;
	const p = proc as Record<string, unknown>;
	return (
		typeof p.createSession === "function" &&
		typeof p.executeSessionCommand === "function" &&
		typeof p.getSessionCommandLogs === "function" &&
		typeof p.getSessionCommand === "function" &&
		typeof p.deleteSession === "function"
	);
}

/** Built-in adapter for Daytona via @daytonaio/sdk. */
export const daytonaStreamAdapter: NativeStreamAdapter = {
	name: "daytona",
	detect: hasDaytonaProcessShape,
	async streamCommand(instance, command, options) {
		if (!hasDaytonaProcessShape(instance)) {
			throw new Error(
				"daytonaStreamAdapter.streamCommand received a non-Daytona instance.",
			);
		}
		return runDaytonaStreamCommand(instance.process, command, options);
	},
};

async function runDaytonaStreamCommand(
	proc: DaytonaProcessShape,
	command: string,
	options: SandboxStreamCommandOptions,
): Promise<CommandExecutionResult> {
	const startedAt = Date.now();
	const sessionId = `agent-runtime-stream-${Date.now()}-${Math.random()
		.toString(36)
		.slice(2, 10)}`;

	// Compose env/cwd into the command string the same way ComputeSDK's
	// Daytona provider does — Daytona's session API doesn't accept these as
	// structured fields.
	let fullCommand = command;
	if (options.env && Object.keys(options.env).length > 0) {
		const envPrefix = Object.entries(options.env)
			.map(([k, v]) => `${k}=${shellQuote(v)}`)
			.join(" ");
		fullCommand = `${envPrefix} ${fullCommand}`;
	}
	if (options.cwd) {
		fullCommand = `cd ${shellQuote(options.cwd)} && ${fullCommand}`;
	}

	const abort = options.signal;
	const onAbort = () => {
		void proc.deleteSession(sessionId).catch(() => {});
	};

	await proc.createSession(sessionId);
	let stdoutBuffer = "";
	let stderrBuffer = "";
	let cmdId: string | undefined;
	let inputDrainer: Promise<void> | undefined;

	try {
		if (abort?.aborted) {
			throw new Error("Stream command aborted before start.");
		}
		abort?.addEventListener("abort", onAbort, { once: true });

		const started = await proc.executeSessionCommand(sessionId, {
			command: fullCommand,
			runAsync: true,
		});
		cmdId = started.cmdId;
		if (!cmdId) {
			throw new Error(
				"Daytona executeSessionCommand did not return a cmdId for streaming.",
			);
		}

		// Drain caller-supplied stdin chunks concurrently with the log stream.
		// We intentionally do not await this drainer at the end — the caller
		// (typically RuntimeAgentSession) owns the input iterable's lifetime
		// and closes it after the process exits. Awaiting here would deadlock
		// because the iterable is still open when the process exits.
		if (options.input) {
			if (!proc.sendSessionCommandInput) {
				throw new Error(
					"Daytona SDK does not expose sendSessionCommandInput — cannot route stdin chunks.",
				);
			}
			const cmdIdFinal = cmdId;
			const sendInput = proc.sendSessionCommandInput.bind(proc);
			inputDrainer = (async () => {
				for await (const chunk of options.input!) {
					if (abort?.aborted) return;
					try {
						await sendInput(sessionId, cmdIdFinal, chunk);
					} catch {
						// Process may have exited; subsequent writes will fail.
						return;
					}
				}
			})();
			inputDrainer.catch(() => {});
		}

		// This promise resolves when the remote command finishes and all logs
		// have been drained. Callbacks fire live as bytes arrive.
		await proc.getSessionCommandLogs(
			sessionId,
			cmdId,
			(chunk) => {
				stdoutBuffer += chunk;
				if (options.onStdout) {
					try {
						options.onStdout(chunk);
					} catch {
						// Caller-supplied callbacks must not break the run.
					}
				}
			},
			(chunk) => {
				stderrBuffer += chunk;
				if (options.onStderr) {
					try {
						options.onStderr(chunk);
					} catch {
						// Caller-supplied callbacks must not break the run.
					}
				}
			},
		);

		// Note: we intentionally do not await inputDrainer here — the caller
		// owns the input iterable's lifetime. See comment above.
		void inputDrainer;
		const final = await proc.getSessionCommand(sessionId, cmdId);
		return {
			stdout: stdoutBuffer,
			stderr: stderrBuffer,
			exitCode: final.exitCode ?? 0,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		abort?.removeEventListener("abort", onAbort);
		try {
			await proc.deleteSession(sessionId);
		} catch {
			// Session may already be gone; ignore.
		}
	}
}

function shellQuote(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
