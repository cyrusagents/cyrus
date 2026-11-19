import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repositoryRoot = resolve(
	fileURLToPath(new URL("../../..", import.meta.url)),
);
const harness = join(repositoryRoot, "scripts/extract-claude-tools.mjs");

function runHarness(cli: string, timeoutMs: number, environment = {}) {
	return new Promise<{ code: number | null; stderr: string; stdout: string }>(
		(resolveResult) => {
			const child = spawn(
				process.execPath,
				[
					harness,
					"--cli",
					cli,
					"--timeout-ms",
					String(timeoutMs),
					"--",
					"--fixture-argument",
				],
				{
					env: { ...process.env, ...environment },
					stdio: ["ignore", "pipe", "pipe"],
				},
			);
			let stdout = "";
			let stderr = "";
			child.stdout.on("data", (chunk) => (stdout += chunk));
			child.stderr.on("data", (chunk) => (stderr += chunk));
			child.once("close", (code) => resolveResult({ code, stderr, stdout }));
		},
	);
}

async function fixtureExecutable(source: string) {
	const directory = await mkdtemp(join(tmpdir(), "claude-tool-test-"));
	const executable = join(directory, "fixture.mjs");
	await writeFile(executable, `#!${process.execPath}\n${source}`);
	await chmod(executable, 0o755);
	return { directory, executable };
}

describe("credential-free Claude tool extraction", () => {
	it("uses an isolated loopback-only provider environment", async () => {
		const fixture = await fixtureExecutable(`
			const forbidden = [
				"ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_USE_BEDROCK",
				"CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
				"AWS_ACCESS_KEY_ID", "GOOGLE_APPLICATION_CREDENTIALS",
				"HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY"
			];
			const clean = forbidden.every((name) => process.env[name] === undefined);
			const local = new URL(process.env.ANTHROPIC_BASE_URL).hostname === "127.0.0.1";
			const isolated = process.env.HOME === process.env.TMPDIR &&
				process.env.CLAUDE_CONFIG_DIR.startsWith(process.env.HOME);
			const extractionOnly =
				process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC === "1" &&
				process.env.CLAUDE_CODE_ENABLE_TODO_TOOLS === "1" &&
				process.env.DISABLE_TELEMETRY === "1";
			process.stdout.write(JSON.stringify({
				type: "system", subtype: "init",
				tools: [clean && local && isolated && extractionOnly ? "SAFE" : "LEAK"]
			}) + "\\n");
		`);
		try {
			const result = await runHarness(fixture.executable, 2_000, {
				ALL_PROXY: "http://operator-proxy.invalid",
				ANTHROPIC_AUTH_TOKEN: "operator-secret",
				AWS_ACCESS_KEY_ID: "operator-key",
				CLAUDE_CODE_USE_BEDROCK: "1",
				CLAUDE_CODE_USE_FOUNDRY: "1",
				CLAUDE_CODE_USE_VERTEX: "1",
				GOOGLE_APPLICATION_CREDENTIALS: "/operator/credential.json",
				HTTPS_PROXY: "http://operator-proxy.invalid",
				HTTP_PROXY: "http://operator-proxy.invalid",
			});
			expect(result.code).toBe(0);
			assert.deepEqual(JSON.parse(result.stdout).tools, ["SAFE"]);
		} finally {
			await rm(fixture.directory, { force: true, recursive: true });
		}
	});

	it("terminates the complete check at the configured deadline", async () => {
		const fixture = await fixtureExecutable(`setInterval(() => {}, 10_000);`);
		const startedAt = Date.now();
		try {
			const result = await runHarness(fixture.executable, 200);
			expect(result.code).toBe(1);
			expect(result.stderr).toMatch(/did not emit init within 200ms/);
			expect(Date.now() - startedAt).toBeLessThan(2_000);
		} finally {
			await rm(fixture.directory, { force: true, recursive: true });
		}
	});
});
