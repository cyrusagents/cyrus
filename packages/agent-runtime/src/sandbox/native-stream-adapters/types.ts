import type {
	CommandExecutionResult,
	SandboxStreamCommandOptions,
} from "../../types.js";

/**
 * Adapter that knows how to drive a native provider sandbox (the thing
 * returned from ComputeSDK's `ProviderSandbox.getInstance()`) using
 * provider-specific streaming primitives that ComputeSDK's universal
 * `runCommand` does not expose.
 *
 * Each adapter probes the native instance via {@link detect}; the first
 * adapter whose `detect()` returns `true` claims the sandbox and is used to
 * back {@link RunnerSandbox.streamCommand}.
 *
 * To add support for a new ComputeSDK provider, implement this interface and
 * pass it as `nativeStreamAdapters` on {@link ComputeSdkSandboxProviderOptions}.
 * Existing built-ins are exported from
 * `./native-stream-adapters/index.js`.
 *
 * TODO: built-in adapters to add as we validate them against real SDKs:
 *   - @e2b/sdk Sandbox     — has `commands.run({ onStdout, onStderr })` and
 *                             `sandbox.process.start()` returning a handle
 *                             with `sendInput`. Streaming-native.
 *   - @vercel/sandbox      — `sandbox.runCommand` streams via callbacks on
 *                             recent versions.
 *   - @blaxel/sandbox      — exposes a `Process` with stdout / stderr
 *                             observables.
 *   - @modal-labs/modal    — `Sandbox.exec().stdout.read_async()` chunked.
 *   - @railway/sandbox     — TBD.
 *   - @runloop/sandbox     — uses Devbox API with `process.exec` + log polling.
 *   - @cloudflare/sandbox  — Worker-based; HTTP streaming response.
 *   - @codesandbox/sdk     — shell session with output streams.
 *
 * See https://github.com/computesdk/compute for the canonical list of
 * providers.
 */
export interface NativeStreamAdapter {
	/** Stable name used in error messages and capability metadata. */
	readonly name: string;
	/**
	 * Structural type guard. Should return `true` only if `instance` is a
	 * native sandbox this adapter can drive. Implementations must be cheap
	 * and non-throwing.
	 */
	detect(instance: unknown): boolean;
	/**
	 * Stream a command. Implementations must:
	 *   - Invoke `options.onStdout(chunk)` and `options.onStderr(chunk)` as
	 *     bytes arrive (not buffered until exit).
	 *   - Honor `options.signal` (best-effort cancel).
	 *   - Drain `options.input` (if provided) into the process's stdin live.
	 *   - Resolve with the full buffered `CommandExecutionResult` once the
	 *     process exits.
	 */
	streamCommand(
		instance: unknown,
		command: string,
		options: SandboxStreamCommandOptions,
	): Promise<CommandExecutionResult>;
}
