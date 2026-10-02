import { expect, it } from "vitest";
import { AppServerClient } from "../src/backend/appServerClient.js";

it.each([
	"stdout",
	"stderr",
])("kills oversized unterminated %s and rejects pending control requests", async (stream) => {
	const client = new AppServerClient({
		binaryPath: process.execPath,
		args: [
			"-e",
			`process.stdin.once('data',()=>{process.${stream}.write('x'.repeat(4096));setInterval(()=>{},1000);});`,
		],
		maxOutputBytes: 1024,
		logger: { warn() {}, error() {} },
	});
	const errors: string[] = [];
	client.on("error", (error) => errors.push(error.message));
	try {
		client.start();
		await expect(client.request("initialize", {})).rejects.toThrow(
			"output limit exceeded",
		);
		expect(errors).toContain("App-server output limit exceeded");
		await expect(client.request("thread/start", {})).rejects.toThrow(
			"not running",
		);
	} finally {
		await client.close();
	}
});
