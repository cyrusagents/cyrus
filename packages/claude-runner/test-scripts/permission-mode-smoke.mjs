/**
 * Exercise the installed SDK/CLI's permission resolution through ClaudeRunner.
 * Run after pnpm build: node packages/claude-runner/test-scripts/permission-mode-smoke.mjs
 * Stops on system/init; uses dummy credentials and does NOT validate model auth.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunner } from "../dist/ClaudeRunner.js";

process.env.CYRUS_LOG_LEVEL = "ERROR";

const cases = [
	["first-party", {}, undefined, undefined],
	["user defaultMode=acceptEdits", {}, "acceptEdits", undefined],
	["project defaultMode=plan", {}, undefined, "plan"],
	["local defaultMode=acceptEdits", {}, undefined, undefined, "acceptEdits"],
	[
		"Bedrock",
		{
			CLAUDE_CODE_USE_BEDROCK: "1",
			CLAUDE_CODE_SKIP_BEDROCK_AUTH: "1",
			AWS_REGION: "us-east-1",
		},
	],
	[
		"Vertex",
		{
			CLAUDE_CODE_USE_VERTEX: "1",
			CLAUDE_CODE_SKIP_VERTEX_AUTH: "1",
			CLOUD_ML_REGION: "us-east5",
			ANTHROPIC_VERTEX_PROJECT_ID: "permission-test",
		},
	],
	[
		"Foundry",
		{
			CLAUDE_CODE_USE_FOUNDRY: "1",
			ANTHROPIC_FOUNDRY_API_KEY: "test-only",
			ANTHROPIC_FOUNDRY_RESOURCE: "permission-test",
		},
	],
	["DISABLE_TELEMETRY", { DISABLE_TELEMETRY: "1" }],
	["DO_NOT_TRACK", { DO_NOT_TRACK: "1" }],
];

for (const [name, env, userMode, projectMode, localMode] of cases) {
	const root = await mkdtemp(join(tmpdir(), "cyrus-permission-smoke-"));
	const configDir = join(root, "config");
	const cwd = join(root, "repo");
	await mkdir(configDir);
	await mkdir(join(cwd, ".claude"), { recursive: true });
	for (const [path, mode] of [
		[join(configDir, "settings.json"), userMode],
		[join(cwd, ".claude/settings.json"), projectMode],
		[join(cwd, ".claude/settings.local.json"), localMode],
	]) {
		if (mode)
			await writeFile(
				path,
				JSON.stringify({ permissions: { defaultMode: mode } }),
			);
	}
	let init;
	const runner = new ClaudeRunner({
		workingDirectory: cwd,
		cyrusHome: root,
		model: "sonnet",
		fallbackModel: "haiku",
		tools: ["Read"],
		allowedTools: ["Read"],
		additionalEnv: {
			CLAUDE_CONFIG_DIR: configDir,
			ANTHROPIC_API_KEY: "test-only-not-a-credential",
			ANTHROPIC_AUTH_TOKEN: "",
			CLAUDE_CODE_OAUTH_TOKEN: "",
			ANTHROPIC_BASE_URL: "http://127.0.0.1:1",
			CLAUDE_CODE_USE_BEDROCK: "0",
			CLAUDE_CODE_USE_VERTEX: "0",
			CLAUDE_CODE_USE_FOUNDRY: "0",
			DISABLE_TELEMETRY: "0",
			DO_NOT_TRACK: "0",
			...env,
		},
		onMessage(message) {
			if (message.type === "system" && message.subtype === "init") {
				init = message;
				runner.stop();
			}
		},
		onError() {}, // Stopping at init aborts the query intentionally.
	});
	const timeout = setTimeout(() => runner.stop(), 30_000);
	try {
		await runner.start("Permission initialization probe").catch((error) => {
			if (!init) throw error;
		});
		assert.ok(init, `${name}: missing init`);
		assert.equal(init.permissionMode, "default", name);
		assert.equal(init.claude_code_version, "2.1.291", name);
		console.log(
			`PASS ${name}: permissionMode=${init.permissionMode}, Claude Code ${init.claude_code_version}`,
		);
	} finally {
		clearTimeout(timeout);
		runner.stop();
		await rm(root, {
			recursive: true,
			force: true,
			maxRetries: 10,
			retryDelay: 100,
		});
	}
}
