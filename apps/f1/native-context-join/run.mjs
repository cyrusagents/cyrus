// Disposable installed-runtime/native-Docker join against exact Hosted source.
// No worktree edits, runtime registration outside the fixture, or live providers.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [hostedArg, hostedSha, prefixArg, runtimeSha, evidenceArg] =
	process.argv.slice(2);
assert.ok(
	hostedArg && prefixArg && evidenceArg,
	"Usage: node run.mjs HOSTED_CHECKOUT HOSTED_SHA INSTALLED_PREFIX RUNTIME_SHA NEW_EVIDENCE_DIRECTORY",
);
assert.match(hostedSha ?? "", /^[a-f0-9]{40}$/);
assert.match(runtimeSha ?? "", /^[a-f0-9]{40}$/);
assert.match(process.env.CYRUS_F1_CODEX_IMAGE ?? "", /^sha256:[a-f0-9]{64}$/);
const hosted = resolve(hostedArg),
	prefix = resolve(prefixArg),
	evidence = resolve(evidenceArg);
const here = dirname(fileURLToPath(import.meta.url));
const work = await mkdtemp(join(tmpdir(), "cyrus-native-join-source-"));
await mkdir(evidence); // Do not overwrite a previous gate's evidence.
const run = (binary, args, options = {}) =>
	execFileSync(binary, args, { stdio: "inherit", ...options });
try {
	const archive = join(work, "source.tar"),
		frozen = join(work, "hosted");
	await mkdir(frozen);
	run("git", [
		"-C",
		hosted,
		"archive",
		"--format=tar",
		`--output=${archive}`,
		hostedSha,
	]);
	run("tar", ["-xf", archive, "-C", frozen]);
	// Use already installed dependencies; no install scripts or credential lookup.
	await symlink(join(hosted, "node_modules"), join(frozen, "node_modules"));
	await symlink(
		join(hosted, "apps/app/node_modules"),
		join(frozen, "apps/app/node_modules"),
	);
	const { copyFile } = await import("node:fs/promises");
	await copyFile(
		join(here, "hosted.fixture.mjs"),
		join(
			frozen,
			"apps/app/src/lib/customer-agents/cypack-native-join.test.mjs",
		),
	);
	await writeFile(
		join(evidence, "inputs.json"),
		JSON.stringify(
			{
				hostedSha,
				runtimeSha,
				image: process.env.CYRUS_F1_CODEX_IMAGE,
				combinedSources: process.env.CYRUS_NATIVE_JOIN_COMBINED === "1",
				workDetails: process.env.CYRUS_NATIVE_JOIN_WORK_DETAILS === "1",
				slackMessages: process.env.CYRUS_NATIVE_JOIN_SLACK_MESSAGES === "1",
				requireMcpTiming: process.env.CYRUS_NATIVE_JOIN_MCP_TIMING === "1",
				requireContextReadAuthority:
					process.env.CYRUS_NATIVE_JOIN_CONTEXT_READ_AUTHORITY === "1",
				requireLifecycleAuthority:
					process.env.CYRUS_NATIVE_JOIN_LIFECYCLE_AUTHORITY === "1",
				workRejectionScenario:
					process.env.CYRUS_NATIVE_JOIN_WORK_REJECTION === "1",
				toolRejectionScenario:
					process.env.CYRUS_NATIVE_JOIN_TOOL_REJECTION === "1",
				lostWriteAckScenario:
					process.env.CYRUS_NATIVE_JOIN_LOSE_WRITE_ACK !== "0",
				fixture:
					"Actual handlers/SQL/native Docker; synthetic model/provider checks and event outbox",
			},
			null,
			2,
		),
	);
	run("bun", ["--no-env-file", "tooling/test-customer-agents.mjs"], {
		cwd: frozen,
		env: {
			...process.env,
			CUSTOMER_TEST_FILE: "cypack-native-join.test.mjs",
			CYRUS_NATIVE_JOIN_DRIVER: join(here, "runtime-drive.mjs"),
			CYRUS_NATIVE_JOIN_PREFIX: prefix,
			CYRUS_NATIVE_JOIN_EVIDENCE: evidence,
			CYRUS_NATIVE_JOIN_HOSTED_SHA: hostedSha,
			CYRUS_NATIVE_JOIN_RUNTIME_SHA: runtimeSha,
		},
	});
} finally {
	await rm(work, { recursive: true, force: true });
}
