// Run one bounded authenticated request against an installed runner package.
// This is deliberately separate from the mocked package-contract verifier:
// provider acceptance and real Read/Bash tool execution are required here.
//
// node scripts/verify-runner-runtime.mjs \
//   /tmp/consumer/node_modules/cyrus-claude-runner \
//   /tmp/consumer \
//   /path/to/runtime-provenance.json
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { verifyRuntimeProvenance } from "./verify-runner-provenance.mjs";
import { validateRuntimeReceipt } from "./verify-runner-runtime-receipt.mjs";

const packageRoot = resolve(
	process.argv[2] ?? assert.fail("Pass the installed runner package directory"),
);
const workingDirectory = resolve(
	process.argv[3] ?? assert.fail("Pass the clean consumer directory"),
);
const provenancePath = resolve(
	process.argv[4] ?? assert.fail("Pass the retained provenance JSON path"),
);
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
);
assert.equal(manifest.name, "cyrus-claude-runner");
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const { expected: provenance } = verifyRuntimeProvenance({
	packageRoot,
	provenancePath,
	sourceRoot,
	workingDirectory,
});

process.env.CYRUS_LOG_LEVEL = "ERROR";
const { ClaudeRunner } = await import(
	pathToFileURL(join(packageRoot, manifest.main)).href
);

const messages = [];
const callbackErrors = [];
let completed = false;
const runner = new ClaudeRunner({
	workingDirectory,
	cyrusHome: join(workingDirectory, ".cyrus-runtime-receipt"),
	model: "opus",
	fallbackModel: "sonnet",
	maxTurns: 5,
	tools: ["Read", "Bash"],
	allowedTools: ["Read", "Bash(pwd)"],
	disallowedTools: ["Edit", "Write", "NotebookEdit"],
	strictMcpConfig: true,
	onMessage: (message) => messages.push(message),
	onError: (error) => callbackErrors.push(error),
	onComplete: () => {
		completed = true;
	},
});

const prompt = [
	"You must complete exactly these steps in order:",
	"1. Use the Read tool to read ./package.json.",
	'2. Use the Bash tool in the foreground to run exactly "pwd" with timeout 10000.',
	"3. After both tool results, reply with exactly SDK_RUNTIME_OK and nothing else.",
	"Do not skip either tool even if the file contents or directory seem obvious.",
].join("\n");

const startedAt = Date.now();
let watchdog;
try {
	await Promise.race([
		runner.start(prompt),
		new Promise((_, reject) => {
			watchdog = setTimeout(() => {
				runner.stop();
				reject(new Error("Runtime receipt exceeded the 120-second watchdog"));
			}, 120_000);
		}),
	]);
} finally {
	clearTimeout(watchdog);
}

const result = messages.findLast((message) => message.type === "result");
const init = messages.find(
	(message) => message.type === "system" && message.subtype === "init",
);
const { bashResult, bashUse, readResult, readUse, text } =
	validateRuntimeReceipt(messages);

assert.deepEqual(
	callbackErrors.map((error) => error.message),
	[],
	"Runner emitted an error callback",
);
assert.match(
	String(readUse.input?.file_path ?? ""),
	/package\.json$/,
	"Read did not target package.json",
);
assert.equal(bashUse.input?.command, "pwd", "Bash command was not exactly pwd");
assert.equal(
	bashUse.input?.timeout,
	10_000,
	"Bash timeout was not exactly 10000",
);
assert.equal(
	bashUse.input?.run_in_background ?? false,
	false,
	"Bash ran in the background",
);
assert.ok(result, "Claude did not emit a terminal result");
assert.ok(init, "Claude did not emit an init message");
assert.equal(
	init.claude_code_version,
	provenance.installed.native.claudeCodeVersion,
	"Runtime initialized a different Claude Code version",
);
assert.equal(result.subtype, "success");
assert.equal(result.is_error, false);
assert.equal(text, "SDK_RUNTIME_OK");
assert.equal(completed, true, "Runner did not emit complete");
assert.equal(
	runner.isRunning(),
	false,
	"Runner remained active after completion",
);
assert.equal(runner.hasPendingWork(), false, "Runner retained pending work");
runner.stop();
assert.equal(runner.isRunning(), false, "Runner did not stop cleanly");

console.log(
	JSON.stringify(
		{
			status: "PASS",
			provenance: {
				commit: provenance.source.commit,
				pullRequest: `${provenance.source.repository}#${provenance.source.pullRequest}`,
				runnerTarballSha256: provenance.artifacts.runner.sha256,
				coreTarballSha256: provenance.artifacts.core.sha256,
				consumerLockSha256: provenance.artifacts.consumerLock.sha256,
				nativeExecutableSha256: provenance.installed.native.executableSha256,
			},
			package: `${manifest.name}@${manifest.version}`,
			installed: {
				agentSdk: `${provenance.installed.agentSdk.name}@${provenance.installed.agentSdk.version}`,
				apiSdk: `${provenance.installed.apiSdk.name}@${provenance.installed.apiSdk.version}`,
				native: `${provenance.installed.native.name}@${provenance.installed.native.version}`,
			},
			identity: {
				accountEmailSha256: provenance.identity.accountEmailSha256,
				apiProvider: provenance.identity.apiProvider,
				authMethod: provenance.identity.authMethod,
				osUser: provenance.identity.osUser,
				subscriptionType: provenance.identity.subscriptionType,
			},
			sessionId: runner.getSessionInfo()?.sessionId,
			claudeCodeVersion: init?.claude_code_version,
			model: result.modelUsage ? Object.keys(result.modelUsage) : undefined,
			elapsedMs: Date.now() - startedAt,
			read: {
				filePath: readUse.input.file_path,
				isError: readResult.is_error,
				resultReceived: true,
			},
			bash: {
				command: bashUse.input.command,
				timeout: bashUse.input.timeout,
				foreground: true,
				isError: bashResult.is_error,
				resultReceived: true,
			},
			finalText: text,
			result: {
				subtype: result.subtype,
				isError: result.is_error,
				numTurns: result.num_turns,
			},
			cleanStop: !runner.isRunning(),
		},
		null,
		2,
	),
);
