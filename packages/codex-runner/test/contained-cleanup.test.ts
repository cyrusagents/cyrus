import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { ContainedCodexProcess } from "../src/backend/ContainedCodexProcess.js";

// Fault injection at the Docker CLI/process boundary; no real Docker or model calls.
async function fixture(remaining: boolean) {
	const directory = await mkdtemp(join(tmpdir(), "contained-cleanup-"));
	const docker = join(directory, "docker");
	await writeFile(
		docker,
		`#!${process.execPath}
const args=process.argv.slice(2);
if(args[2]==='image'){process.stdout.write('[{"Config":{}}]');process.exit(0);}
if(args[2]==='rm')process.exit(1);
if(args[2]==='ps'){process.stdout.write(${JSON.stringify(remaining ? "fixture-container\n" : "")});process.exit(0);}
const readline=require('node:readline').createInterface({input:process.stdin});
readline.on('line',line=>{const m=JSON.parse(line);if(!m.method)return;
const result=m.method==='initialize'?{codexHome:'/work/home/.codex',userAgent:'codex/0.153.3 fixture'}:{};
console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
if(m.method==='turn/start')console.log(JSON.stringify({jsonrpc:'2.0',id:'model-request',method:'cyrus/model',params:{body:'{}'}}));
});
`,
		{ mode: 0o700 },
	);
	const runner = new ContainedCodexProcess({
		image: `sha256:${"a".repeat(64)}`,
		dockerPath: docker,
		dockerHost: "unix:///fixture.sock",
	});
	return {
		runner,
		async dispose() {
			await runner.close().catch(() => {});
			await rm(directory, { recursive: true, force: true });
		},
	};
}

it.each([
	false,
	true,
])("requires successful proof of container absence even when rm failed: remaining=%s", async (remaining) => {
	const f = await fixture(remaining);
	try {
		await f.runner.start({
			signal: new AbortController().signal,
			notification() {},
			async request() {
				return {};
			},
			async model() {
				throw Error("unused");
			},
		});
		if (remaining) {
			await expect(f.runner.close()).rejects.toThrow("cleanup unconfirmed");
			await expect(f.runner.close()).rejects.toThrow("cleanup unconfirmed");
		} else await expect(f.runner.close()).resolves.toBeUndefined();
	} finally {
		await f.dispose();
	}
});

it("does not report cleanup complete while a supervisor model callback is still running", async () => {
	const f = await fixture(false);
	let release!: () => void,
		entered = false,
		closed = false;
	const gate = new Promise<void>((r) => {
		release = r;
	});
	try {
		await f.runner.start({
			signal: new AbortController().signal,
			notification() {},
			async request() {
				return {};
			},
			async model() {
				entered = true;
				await gate;
				throw Error("controlled callback settled");
			},
		});
		await f.runner.request("turn/start", {});
		await expect.poll(() => entered).toBe(true);
		const closing = f.runner.close().then(() => {
			closed = true;
		});
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(closed).toBe(false);
		release();
		await closing;
		expect(closed).toBe(true);
	} finally {
		release?.();
		await f.dispose();
	}
});
