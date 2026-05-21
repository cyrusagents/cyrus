import { randomUUID } from "node:crypto";
import { getHarnessAdapter } from "./harnesses/index.js";
import { createSandboxProvider } from "./sandbox/index.js";
import { CreateAgentSessionConfigSchema } from "./schemas.js";
import { RuntimeAgentSession } from "./session.js";
import type {
	AgentSession,
	CreateAgentSessionConfig,
	HarnessAdapter,
	HarnessKind,
	NormalizedAgentSessionConfig,
	RuntimeCallbacks,
	RuntimeHarnessConfig,
	RuntimeSecret,
	RuntimeVolumeConfig,
	SandboxProvider,
} from "./types.js";

/**
 * Fixed in-sandbox mount point for harness state when the caller opts in to
 * `sandbox.persistentState`. Internal — never reaches the public API surface;
 * each adapter's {@link HarnessAdapter.buildStateEnv} joins a stable
 * subdirectory underneath, so multiple harnesses can share one binding.
 */
const PERSISTENT_STATE_MOUNT_PATH = "/var/cyrus/harness-state";

export interface CreateAgentRuntimeOptions<
	H extends HarnessKind = HarnessKind,
> {
	callbacks?: RuntimeCallbacks<H>;
	sandboxProviders?: Record<string, SandboxProvider>;
}

/**
 * Variant of `CreateAgentSessionConfig` whose `harness` field is
 * narrowed to a single `HarnessKind`, so `createAgentSession` can
 * infer `H` from the config the caller wrote.
 */
export type CreateAgentSessionConfigFor<H extends HarnessKind> = Omit<
	CreateAgentSessionConfig,
	"harness"
> & {
	harness: H | (RuntimeHarnessConfig & { kind: H });
};

export class AgentRuntime<H extends HarnessKind = HarnessKind> {
	constructor(private readonly options: CreateAgentRuntimeOptions<H> = {}) {}

	async createSession(
		config: CreateAgentSessionConfigFor<H>,
	): Promise<AgentSession<H>> {
		const normalized = applyPersistentState(
			normalizeConfig(config),
			getHarnessAdapter,
		);
		const adapter = getHarnessAdapter(normalized.harness.kind);
		const provider =
			this.options.sandboxProviders?.[normalized.sandbox.provider] ??
			createSandboxProvider(normalized.sandbox.provider);
		const sandbox = await provider.create(normalized.sandbox);
		// Internal RuntimeAgentSession is non-generic (it operates on the
		// loose union); narrow the public return via cast at this boundary
		// so callers get the typed handle without the implementation
		// having to thread the generic everywhere.
		return new RuntimeAgentSession(
			normalized,
			adapter,
			sandbox,
			this.options
				.callbacks as RuntimeCallbacks /* widen to default for impl */,
		) as unknown as AgentSession<H>;
	}
}

export function createAgentRuntime<H extends HarnessKind = HarnessKind>(
	options?: CreateAgentRuntimeOptions<H>,
): AgentRuntime<H> {
	return new AgentRuntime(options);
}

export async function createAgentSession<H extends HarnessKind = HarnessKind>(
	config: CreateAgentSessionConfigFor<H>,
	options?: CreateAgentRuntimeOptions<H>,
): Promise<AgentSession<H>> {
	return createAgentRuntime<H>(options).createSession(config);
}

export function normalizeConfig(
	config: CreateAgentSessionConfig,
): NormalizedAgentSessionConfig {
	const parsed = CreateAgentSessionConfigSchema.parse(
		config,
	) as CreateAgentSessionConfig;
	const harness = normalizeHarness(parsed.harness, parsed.model);
	const secrets = normalizeSecrets(parsed.secrets ?? {});
	return {
		...parsed,
		sessionId: parsed.sessionId ?? randomUUID(),
		harness,
		model: harness.model ?? parsed.model,
		env: parsed.env ?? {},
		secrets,
		sandbox: parsed.sandbox ?? {
			provider: "local",
			workingDirectory: process.cwd(),
		},
	};
}

function normalizeHarness(
	harness: CreateAgentSessionConfig["harness"],
	model?: string,
): RuntimeHarnessConfig {
	if (typeof harness === "string") {
		return { kind: harness, model };
	}
	return {
		...harness,
		model: harness.model ?? model,
	};
}

function normalizeSecrets(
	secrets: Record<string, RuntimeSecret | string>,
): Record<string, RuntimeSecret> {
	return Object.fromEntries(
		Object.entries(secrets).map(([key, secret]) => [
			key,
			typeof secret === "string" ? { value: secret, redact: true } : secret,
		]),
	);
}

/**
 * If `sandbox.persistentState` is set, attach the matching volume mount and
 * inject the harness-specific state-dir env vars the adapter declares via
 * {@link HarnessAdapter.buildStateEnv}. Both happen at this seam so consumers
 * don't deal with mount paths, subpaths, or `CLAUDE_CONFIG_DIR` / `CURSOR_DATA_DIR`
 * directly — they just hand us a volume + a bindingId.
 *
 * Caller-provided `volumes` and `env` win on conflict (we append/spread our
 * additions after them is wrong — we spread theirs LAST so the caller can
 * override the state env if they know what they're doing). No-op when:
 *   - the binding is unset
 *   - the adapter doesn't implement `buildStateEnv` (harnesses with no
 *     redirectable state dir)
 */
export function applyPersistentState(
	normalized: NormalizedAgentSessionConfig,
	getAdapter: (kind: HarnessKind) => HarnessAdapter,
): NormalizedAgentSessionConfig {
	const ps = normalized.sandbox.persistentState;
	if (!ps) return normalized;
	const adapter = getAdapter(normalized.harness.kind);
	if (!adapter.buildStateEnv) return normalized;

	const stateVolume: RuntimeVolumeConfig = {
		name: ps.volume.name,
		mountPath: PERSISTENT_STATE_MOUNT_PATH,
		subpath: ps.bindingId,
		source: ps.volume.source,
		kind: ps.volume.kind,
		readOnly: ps.volume.readOnly,
	};

	const stateEnv = adapter.buildStateEnv(PERSISTENT_STATE_MOUNT_PATH);

	return {
		...normalized,
		sandbox: {
			...normalized.sandbox,
			volumes: [...(normalized.sandbox.volumes ?? []), stateVolume],
		},
		env: { ...stateEnv, ...normalized.env },
	};
}
