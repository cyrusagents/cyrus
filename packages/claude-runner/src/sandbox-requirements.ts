import { spawnSync } from "node:child_process";
import type { ILogger } from "miko-core";

/**
 * A single failed sandbox requirement, with user-facing guidance
 * for how to fix the underlying issue.
 */
export interface SandboxRequirementFailure {
	/** Short identifier for the failed check (e.g., "socat", "bubblewrap", "bwrap-sandbox"). */
	check: string;
	/** Human-readable description of what failed. */
	message: string;
	/** Multi-line instructions explaining how to resolve the failure. */
	resolution: string;
}

/** Result of running the Linux sandbox requirements check. */
export interface SandboxRequirementsResult {
	/**
	 * True when the host platform is supported and sandbox mode is safe to enable.
	 * Non-Linux platforms (macOS, Windows) always return `supported: true` because
	 * the Claude Code SDK does not require bubblewrap on those systems.
	 */
	supported: boolean;
	/** Platform the check ran against — useful for diagnostics and testing. */
	platform: NodeJS.Platform;
	/** All failed checks (empty when `supported` is true). */
	failures: SandboxRequirementFailure[];
}

// Memoize the check at the module level so we only probe the system once per
// process, and we only log guidance to the user on the first probe.
let cachedResult: SandboxRequirementsResult | undefined;
let hasLoggedFailures = false;

/**
 * Verify that the host Linux system has the packages and kernel/AppArmor
 * configuration required by the Claude Code SDK sandbox runtime.
 *
 * Setting `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` in the SDK's child process env
 * causes the SDK to run tooling under a bubblewrap-backed sandbox on Linux.
 * If the host is missing `socat`, `bubblewrap`, or cannot create an
 * unprivileged user namespace, those tool invocations will fail at runtime.
 *
 * This check returns a structured result so the caller can decide whether to
 * set the env var, and prints resolution guidance to stdout on the first
 * failed check so users running locally can self-diagnose.
 *
 * The result is cached per process; tests can use
 * {@link resetSandboxRequirementsCacheForTesting} to reset it.
 */
export function checkLinuxSandboxRequirements(): SandboxRequirementsResult {
	if (cachedResult !== undefined) {
		return cachedResult;
	}

	const platform = process.platform;

	// Only Linux hosts need the bubblewrap-based runtime checks. On macOS and
	// Windows the SDK uses platform-native sandboxing (or no sandbox at all),
	// so there is nothing to verify here.
	if (platform !== "linux") {
		cachedResult = { supported: true, platform, failures: [] };
		return cachedResult;
	}

	const failures: SandboxRequirementFailure[] = [];

	if (!isCommandAvailable("socat")) {
		failures.push({
			check: "socat",
			message: "`socat` is not installed or not on PATH.",
			resolution: [
				"Install socat using your package manager:",
				"  Debian/Ubuntu:  sudo apt-get install -y socat",
				"  Fedora/RHEL:    sudo dnf install -y socat",
				"  Alpine:         sudo apk add socat",
			].join("\n"),
		});
	}

	const bwrapAvailable = isCommandAvailable("bwrap");
	if (!bwrapAvailable) {
		failures.push({
			check: "bubblewrap",
			message: "`bwrap` (bubblewrap) is not installed or not on PATH.",
			resolution: [
				"Install bubblewrap using your package manager:",
				"  Debian/Ubuntu:  sudo apt-get install -y bubblewrap",
				"  Fedora/RHEL:    sudo dnf install -y bubblewrap",
				"  Alpine:         sudo apk add bubblewrap",
			].join("\n"),
		});
	} else {
		const sandboxProbe = runBwrapSandboxProbe();
		if (!sandboxProbe.ok) {
			failures.push({
				check: "bwrap-sandbox",
				message: `bubblewrap cannot create an unprivileged user namespace: ${sandboxProbe.reason}`,
				resolution: buildBwrapSandboxResolution(),
			});
		}
	}

	const result: SandboxRequirementsResult = {
		supported: failures.length === 0,
		platform,
		failures,
	};
	cachedResult = result;
	return result;
}

/**
 * Log requirement failures as WARN-level messages via the dedicated logger.
 * The warnings are emitted at most once per process; subsequent calls are
 * no-ops regardless of which logger instance is passed.
 */
export function logSandboxRequirementFailures(
	result: SandboxRequirementsResult,
	logger: ILogger,
): void {
	if (result.supported || hasLoggedFailures) {
		return;
	}
	hasLoggedFailures = true;

	logger.warn(
		"Linux sandbox requirements are not met — skipping CLAUDE_CODE_SUBPROCESS_ENV_SCRUB.",
	);
	logger.warn(
		"Claude sessions will continue, but subprocess env scrubbing will be disabled until these are resolved:",
	);

	for (const failure of result.failures) {
		const resolutionBlock = failure.resolution
			.split("\n")
			.map((line) => `      ${line}`)
			.join("\n");
		logger.warn(`  [${failure.check}] ${failure.message}\n${resolutionBlock}`);
	}
}

/**
 * Reset the cached requirements result and the "already logged" flag.
 * Intended for use in unit tests only.
 */
export function resetSandboxRequirementsCacheForTesting(): void {
	cachedResult = undefined;
	hasLoggedFailures = false;
}

function isCommandAvailable(command: string): boolean {
	// `command -v` is a POSIX builtin, so we invoke it through /bin/sh to avoid
	// depending on `which` being installed (it is not present on some minimal
	// container images). `spawnSync` with an argv array avoids shell-injection
	// risk even though `command` is a fixed string.
	const probe = spawnSync("/bin/sh", ["-c", `command -v ${command}`], {
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return probe.status === 0 && (probe.stdout?.trim().length ?? 0) > 0;
}

interface BwrapProbeResult {
	ok: boolean;
	reason: string;
}

function runBwrapSandboxProbe(): BwrapProbeResult {
	// Mirror the command from the CYPACK-1091 spec but execute `true` instead
	// of `ip addr`. We only care whether bwrap can construct the namespace; we
	// do not need to observe the network state inside it, and `ip` may not be
	// installed on every host.
	const probe = spawnSync(
		"bwrap",
		[
			"--ro-bind",
			"/",
			"/",
			"--proc",
			"/proc",
			"--dev",
			"/dev",
			"--unshare-user",
			"--unshare-pid",
			"--unshare-net",
			"--",
			"true",
		],
		{
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
			timeout: 10_000,
		},
	);

	if (probe.error) {
		return { ok: false, reason: probe.error.message };
	}
	if (probe.status === 0) {
		return { ok: true, reason: "" };
	}

	const stderr = probe.stderr?.trim();
	const firstStderrLine =
		stderr && stderr.length > 0 ? stderr.split("\n")[0] : undefined;
	const reason =
		firstStderrLine ?? `bwrap exited with status ${probe.status ?? "unknown"}`;
	return { ok: false, reason };
}

function buildBwrapSandboxResolution(): string {
	return [
		"1. Ensure unprivileged user namespaces are enabled:",
		"     sysctl kernel.unprivileged_userns_clone   # should print 1",
		"     sudo sysctl -w kernel.unprivileged_userns_clone=1",
		"",
		"2. On AppArmor-enabled hosts (e.g. Ubuntu 24.04+), install an",
		"   unconfined profile for bwrap:",
		"",
		"     sudo tee /etc/apparmor.d/usr.bin.bwrap >/dev/null <<'EOF'",
		"     abi <abi/4.0>,",
		"     include <tunables/global>",
		"",
		"     /usr/bin/bwrap flags=(unconfined) {",
		"       userns,",
		"       network,",
		"     }",
		"     EOF",
		"     sudo apparmor_parser -r /etc/apparmor.d/usr.bin.bwrap",
		"",
		"   (network is not required today but will be once network sandboxing lands.)",
	].join("\n");
}
