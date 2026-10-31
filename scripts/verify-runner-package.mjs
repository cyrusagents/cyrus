// Check an installed tarball, never the workspace source. This checks the
// package contract with a mocked SDK; authenticated runtime testing is separate.
// node --experimental-test-module-mocks scripts/verify-runner-package.mjs \
//   /tmp/consumer/node_modules/cyrus-claude-runner
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";

assert(process.argv[2], "Pass the installed cyrus-claude-runner directory");
// DEBUG logging includes query environment values; never print those here.
process.env.CYRUS_LOG_LEVEL = "ERROR";
const packageRoot = resolve(process.argv[2]);
const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json")));
assert.equal(manifest.name, "cyrus-claude-runner");
const requireFromPackage = createRequire(join(packageRoot, "package.json"));
const sdkPath = requireFromPackage.resolve("@anthropic-ai/claude-agent-sdk");
const sdk = await import(pathToFileURL(sdkPath).href);
let captured;
mock.module(sdkPath, {
	namedExports: {
		...sdk,
		query: (args) => {
			captured = args.options;
			return (async function* () {})();
		},
	},
});
const { ClaudeRunner } = await import(
	pathToFileURL(join(packageRoot, manifest.main)).href
);
const fixture = mkdtempSync(join(tmpdir(), "runner-package-check-"));
// Let the runner's asynchronous log streams finish before deleting their files.
process.once("exit", () => rmSync(fixture, { recursive: true, force: true }));
try {
	for (const additionalEnv of [
		{},
		{ CLAUDE_CODE_USE_BEDROCK: "1" },
		{ CLAUDE_CODE_USE_VERTEX: "1" },
		{ CLAUDE_CODE_USE_FOUNDRY: "1" },
		{ DISABLE_TELEMETRY: "1" },
		{ DO_NOT_TRACK: "1" },
	]) {
		captured = undefined;
		const runner = new ClaudeRunner({
			workingDirectory: fixture,
			cyrusHome: fixture,
			additionalEnv,
			allowedTools: ["Read", "Bash(pwd)"],
			disallowedTools: ["Write"],
			onAskUserQuestion: async () => {
				throw new Error(
					"Unexpected approval request in package contract check",
				);
			},
		});
		try {
			await runner.start("Check installed query options");
			assert(captured, "Installed runner did not call the SDK");
			assert.equal(captured.permissionMode, "default");
			assert.deepEqual(captured.settingSources, ["user", "project", "local"]);
			assert.equal(typeof captured.canUseTool, "function");
			assert(captured.allowedTools.includes("Read"));
			assert(captured.allowedTools.includes("Bash(pwd)"));
			assert(captured.disallowedTools.includes("Write"));
			assert.equal(runner.isRunning(), false);
		} finally {
			runner.stop();
		}
	}
	console.log(
		`${manifest.name}@${manifest.version}: installed permission contract PASS (6 configurations)`,
	);
} finally {
	mock.restoreAll();
}
