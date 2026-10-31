// Run one bounded authenticated request against an installed runner package.
// This is deliberately separate from the mocked package-contract verifier:
// provider acceptance and real Read/Bash tool execution are required here.
//
// node scripts/verify-runner-runtime.mjs \
//   /tmp/consumer/node_modules/cyrus-claude-runner \
//   /tmp/consumer
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { validateRuntimeMessages } from "./runner-runtime-receipt.mjs";

const packageRoot = resolve(
	process.argv[2] ?? assert.fail("Pass the installed runner package directory"),
);
const workingDirectory = resolve(
	process.argv[3] ?? assert.fail("Pass the clean consumer directory"),
);
const manifest = JSON.parse(
	readFileSync(join(packageRoot, "package.json"), "utf8"),
);
assert.equal(manifest.name, "cyrus-claude-runner");

for (const name of [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"CLAUDE_CODE_OAUTH_TOKEN",
	"ANTHROPIC_BASE_URL",
	"CLAUDE_CONFIG_DIR",
	"CLAUDE_CODE_USE_BEDROCK",
	"CLAUDE_CODE_USE_VERTEX",
	"CLAUDE_CODE_USE_FOUNDRY",
	"CLAUDE_CODE_USE_MANTLE",
]) {
	assert.equal(
		Object.hasOwn(process.env, name),
		false,
		`${name} would replace the intended existing Claude identity`,
	);
}

// Hash installed bytes, not a mutable package version or workspace symlink.
function packageIdentity(root) {
	assert.equal(
		realpathSync(root),
		root,
		"Use installed packages, not workspace links",
	);
	const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	const files = [];
	function walk(directory) {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
			(a, b) => a.name.localeCompare(b.name, "en"),
		)) {
			if (entry.name === "node_modules") continue;
			const path = join(directory, entry.name);
			if (entry.isDirectory()) walk(path);
			else {
				assert.ok(entry.isFile(), "Installed package contains a symlink");
				files.push([
					relative(root, path),
					createHash("sha256").update(readFileSync(path)).digest("hex"),
				]);
			}
		}
	}
	walk(root);
	return {
		name: manifest.name,
		version: manifest.version,
		filesSha256: createHash("sha256")
			.update(JSON.stringify(files))
			.digest("hex"),
	};
}
const requireFromRunner = createRequire(join(packageRoot, "package.json"));
const coreRoot = dirname(dirname(requireFromRunner.resolve("cyrus-core")));
const sdkRoot = dirname(
	requireFromRunner.resolve("@anthropic-ai/claude-agent-sdk"),
);
const requireFromCore = createRequire(join(coreRoot, "package.json"));
assert.equal(
	requireFromCore.resolve("@anthropic-ai/claude-agent-sdk"),
	requireFromRunner.resolve("@anthropic-ai/claude-agent-sdk"),
	"Runner and core must use the same SDK",
);
const apiRoot = dirname(requireFromRunner.resolve("@anthropic-ai/sdk"));
const requireFromSdk = createRequire(join(sdkRoot, "package.json"));
const nativeRoot = dirname(
	requireFromSdk.resolve(
		`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
	),
);
const provenance = {
	runner: packageIdentity(packageRoot),
	core: packageIdentity(coreRoot),
	agentSdk: packageIdentity(sdkRoot),
	apiSdk: packageIdentity(apiRoot),
	nativeRuntime: packageIdentity(nativeRoot),
	consumerLockSha256: createHash("sha256")
		.update(readFileSync(join(workingDirectory, "package-lock.json")))
		.digest("hex"),
};
assert.equal(provenance.agentSdk.version, "0.3.316");
assert.equal(provenance.apiSdk.version, "1.3.0");
console.log(JSON.stringify({ status: "PREPARED", provenance }, null, 2));
if (process.argv.includes("--provenance-only")) process.exit(0);
// This checks identity only; the operator must establish restored access before
// retrying a previous authentication failure. It is not an access-token probe.
const identity = JSON.parse(
	execFileSync(
		join(nativeRoot, process.platform === "win32" ? "claude.exe" : "claude"),
		["auth", "status", "--json"],
		{ encoding: "utf8", timeout: 20_000 },
	),
);
assert.equal(identity.loggedIn, true);
assert.equal(identity.authMethod, "claude.ai");
assert.equal(identity.apiProvider, "firstParty");
assert.equal(identity.email, "connor@ceedar.io");
assert.equal(identity.orgId, "685559cd-fcf8-43cb-8a0e-eb20cd18cead");
const intendedIdentity = {
	email: identity.email,
	orgId: identity.orgId,
	authMethod: identity.authMethod,
	apiProvider: identity.apiProvider,
};
const packageText = readFileSync(
	join(workingDirectory, "package.json"),
	"utf8",
);

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
let runningAfterCompletion;
let pendingAfterCompletion;
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
	runningAfterCompletion = runner.isRunning();
	pendingAfterCompletion = runner.hasPendingWork();
} finally {
	clearTimeout(watchdog);
	runner.stop();
}

assert.deepEqual(
	callbackErrors.map((error) => error.message),
	[],
	"Runner emitted an error callback",
);
const { readUse, bashUse, result } = validateRuntimeMessages(
	messages,
	workingDirectory,
	packageText,
);
const init = messages.find(
	(message) => message.type === "system" && message.subtype === "init",
);
assert.equal(completed, true, "Runner did not emit complete");
assert.equal(
	runningAfterCompletion,
	false,
	"Runner remained active after completion",
);
assert.equal(pendingAfterCompletion, false, "Runner retained pending work");
runner.stop();
assert.equal(runner.isRunning(), false, "Runner did not stop cleanly");

console.log(
	JSON.stringify(
		{
			status: "PASS",
			provenance,
			identity: intendedIdentity,
			package: `${manifest.name}@${manifest.version}`,
			workingDirectory,
			sessionId: runner.getSessionInfo()?.sessionId,
			claudeCodeVersion: init?.claude_code_version,
			model: result.modelUsage ? Object.keys(result.modelUsage) : undefined,
			elapsedMs: Date.now() - startedAt,
			read: {
				filePath: readUse.input.file_path,
				resultReceived: true,
				isError: false,
			},
			bash: {
				command: bashUse.input.command,
				timeout: bashUse.input.timeout,
				foreground: true,
				resultReceived: true,
				isError: false,
			},
			finalText: "SDK_RUNTIME_OK",
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
