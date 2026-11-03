/**
 * Transport-level integration test for Cloudflare tunnel supervision through
 * SharedApplicationServer. cloudflared is replaced by the local fake executable
 * from cyrus-cloudflare-tunnel-client (via CLOUDFLARED_BIN): real child
 * processes, no real tunnel, network, or credentials.
 */
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Must be set before cloudflared is loaded: it resolves its binary path at import
process.env.CLOUDFLARED_BIN = fileURLToPath(
	new URL(
		"../../cloudflare-tunnel-client/test/fake-cloudflared.mjs",
		import.meta.url,
	),
);
const { SharedApplicationServer } = await import(
	"../src/SharedApplicationServer.js"
);

let dir: string;

function spawns(): { pid: number }[] {
	return readdirSync(dir)
		.filter((f) => f.startsWith("spawn-"))
		.sort((a, b) => Number(a.slice(6, -5)) - Number(b.slice(6, -5)))
		.map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitFor(condition: () => boolean, timeoutMs = 5000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeoutMs) {
			throw new Error("Timed out waiting for condition");
		}
		await new Promise((r) => setTimeout(r, 10));
	}
}

const activeTimeouts = () =>
	process.getActiveResourcesInfo().filter((r) => r === "Timeout").length;

function createServer() {
	const logger = createLogger({ component: "test" });
	const info = vi.spyOn(logger, "info");
	const server = new SharedApplicationServer(0, "127.0.0.1", false, logger);
	return { server, info };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fake-cloudflared-"));
	process.env.FAKE_CLOUDFLARED_DIR = dir;
});

afterEach(() => {
	for (const { pid } of spawns()) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("SharedApplicationServer Cloudflare tunnel recovery", () => {
	it("recovers the tunnel after the connected cloudflared child exits, and stop() ends supervision", async () => {
		writeFileSync(join(dir, "plan.json"), JSON.stringify(["connect"]));
		const { server, info } = createServer();

		await server.startCloudflareTunnel("fake-token-for-tests");
		const [first] = spawns();
		process.kill(first!.pid, "SIGUSR2"); // incident: child exits with code 11

		await waitFor(() =>
			info.mock.calls.some(([m]) => m === "Cloudflare tunnel reconnected"),
		);
		expect(info).toHaveBeenCalledWith(
			"Cloudflare tunnel disconnected: Tunnel process exited with code 11",
		);
		const restarted = spawns()[1]!;
		expect(isAlive(first!.pid)).toBe(false);
		expect(isAlive(restarted.pid)).toBe(true);
		// Startup connection log is not repeated past 4/4 on reconnection
		expect(
			info.mock.calls.filter(([m]) =>
				String(m).startsWith("Cloudflare tunnel connection "),
			),
		).toHaveLength(4);

		await server.stop();
		await waitFor(() => !isAlive(restarted.pid), 7000);
		await new Promise((r) => setTimeout(r, 1500));
		expect(spawns()).toHaveLength(2);
	});

	it("fails startup without leaking the startup timeout or the child", async () => {
		writeFileSync(
			join(dir, "plan.json"),
			JSON.stringify(["exit:3", "connect"]),
		);
		const { server } = createServer();
		const baseline = activeTimeouts();

		await expect(
			server.startCloudflareTunnel("fake-token-for-tests"),
		).rejects.toThrow("Tunnel process exited with code 3");

		expect(activeTimeouts()).toBe(baseline);
		await new Promise((r) => setTimeout(r, 1500));
		expect(spawns()).toHaveLength(1);
	});

	it("stop() cancels startup promptly between the first and fourth connection without leaking", async () => {
		writeFileSync(join(dir, "plan.json"), JSON.stringify(["connect1"]));
		const { server, info } = createServer();
		const baseline = activeTimeouts();

		const startup = server.startCloudflareTunnel("fake-token-for-tests");
		const settled = startup.then(
			() => "resolved",
			(error: Error) => error.message,
		);
		// The client's own startup has resolved; the server still waits for 4/4
		await waitFor(() =>
			info.mock.calls.some(
				([m]) => m === "Cloudflare tunnel connection 1/4 established",
			),
		);
		const { pid } = spawns()[0]!;

		const stoppedAt = Date.now();
		await server.stop();
		expect(await settled).toBe(
			"Shared application server stopped during Cloudflare tunnel startup",
		);
		expect(Date.now() - stoppedAt).toBeLessThan(1000);

		await waitFor(() => !isAlive(pid), 7000);
		expect(activeTimeouts()).toBe(baseline);
		await new Promise((r) => setTimeout(r, 1500));
		expect(spawns()).toHaveLength(1);
	});
});
