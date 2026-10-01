import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AppServerClient } from "../src/backend/appServerClient.js";

it("confirms dedicated process exit even when graceful interruption is ignored", async () => {
	const home = await mkdtemp(join(tmpdir(), "cyrus-owned-process-"));
	const fixture = join(home, "server.mjs");
	await writeFile(
		fixture,
		`import {createInterface} from 'node:readline';\nprocess.on('SIGTERM',()=>{});\nfor await(const line of createInterface({input:process.stdin})){const m=JSON.parse(line); if(m.id!==undefined) process.stdout.write(JSON.stringify({id:m.id,result:{pid:process.pid}})+'\\n');}`,
	);
	const client = new AppServerClient({
		binaryPath: process.execPath,
		args: [fixture],
		awaitProcessExit: true,
	});
	try {
		client.start();
		const { pid } = await client.request<{ pid: number }>("initialize", {});
		expect(() => process.kill(pid, 0)).not.toThrow();
		await client.close();
		expect(() => process.kill(pid, 0)).toThrow();
		await client.close();
	} finally {
		await client.close();
		await rm(home, { recursive: true, force: true });
	}
});
