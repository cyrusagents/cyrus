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
import { DEFAULT_RUNNER_SANDBOX_CAPABILITIES } from "./local.js";
import {
	BUILT_IN_NATIVE_STREAM_ADAPTERS,
	type NativeStreamAdapter,
	resolveNativeStreamAdapter,
} from "./native-stream-adapters/index.js";

// Re-export Daytona shape types so existing callers importing them from this
// module continue to work after the adapter refactor.
export {
	type DaytonaNativeSandboxShape,
	type DaytonaProcessShape,
	hasDaytonaProcessShape,
} from "./native-stream-adapters/daytona.js";

export interface ComputeSdkFilesystemLike {
	readFile?(path: string): Promise<string>;
	writeFile?(path: string, content: string): Promise<void>;
	readdir?(path: string): Promise<SandboxFileEntry[] | string[]>;
	mkdir?(path: string): Promise<void>;
	exists?(path: string): Promise<boolean>;
	remove?(path: string): Promise<void>;
	read?(path: string, options?: { encoding?: BufferEncoding }): Promise<string>;
	write?(path: string, content: string): Promise<void>;
	rm?(
		path: string,
		options?: { recursive?: boolean; force?: boolean },
	): Promise<void>;
}

export interface ComputeSdkSandboxLike {
	sandboxId?: string;
	id?: string;
	provider?: string;
	workingDirectory?: string;
	filesystem?: ComputeSdkFilesystemLike;
	fs?: ComputeSdkFilesystemLike;
	runCommand?(
		command: string,
		options?: SandboxRunCommandOptions,
	): Promise<Partial<CommandExecutionResult> | string>;
	/**
	 * ComputeSDK's `ProviderSandbox.getInstance()` escape hatch — returns the
	 * native provider sandbox (e.g. @daytonaio/sdk Sandbox). Used by
	 * {@link ComputeSdkRunnerSandbox.streamCommand} to access provider-specific
	 * streaming primitives that ComputeSDK's universal `runCommand` cannot
	 * expose.
	 */
	getInstance?(): unknown;
	destroy?(): Promise<void>;
	dispose?(): Promise<void>;
}

export interface ComputeSdkLike {
	sandbox?: {
		create(options?: Record<string, unknown>): Promise<ComputeSdkSandboxLike>;
		getById?(sandboxId: string): Promise<ComputeSdkSandboxLike | null>;
	};
}

export interface ComputeSdkSandboxProviderOptions {
	compute: ComputeSdkLike;
	capabilities?: RunnerSandboxCapabilities;
	/**
	 * User-supplied native-streaming adapters. Tried after the built-in
	 * adapters (currently Daytona only). Use this to add streaming support
	 * for ComputeSDK providers we don't ship a built-in for, e.g. E2B,
	 * Vercel, Blaxel, Modal, Railway, Runloop, Cloudflare, Codesandbox.
	 *
	 * Each adapter probes `ProviderSandbox.getInstance()` for a recognized
	 * native shape (see {@link NativeStreamAdapter}).
	 */
	nativeStreamAdapters?: readonly NativeStreamAdapter[];
}

export class ComputeSdkSandboxProvider implements SandboxProvider {
	readonly provider = "computesdk";

	constructor(private readonly options: ComputeSdkSandboxProviderOptions) {}

	async create(config: RuntimeSandboxConfig): Promise<RunnerSandbox> {
		const sandbox = config.id
			? ((await this.options.compute.sandbox?.getById?.(config.id)) ??
				(await this.createSandbox(config)))
			: await this.createSandbox(config);
		return new ComputeSdkRunnerSandbox(
			sandbox,
			this.options.capabilities ?? DEFAULT_RUNNER_SANDBOX_CAPABILITIES,
			config,
			this.options.nativeStreamAdapters,
		);
	}

	private async createSandbox(
		config: RuntimeSandboxConfig,
	): Promise<ComputeSdkSandboxLike> {
		if (!this.options.compute.sandbox?.create) {
			throw new Error("ComputeSDK provider requires compute.sandbox.create().");
		}
		return this.options.compute.sandbox.create({
			timeout: config.timeoutMs,
			templateId: config.templateId,
			snapshotId: config.snapshot,
			metadata: config.metadata,
			namespace: config.namespace,
			name: config.name,
			directory: config.workingDirectory,
			volumes: translateVolumes(config.volumes),
			networkEgress: config.networkEgress,
		});
	}
}

/**
 * Bridge our generic {@link RuntimeVolumeConfig} shape to the field names
 * provider-native SDKs expect. ComputeSDK's daytona wrapper destructures
 * known fields and spreads the rest straight into `@daytonaio/sdk`'s
 * `create({ volumes })`, which expects `volumeId` rather than `name` —
 * without translation, Daytona sees `volumeId: undefined` and throws
 * "Volume 'undefined' not found". We emit BOTH so other providers that
 * read `name` (e.g. fly machines, bind-mount providers) still see it.
 */
function translateVolumes(
	volumes: RuntimeSandboxConfig["volumes"],
): unknown[] | undefined {
	if (!volumes || volumes.length === 0) return undefined;
	return volumes.map((v) => ({ ...v, volumeId: v.name }));
}

export class ComputeSdkRunnerSandbox implements RunnerSandbox {
	readonly sandboxId: string;
	readonly provider: string;
	readonly workingDirectory?: string;
	readonly capabilities: RunnerSandboxCapabilities;
	readonly filesystem: SandboxFilesystem;
	private readonly streamAdapter?: NativeStreamAdapter;
	private readonly nativeInstance: unknown;

	constructor(
		private readonly sandbox: ComputeSdkSandboxLike,
		capabilities: RunnerSandboxCapabilities,
		config: RuntimeSandboxConfig,
		extraStreamAdapters?: readonly NativeStreamAdapter[],
	) {
		this.sandboxId = sandbox.sandboxId ?? sandbox.id ?? config.id ?? "compute";
		this.provider = sandbox.provider ?? config.provider;
		this.workingDirectory = sandbox.workingDirectory ?? config.workingDirectory;
		const filesystem = sandbox.filesystem ?? sandbox.fs;
		if (!filesystem) {
			throw new Error(
				"ComputeSDK sandbox does not expose filesystem operations.",
			);
		}
		this.filesystem = new ComputeSdkFilesystem(filesystem);

		// Probe the ComputeSDK escape hatch for a native sandbox a registered
		// adapter can drive. Today's built-ins recognize Daytona; users can
		// extend by passing extraStreamAdapters.
		this.nativeInstance = sandbox.getInstance?.();
		this.streamAdapter = resolveNativeStreamAdapter(
			this.nativeInstance,
			extraStreamAdapters,
		);
		this.capabilities = {
			...capabilities,
			streamingProcess:
				capabilities.streamingProcess || Boolean(this.streamAdapter),
		};
	}

	async runCommand(
		command: string,
		options?: SandboxRunCommandOptions,
	): Promise<CommandExecutionResult> {
		if (!this.sandbox.runCommand) {
			throw new Error("ComputeSDK sandbox does not expose runCommand().");
		}
		const startedAt = Date.now();
		const result = await this.sandbox.runCommand(command, options);
		if (typeof result === "string") {
			return {
				stdout: result,
				stderr: "",
				exitCode: 0,
				durationMs: Date.now() - startedAt,
			};
		}
		return {
			stdout: result.stdout ?? "",
			stderr: result.stderr ?? "",
			exitCode: result.exitCode ?? 0,
			durationMs: result.durationMs ?? Date.now() - startedAt,
		};
	}

	async streamCommand(
		command: string,
		options: SandboxStreamCommandOptions = {},
	): Promise<CommandExecutionResult> {
		if (!this.streamAdapter) {
			const builtIns = BUILT_IN_NATIVE_STREAM_ADAPTERS.map((a) => a.name).join(
				", ",
			);
			throw new Error(
				`ComputeSDK sandbox does not support streaming for provider "${this.provider}". ` +
					`No registered NativeStreamAdapter detected a streaming-capable native instance. ` +
					`Built-in adapters: ${builtIns}. Add support via ` +
					`ComputeSdkSandboxProviderOptions.nativeStreamAdapters.`,
			);
		}
		return this.streamAdapter.streamCommand(
			this.nativeInstance,
			command,
			options,
		);
	}

	async destroy(): Promise<void> {
		if (this.sandbox.destroy) {
			await this.sandbox.destroy();
			return;
		}
		await this.sandbox.dispose?.();
	}
}

class ComputeSdkFilesystem implements SandboxFilesystem {
	constructor(private readonly filesystem: ComputeSdkFilesystemLike) {}

	async readFile(path: string): Promise<string> {
		if (this.filesystem.readFile) {
			return this.filesystem.readFile(path);
		}
		if (this.filesystem.read) {
			return this.filesystem.read(path, { encoding: "utf8" });
		}
		throw new Error("ComputeSDK filesystem does not support readFile().");
	}

	async writeFile(path: string, content: string): Promise<void> {
		if (this.filesystem.writeFile) {
			await this.filesystem.writeFile(path, content);
			return;
		}
		if (this.filesystem.write) {
			await this.filesystem.write(path, content);
			return;
		}
		throw new Error("ComputeSDK filesystem does not support writeFile().");
	}

	async readdir(path: string): Promise<SandboxFileEntry[]> {
		if (!this.filesystem.readdir) {
			throw new Error("ComputeSDK filesystem does not support readdir().");
		}
		const entries = await this.filesystem.readdir(path);
		return entries.map((entry) => {
			return typeof entry === "string"
				? { name: entry, type: "file" as const }
				: entry;
		});
	}

	async mkdir(path: string): Promise<void> {
		if (!this.filesystem.mkdir) {
			throw new Error("ComputeSDK filesystem does not support mkdir().");
		}
		await this.filesystem.mkdir(path);
	}

	async exists(path: string): Promise<boolean> {
		if (this.filesystem.exists) {
			return this.filesystem.exists(path);
		}
		try {
			await this.readFile(path);
			return true;
		} catch {
			return false;
		}
	}

	async remove(path: string): Promise<void> {
		if (this.filesystem.remove) {
			await this.filesystem.remove(path);
			return;
		}
		if (this.filesystem.rm) {
			await this.filesystem.rm(path, { recursive: true, force: true });
			return;
		}
		throw new Error("ComputeSDK filesystem does not support remove().");
	}
}

export function createComputeSdkSandboxProvider(
	options: ComputeSdkSandboxProviderOptions,
): ComputeSdkSandboxProvider {
	return new ComputeSdkSandboxProvider(options);
}
