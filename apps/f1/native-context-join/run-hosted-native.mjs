// Freeze existing Hosted SQL scenarios, replace only the deterministic model
// boundary with native execution. All source modifications are disposable and
// preserved as a reviewable diff; the author Hosted worktree is never edited.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	cp,
	mkdir,
	mkdtemp,
	readFile,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { extendChildSuccessor } from "./extend-child-successor.mjs";

const [checkout, sha, prefix, runtimeSha, output] = process.argv.slice(2);
assert.match(sha ?? "", /^[a-f0-9]{40}$/);
assert.match(runtimeSha ?? "", /^[a-f0-9]{40}$/);
assert.match(process.env.CYRUS_F1_CODEX_IMAGE ?? "", /^sha256:[a-f0-9]{64}$/);
const modes =
	process.env.CYRUS_NATIVE_JOIN_MODES ||
	"read-set-direct-child,read-set-ticket-child,linear-events,slack-channel-events";
for (const mode of modes.split(","))
	assert.ok(
		[
			"instruction-tick",
			"read-set-direct-child",
			"read-set-ticket-child",
			"linear-events",
			"slack-channel-events",
		].includes(mode),
	);
const successorMode = process.env.CYRUS_NATIVE_JOIN_PARENT_SUCCESSOR === "1";
if (successorMode) assert.equal(modes, "read-set-direct-child");
const modules = join(
	resolve(prefix),
	"lib/node_modules/cyrus-edge-worker/dist/automations",
);
assert.equal(
	JSON.parse(await readFile(resolve(modules, "../../package.json"), "utf8"))
		.cyrusLocalTestArtifact.sourceSha,
	runtimeSha,
);
const evidence = resolve(output);
await mkdir(evidence);
const work = await mkdtemp(join(tmpdir(), "cyrus-hosted-native-"));
const run = (cmd, args, options = {}) =>
	execFileSync(cmd, args, { stdio: "inherit", ...options });
const archive = join(work, "source.tar");
run("git", [
	"-C",
	resolve(checkout),
	"archive",
	"--format=tar",
	`--output=${archive}`,
	sha,
]);
run("tar", ["-xf", archive, "-C", work]);
await symlink(
	join(resolve(checkout), "node_modules"),
	join(work, "node_modules"),
);
await symlink(
	join(resolve(checkout), "apps/app/node_modules"),
	join(work, "apps/app/node_modules"),
);
const here = dirname(fileURLToPath(import.meta.url));
await cp(
	join(here, "oracle-native.mjs"),
	join(work, "tooling/oracle-native.mjs"),
);
function replaceOnce(source, before, after) {
	assert.equal(
		source.split(before).length,
		2,
		`Frozen source seam differs: ${before.slice(0, 70)}`,
	);
	return source.replace(before, after);
}
const driverPath = join(work, "tooling/customer-automation-runtime-drive.mjs");
const originalDriver = await readFile(driverPath, "utf8");
let driver = `import {nativeOracle} from "./oracle-native.mjs";\n${originalDriver}`;
driver = replaceOnce(
	driver,
	"  model: {\n    async next",
	"  model: await nativeOracle({\n    async next",
);
driver = replaceOnce(
	driver,
	"  },\n  store: new AutomationCheckpointStore",
	"  }, {directory,modules,load}),\n  store: new AutomationCheckpointStore",
);
driver = driver
	.replaceAll('"claude-controlled"', '"gpt-5.5"')
	.replaceAll(
		'harness: probeCodexReadiness ? "codex" : "claude"',
		'harness: "codex"',
	);
await writeFile(driverPath, driver);
const testPath = join(
	work,
	"apps/app/src/lib/customer-agents/automation.integration.test.mjs",
);
const originalTest = await readFile(testPath, "utf8");
let test = originalTest
	.replaceAll('harness: "claude"', 'harness: "codex"')
	.replaceAll('"claude-controlled"', '"gpt-5.5"');
// The fixture definitions target the installed native harness. Existing SQL
// assertions still run; optional joint modes are restricted to this driver list.
test = replaceOnce(
	test,
	'sourceFree || mode === "session-receipt" || childMode || executionTiming;',
	'sourceFree || mode === "session-receipt" || childMode || executionTiming || mode.endsWith("-events");',
);
test = replaceOnce(
	test,
	"        const mcp = createCustomerMcpHandler({\n          async authorize",
	// biome-ignore lint/suspicious/noTemplateCurlyInString: SQL placeholders belong to the generated frozen test, not this process.
	"        const mcp = createCustomerMcpHandler({\n          async preflight(token, session) { return mcpAuthoritySchema.parse((await sql`select customer_mcp_authorize(${token},${session}::uuid,null) as value`)[0].value); },\n          async authorize",
);
test = replaceOnce(
	test,
	'{ env: { PATH: process.env.PATH }, stdout: "pipe", stderr: "pipe" }',
	'{ env: { PATH: process.env.PATH, CYRUS_F1_CODEX_IMAGE: process.env.CYRUS_F1_CODEX_IMAGE, CYRUS_TEST_DOCKER_HOST: process.env.CYRUS_TEST_DOCKER_HOST, CYRUS_TEST_DOCKER_PATH: process.env.CYRUS_TEST_DOCKER_PATH }, stdout: "pipe", stderr: "pipe" }',
);
test = replaceOnce(
	test,
	"          expect(result.passed).toBe(true);",
	`          expect(result.passed).toBe(true);
          const native=JSON.parse(await readFile(join(directory,"native-summary.json"),"utf8"));
          expect(native.requests).toBe(result.modelSteps);
          expect(native.opens).toBe(expectedResults);
          expect(native.closes).toBe(native.opens);
          if(childMode) { expect(native.childRequests).toBeGreaterThan(0); expect(native.delegationDescriptionRequests).toBeGreaterThan(0); }
          await writeFile(join(process.env.CYRUS_NATIVE_JOIN_EVIDENCE, mode+".json"),JSON.stringify({runtime:result,native},null,2));`,
);
if (successorMode) {
	({ test, driver } = extendChildSuccessor({ test, driver, replaceOnce }));
	await writeFile(driverPath, driver);
	for (const name of ["child-successor-hosted.mjs", "sql-adapter.mjs"])
		await cp(
			join(here, name),
			join(work, "apps/app/src/lib/customer-agents", name),
		);
	await cp(
		join(here, "child-successor-runtime.mjs"),
		join(work, "tooling/child-successor-runtime.mjs"),
	);
}
await writeFile(testPath, test);
await writeFile(join(evidence, "original-driver.mjs"), originalDriver);
await writeFile(join(evidence, "adapted-driver.mjs"), driver);
await writeFile(join(evidence, "original-test.mjs"), originalTest);
await writeFile(join(evidence, "adapted-test.mjs"), test);
const helperSha256 = {};
for (const name of [
	"oracle-native.mjs",
	...(successorMode
		? [
				"child-successor-hosted.mjs",
				"child-successor-runtime.mjs",
				"extend-child-successor.mjs",
				"sql-adapter.mjs",
			]
		: []),
]) {
	const source = await readFile(join(here, name));
	await writeFile(join(evidence, name), source);
	helperSha256[name] = createHash("sha256").update(source).digest("hex");
}
await writeFile(
	join(evidence, "inputs.json"),
	JSON.stringify(
		{
			sha,
			runtimeSha,
			modes,
			successorMode,
			helperSha256,
			image: process.env.CYRUS_F1_CODEX_IMAGE,
			privateFixtureSource: work,
			originalDriverSha256: createHash("sha256")
				.update(originalDriver)
				.digest("hex"),
			originalTestSha256: createHash("sha256")
				.update(originalTest)
				.digest("hex"),
			limitations:
				"Original prepared outbox delivery/provider transport/step oracle controlled; actual installed native+SQL/HTTP/SDK. No signed ingress or production dispatcher claim.",
		},
		null,
		2,
	),
);
run("bun", ["--no-env-file", "tooling/test-customer-agents.mjs"], {
	cwd: work,
	env: {
		...process.env,
		CUSTOMER_TEST_FILE: "automation.integration.test.mjs",
		CUSTOMER_AUTOMATION_RUNTIME_MODULES: modules,
		CUSTOMER_AUTOMATION_JOINT_MODE: modes,
		CYRUS_NATIVE_JOIN_EVIDENCE: evidence,
	},
});
