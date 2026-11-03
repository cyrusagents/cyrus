// Release evidence companion: run on an unnested host after pnpm build, without credentials.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CodexConfigBuilder } from "../../../../packages/codex-runner/dist/config/CodexConfigBuilder.js";
import { RunnerConfigBuilder } from "../../../../packages/edge-worker/dist/RunnerConfigBuilder.js";
import { resolveSandboxWritablePaths } from "../../../../packages/edge-worker/dist/sandboxWritablePaths.js";

assert.ok(["linux", "darwin"].includes(process.platform));
const root = mkdtempSync(join(homedir(), "cypack-1592-sandbox-"));
const cwd = join(root, "workspace");
const allowed = join(root, "allowed");
const denied = join(root, "denied");
const codexHome = join(root, "codex-home");
for (const path of [cwd, allowed, denied, codexHome]) mkdirSync(path);
const launcher = resolve(
	"packages/codex-runner/node_modules/@openai/codex/bin/codex.js",
);
try {
	const builder = new RunnerConfigBuilder(
		{ buildChatAllowedTools: () => [] },
		{ buildMcpConfig: () => ({}), buildMergedMcpConfigPath: () => undefined },
		{
			determineRunnerSelection: () => ({ runnerType: "codex" }),
			getDefaultModelForRunner: () => "gpt-6.1-sol",
			getDefaultFallbackModelForRunner: () => undefined,
		},
	);
	const { config } = builder.buildIssueConfig({
		session: {
			issueId: "release",
			issue: { identifier: "DEF-1" },
			workspace: { path: cwd },
		},
		repository: {
			id: "fixture",
			name: "Fixture",
			repositoryPath: cwd,
			allowedTools: [],
		},
		sessionId: "release",
		systemPrompt: "Release validation",
		allowedTools: ["Bash"],
		allowedDirectories: [],
		disallowedTools: [],
		cyrusHome: root,
		linearWorkspaceId: "fixture",
		logger: { debug() {}, info() {}, warn() {}, error() {} },
		onMessage() {},
		onError() {},
		requireLinearWorkspaceId: () => "fixture",
		sandboxWritablePaths: resolveSandboxWritablePaths([allowed]),
	});
	const resolved = await new CodexConfigBuilder({
		...config,
		codexHome,
	}).build();
	assert.equal(resolved.sandbox.kind, "workspace-mode");
	assert.equal(resolved.sandbox.mode, "workspace-write");
	assert.deepEqual(resolved.sandbox.writableRoots, [cwd, allowed]);
	const result = spawnSync(
		process.execPath,
		[
			launcher,
			"sandbox",
			"-c",
			'sandbox_mode="workspace-write"',
			"-c",
			`sandbox_workspace_write.writable_roots=${JSON.stringify(resolved.sandbox.writableRoots)}`,
			"-c",
			`sandbox_workspace_write.network_access=${resolved.sandbox.networkAccess}`,
			"-c",
			"sandbox_workspace_write.exclude_tmpdir_env_var=true",
			"-c",
			"sandbox_workspace_write.exclude_slash_tmp=true",
			"--",
			"/bin/sh",
			"-c",
			'printf allowed > "$1/proof.txt" || exit 10; if printf denied > "$2/proof.txt"; then exit 11; fi; printf workspace > proof.txt',
			"sandbox-check",
			allowed,
			denied,
		],
		{
			cwd,
			env: { ...process.env, CODEX_HOME: codexHome },
			encoding: "utf8",
			timeout: 30000,
		},
	);
	console.log(result.stdout);
	console.log(result.stderr);
	assert.equal(
		result.status,
		0,
		`Sandbox process failed: ${result.error ?? result.stderr}`,
	);
	assert.equal(readFileSync(join(allowed, "proof.txt"), "utf8"), "allowed");
	assert.equal(readFileSync(join(cwd, "proof.txt"), "utf8"), "workspace");
	assert.equal(existsSync(join(denied, "proof.txt")), false);
	console.log(
		"PASS: issue config -> Codex config -> real OS sandbox: workspace and whitelisted writes succeed; sibling write denied.",
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
