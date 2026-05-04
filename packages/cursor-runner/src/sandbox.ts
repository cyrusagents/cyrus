// Translates the Cyrus / Claude `SandboxSettings` shape into the Cursor SDK's
// `.cursor/sandbox.json` schema (plus the env vars that need to be set on
// `process.env` so child shell tools inherit cert-trust + proxy hints).
//
// Cursor sandbox model summary (validated via learning tests on
// `@cursor/sdk@1.0.11`):
//   - `local.sandboxOptions: { enabled: true }` engages Apple Seatbelt on
//     macOS / Landlock+Bubblewrap on Linux via the bundled `cursorsandbox`
//     helper (auto-discovered from `@cursor/sdk-<platform>-<arch>`).
//   - Default policy `workspace_readwrite`: workspace + /tmp are writable,
//     filesystem-wide read is allowed, off-workspace writes blocked, network
//     blocked unless `.cursor/sandbox.json` allows hosts.
//   - `.cursor/sandbox.json` lets us extend the policy with extra
//     read/write paths and a deny-default network allowlist.
//
// Mapping from Claude `SandboxSettings`:
//   filesystem.allowWrite[]     -> additionalReadwritePaths
//   filesystem.allowRead[]      -> additionalReadonlyPaths
//   network.allowedDomains[]    -> networkPolicy.allow
//   network.deniedDomains[]     -> networkPolicy.deny
//   network.httpProxyPort       -> add 127.0.0.1 to allow + HTTP_PROXY env
//   network.socksProxyPort      -> add 127.0.0.1 to allow + ALL_PROXY env
//   egressCaCertPath            -> NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / ... env
//
// Limitations (Cursor SDK lacks per-path deny under workspace_readwrite,
// per-call filesystem hooks, etc.):
//   - filesystem.denyRead / denyWrite are accepted but not enforced.
//     Document via comments; rely on workspace_readwrite default + hook
//     helper for read-blocking sensitive paths.
//   - network.allowAllUnixSockets / allowMachLookup / allowLocalBinding:
//     not exposed by Cursor sandbox.json; default sandbox behavior applies.

import { resolve } from "node:path";

/**
 * Subset of `@anthropic-ai/claude-agent-sdk`'s `SandboxSettings` we know how
 * to translate. Defined locally (not imported) to avoid a hard dep on
 * cyrus-claude-runner — the EdgeWorker is the only consumer that originates
 * a SandboxSettings, and a structural type is enough.
 */
export interface CursorSandboxInput {
	enabled?: boolean;
	failIfUnavailable?: boolean;
	allowUnsandboxedCommands?: boolean;
	network?: {
		allowedDomains?: string[];
		deniedDomains?: string[];
		allowManagedDomainsOnly?: boolean;
		httpProxyPort?: number;
		socksProxyPort?: number;
	};
	filesystem?: {
		allowWrite?: string[];
		denyWrite?: string[];
		denyRead?: string[];
		allowRead?: string[];
	};
}

export interface CursorSandboxJson {
	type: "workspace_readwrite" | "workspace_readonly" | "insecure_none";
	additionalReadwritePaths: string[];
	additionalReadonlyPaths: string[];
	disableTmpWrite: boolean;
	enableSharedBuildCache: boolean;
	networkPolicy: {
		default: "allow" | "deny";
		allow: string[];
		deny: string[];
	};
}

export interface BuildSandboxArgs {
	workspace: string;
	sandboxSettings?: CursorSandboxInput;
	/** Path to a CA cert bundle for MITM TLS interception by the egress proxy. */
	egressCaCertPath?: string;
	/**
	 * Extra paths Cursor's sandbox should treat as read+write (e.g. attachments
	 * dir, additional repository paths in multi-repo issues). Workspace itself
	 * is implicit in `workspace_readwrite`; pass only the *extras*.
	 */
	additionalReadwritePaths?: string[];
}

/**
 * Returns the JSON document to write to `<workspace>/.cursor/sandbox.json`
 * when sandbox is enabled. Returns `null` when sandbox is disabled.
 */
export function buildCursorSandboxJson(
	args: BuildSandboxArgs,
): CursorSandboxJson | null {
	const { workspace, sandboxSettings, egressCaCertPath } = args;
	if (!sandboxSettings?.enabled) return null;

	const extraWrite = new Set<string>();
	const extraRead = new Set<string>();
	const allow = new Set<string>();
	const deny = new Set<string>();

	for (const p of args.additionalReadwritePaths ?? []) {
		if (p && resolve(p) !== resolve(workspace)) extraWrite.add(resolve(p));
	}

	const fs = sandboxSettings.filesystem;
	if (fs?.allowWrite) {
		for (const p of fs.allowWrite) {
			if (!p) continue;
			const abs = resolve(p);
			if (abs !== resolve(workspace)) extraWrite.add(abs);
		}
	}
	if (fs?.allowRead) {
		for (const p of fs.allowRead) {
			if (!p) continue;
			// "." is the workspace shorthand; ignore it because Cursor's
			// `workspace_readwrite` already grants workspace reads.
			if (p === ".") continue;
			extraRead.add(resolve(p));
		}
	}

	// Cursor's sandbox.json doesn't support denyRead/denyWrite under
	// workspace_readwrite. Documented limitation. (Hook-based per-path
	// reads can compensate when needed via `.cursor/hooks.json`.)

	const network = sandboxSettings.network;
	if (network?.allowedDomains)
		for (const d of network.allowedDomains) allow.add(d);
	if (network?.deniedDomains)
		for (const d of network.deniedDomains) deny.add(d);

	// When the Cyrus egress proxy is in use, child shell processes need to be
	// able to reach the loopback proxy port. Add 127.0.0.1 / ::1 to the
	// network allow-list so curl / npm / git can connect to it.
	if (
		typeof network?.httpProxyPort === "number" ||
		typeof network?.socksProxyPort === "number"
	) {
		allow.add("127.0.0.1");
		allow.add("::1");
		allow.add("localhost");
	}

	// Read access to the CA cert bundle path so child processes can read
	// it via NODE_EXTRA_CA_CERTS / SSL_CERT_FILE etc.
	if (egressCaCertPath) extraRead.add(resolve(egressCaCertPath));

	return {
		type: "workspace_readwrite",
		additionalReadwritePaths: [...extraWrite].sort(),
		additionalReadonlyPaths: [...extraRead].sort(),
		disableTmpWrite: false,
		enableSharedBuildCache: false,
		networkPolicy: {
			default: "deny",
			allow: [...allow].sort(),
			deny: [...deny].sort(),
		},
	};
}

/**
 * Returns the env vars to set on `process.env` (so child shell tools inherit
 * them) before invoking `agent.send`. These cover:
 *   - cert-trust env vars when an egress CA bundle is configured
 *   - HTTP_PROXY / HTTPS_PROXY / ALL_PROXY when the egress proxy is configured
 */
export function buildSandboxEnv(args: {
	sandboxSettings?: CursorSandboxInput;
	egressCaCertPath?: string;
}): Record<string, string> {
	const { sandboxSettings, egressCaCertPath } = args;
	const env: Record<string, string> = {};
	if (!sandboxSettings?.enabled) return env;

	if (egressCaCertPath) {
		env.NODE_EXTRA_CA_CERTS = egressCaCertPath; // Node.js (SDK, npm, etc.)
		env.SSL_CERT_FILE = egressCaCertPath; // OpenSSL (general fallback)
		env.GIT_SSL_CAINFO = egressCaCertPath; // Git HTTPS
		env.REQUESTS_CA_BUNDLE = egressCaCertPath; // Python requests
		env.PIP_CERT = egressCaCertPath; // pip
		env.CURL_CA_BUNDLE = egressCaCertPath; // curl (OpenSSL builds)
		env.CARGO_HTTP_CAINFO = egressCaCertPath; // Rust / cargo
		env.AWS_CA_BUNDLE = egressCaCertPath; // AWS CLI / boto3
		env.DENO_CERT = egressCaCertPath; // Deno
	}

	const network = sandboxSettings.network;
	if (typeof network?.httpProxyPort === "number") {
		const url = `http://127.0.0.1:${network.httpProxyPort}`;
		env.HTTP_PROXY = url;
		env.HTTPS_PROXY = url;
		env.http_proxy = url;
		env.https_proxy = url;
	}
	if (typeof network?.socksProxyPort === "number") {
		const url = `socks5://127.0.0.1:${network.socksProxyPort}`;
		env.ALL_PROXY = url;
		env.all_proxy = url;
	}

	return env;
}
