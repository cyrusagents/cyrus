// Test-only caller attribution. Installed production modules remain unchanged.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [prefixArg, sourceSha, evidenceArg, scenario = "greeting"] =
	process.argv.slice(2);
const lifecycleAuthority = process.env.CYRUS_F1_LIFECYCLE_AUTHORITY === "1";
assert.ok(["greeting", "tools"].includes(scenario));
assert.ok(prefixArg && evidenceArg);
assert.match(sourceSha ?? "", /^[a-f0-9]{40}$/);
const modules = join(resolve(prefixArg), "lib/node_modules");
const evidence = resolve(evidenceArg);
await mkdir(evidence); // Never replace an earlier profile.
for (const name of ["cyrus-edge-worker", "cyrus-codex-runner"]) {
	const pkg = JSON.parse(await readFile(join(modules, name, "package.json")));
	assert.equal(pkg.cyrusLocalTestArtifact.sourceSha, sourceSha);
}
const input = await readFile(
	new URL("./automation-drive.mjs", import.meta.url),
	"utf8",
);
const adapted = input
	.replaceAll("../../packages/edge-worker/", `${modules}/cyrus-edge-worker/`)
	.replaceAll("../../packages/codex-runner/", `${modules}/cyrus-codex-runner/`);
const driver = join(evidence, "installed-drive.mjs");
await writeFile(driver, adapted);
const { ScopedAutomationMcpClient } = await import(
	pathToFileURL(
		join(modules, "cyrus-edge-worker/dist/automations/ScopedMcpClient.js"),
	)
);
const { runAutomationDrive } = await import(pathToFileURL(driver));
const original = ScopedAutomationMcpClient.prototype.revalidate;
const stackLimit = Error.stackTraceLimit;
Error.stackTraceLimit = 30;
let checks = [];
ScopedAutomationMcpClient.prototype.revalidate = async function () {
	// Do not retain arbitrary stack text, paths, IDs, headers or payloads. These
	// fixed code filenames + numeric locations identify the frozen caller only.
	const frames = [
		...(new Error().stack ?? "").matchAll(
			/\/(AutomationRuntime|ContainedCodexModel|CodexLoginBroker)\.js:(\d+):(\d+)/g,
		),
	]
		.slice(0, 16)
		.map((m) => ({ file: m[1], line: Number(m[2]), column: Number(m[3]) }));
	assert.ok(frames.length);
	const check = { frames, durationMs: 0, failed: false };
	checks.push(check);
	assert.ok(checks.length <= 128);
	const start = performance.now();
	try {
		return await original.call(this);
	} catch (error) {
		check.failed = true;
		throw error;
	} finally {
		check.durationMs = performance.now() - start;
	}
};
try {
	for (const latencyMcpMilliseconds of scenario === "tools"
		? [500]
		: [150, 1500]) {
		checks = [];
		const start = performance.now();
		const summary = await runAutomationDrive({
			...(scenario === "tools"
				? { slackChannelOnly: true, catalogProfile: true }
				: { latencyOnly: true, latencyReadSet: true }),
			sessionDeliveryAuthority: true,
			lifecycleAuthority,
			latencyMcpMilliseconds,
		});
		const elapsedMs = performance.now() - start;
		assert.equal(checks.length, summary.counts.list);
		if (scenario === "greeting")
			assert.equal(
				checks.length,
				summary.traces
					.flatMap((t) => t.spans)
					.filter((s) => s.stage === "mcp.catalog").length,
			);
		delete summary.directory;
		assert.ok(checks.every((c) => !c.failed));
		await writeFile(
			join(evidence, `profile-${latencyMcpMilliseconds}.json`),
			JSON.stringify(
				{
					sourceSha,
					scenario,
					elapsedMs,
					driverSha256: createHash("sha256").update(input).digest("hex"),
					...summary,
					checks,
				},
				null,
				2,
			),
		);
		console.log(
			JSON.stringify({
				latencyMcpMilliseconds,
				passed: summary.passed,
				catalogs: checks.length,
				turns: summary.counts.models,
			}),
		);
	}
} finally {
	ScopedAutomationMcpClient.prototype.revalidate = original;
	Error.stackTraceLimit = stackLimit;
}
