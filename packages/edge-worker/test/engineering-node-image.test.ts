import { describe, expect, it } from "vitest";
import { DockerSandbox } from "../src/automations/DockerSandbox.js";

const image = process.env.CYRUS_TEST_CODEX_IMAGE;
describe.skipIf(!image)(
	"engineering executor on the reviewed native Codex Node image",
	() => {
		const sandbox = () =>
			new DockerSandbox({
				image: image!,
				dockerPath:
					process.env.CYRUS_TEST_DOCKER_PATH || "/usr/local/bin/docker",
				dockerHost:
					process.env.CYRUS_TEST_DOCKER_HOST || "unix:///var/run/docker.sock",
			});
		it("retains edits and diagnostics across a failing test, repair and passing rerun", async () => {
			const runner = sandbox(),
				signal = new AbortController().signal;
			try {
				await runner.start(
					{
						"unicode.txt": "🛠️ réparation 日本語\n".repeat(10000),
						"sum.cjs": "exports.sum=(a,b)=>a-b;",
						"sum.test.cjs":
							"const {test}=require('node:test'),assert=require('node:assert/strict'),{sum}=require('./sum.cjs');test('sum',()=>assert.equal(sum(2,3),5));",
					},
					signal,
				);
				const failed = await runner.execute(
					"printf retained > before-failure.txt; node --test sum.test.cjs",
					signal,
				);
				expect(failed.exitCode).toBe(1);
				expect(failed.stdout).toContain("ERR_ASSERTION");
				expect((await runner.snapshot(signal))["before-failure.txt"]).toBe(
					"retained",
				);
				expect((await runner.snapshot(signal))["unicode.txt"]).toBe(
					"🛠️ réparation 日本語\n".repeat(10000),
				);
				const passed = await runner.execute(
					"printf 'exports.sum=(a,b)=>a+b;' > sum.cjs; node --test sum.test.cjs",
					signal,
				);
				expect(passed.exitCode).toBe(0);
				expect(passed.stdout).toContain("# pass 1");
				expect((await runner.snapshot(signal))["sum.cjs"]).toBe(
					"exports.sum=(a,b)=>a+b;",
				);
			} finally {
				await runner.stop();
			}
		}, 15000);
		it("denies host credentials, filesystem and network access", async () => {
			const runner = sandbox(),
				signal = new AbortController().signal;
			const prior = process.env.CYRUS_SCOPED_HOST_SECRET;
			process.env.CYRUS_SCOPED_HOST_SECRET = "synthetic-must-not-inherit";
			try {
				await runner.start({}, signal);
				const proof = await runner.execute(
					`node -e '
(async () => {
const fs = require("node:fs");
if(process.getuid() === 0) throw Error("root");
for(const path of ["/var/run/docker.sock", "/Users/agentops", "/root/.aws", "/root/.cyrus"])
 if(fs.existsSync(path)) throw Error("host filesystem");
for(const key of ["ANTHROPIC_API_KEY", "GITHUB_TOKEN", "LINEAR_API_KEY", "DATABASE_URL", "DOCKER_HOST", "CYRUS_SCOPED_HOST_SECRET"])
 if(process.env[key]) throw Error("inherited credential");
try { fs.writeFileSync("/etc/cyrus-escape", "bad"); throw Error("writable root"); }
 catch(error) { if(error.message === "writable root") throw error; }
try { await fetch("http://1.1.1.1", {signal: AbortSignal.timeout(1000)}); throw Error("network"); }
 catch(error) { if(error.message === "network") throw error; }
console.log("isolated");
})().catch(() => process.exitCode = 1);'`,
					signal,
				);
				expect(proof).toEqual({
					exitCode: 0,
					stdout: "isolated\n",
					stderr: "",
				});
			} finally {
				if (prior === undefined) delete process.env.CYRUS_SCOPED_HOST_SECRET;
				else process.env.CYRUS_SCOPED_HOST_SECRET = prior;
				await runner.stop();
			}
		}, 15000);

		it.each([
			"abort",
			"timeout",
			"output limit",
		])("retains the stop boundary on %s", async (failure) => {
			const runner = sandbox(),
				controller = new AbortController();
			let timer: ReturnType<typeof setTimeout> | undefined;
			try {
				await runner.start({}, controller.signal);
				if (failure === "abort")
					timer = setTimeout(() => controller.abort(), 100);
				await expect(
					runner.execute(
						failure === "output limit"
							? `node -e 'console.log("x".repeat(2000000))'`
							: "sleep 40",
						controller.signal,
					),
				).rejects.toThrow();
				await expect(
					runner.execute("echo denied", new AbortController().signal),
				).rejects.toThrow("not running");
			} finally {
				clearTimeout(timer);
				await runner.stop();
			}
		}, 40000);
	},
);
