/**
 * Real child-process lifecycle tests for CloudflareTunnelClient supervision.
 * cloudflared is replaced by a local fake executable (via CLOUDFLARED_BIN), so
 * no real tunnel, network, or credentials are involved.
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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeBin = fileURLToPath(
	new URL("./fake-cloudflared.mjs", import.meta.url),
);
// Must be set before cloudflared is loaded: it resolves its binary path at import
process.env.CLOUDFLARED_BIN = fakeBin;
const { CloudflareTunnelClient } = await import(
	"../src/CloudflareTunnelClient.js"
);
const { Tunnel } = await import("cloudflared");
type Client = InstanceType<typeof CloudflareTunnelClient>;
type ClientOptions =
	import("../src/CloudflareTunnelClient.js").CloudflareTunnelClientOptions;

const TOKEN = "fake-token-for-tests";

let dir: string;
let clients: Client[] = [];

function setPlan(plan: string[]) {
	writeFileSync(join(dir, "plan.json"), JSON.stringify(plan));
}

function spawns(): { pid: number; at: number }[] {
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

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function createClient(options: ClientOptions = {}) {
	const client = new CloudflareTunnelClient(TOKEN, 3456, undefined, {
		connectTimeoutMs: 2000,
		initialRestartDelayMs: 50,
		maxRestartDelayMs: 150,
		maxRestartAttempts: 3,
		killGraceMs: 300,
		...options,
	});
	const events: string[] = [];
	const errors: Error[] = [];
	client.on("connect", () => events.push("connect"));
	client.on("disconnect", (reason) => events.push(`disconnect: ${reason}`));
	client.on("error", (error) => errors.push(error));
	clients.push(client);
	return { client, events, errors };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "fake-cloudflared-"));
	process.env.FAKE_CLOUDFLARED_DIR = dir;
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const client of clients) client.disconnect();
	clients = [];
	for (const { pid } of spawns()) {
		if (isAlive(pid)) process.kill(pid, "SIGKILL");
	}
	rmSync(dir, { recursive: true, force: true });
});

describe("CloudflareTunnelClient post-start recovery", () => {
	it("restarts a connected child that exits unexpectedly while the parent stays alive", async () => {
		setPlan(["connect", "connect"]);
		const { client, events, errors } = createClient();

		await client.startTunnel();
		expect(client.isConnected()).toBe(true);
		// Informational ERR output from cloudflared must not cause a restart
		await sleep(200);
		expect(spawns()).toHaveLength(1);

		const [first] = spawns();
		process.kill(first!.pid, "SIGUSR2"); // child exits with code 11

		await waitFor(() =>
			events.includes("disconnect: Tunnel process exited with code 11"),
		);
		expect(client.isConnected()).toBe(false);

		await waitFor(() => events.filter((e) => e === "connect").length === 2);
		expect(client.isConnected()).toBe(true);
		const all = spawns();
		expect(all).toHaveLength(2);
		expect(isAlive(first!.pid)).toBe(false);
		expect(isAlive(all[1]!.pid)).toBe(true);
		expect(errors).toEqual([]);
	});

	it("backs off exponentially with a delay cap and gives up after the attempt limit", async () => {
		// Record which timer delay each spawn ran under, independent of how long
		// the real child launch takes: wrap every setTimeout callback, and have
		// the tunnel factory read the delay of the timer that is running
		const realSetTimeout = globalThis.setTimeout;
		let runningTimerDelay: number | undefined;
		vi.spyOn(globalThis, "setTimeout").mockImplementation(((
			callback: (...args: unknown[]) => void,
			delay?: number,
			...args: unknown[]
		) =>
			realSetTimeout(() => {
				runningTimerDelay = delay;
				try {
					callback(...args);
				} finally {
					runningTimerDelay = undefined;
				}
			}, delay)) as typeof setTimeout);
		const spawnTimerDelays: (number | undefined)[] = [];

		setPlan(["connect", "exit:1"]);
		const { client, events, errors } = createClient({
			createTunnel: (token) => {
				spawnTimerDelays.push(runningTimerDelay);
				return Tunnel.withToken(token);
			},
		});

		await client.startTunnel();
		process.kill(spawns()[0]!.pid, "SIGUSR2");

		await waitFor(() => errors.length > 0);
		expect(errors[0]!.message).toContain(
			"gave up after 3 consecutive failed restart attempts",
		);
		// Initial spawn is not timer-driven; restarts ran from backoff timers of
		// 50ms, 100ms, then 150ms: capped by maxRestartDelayMs instead of 200ms
		expect(spawnTimerDelays).toEqual([undefined, 50, 100, 150]);

		const all = spawns();
		expect(all).toHaveLength(4); // initial + 3 restarts
		// Real children: each restart waited at least its backoff delay. No upper
		// bound: wall-clock gaps also include process launch and scheduling time
		const gaps = all.slice(1).map((s, i) => s.at - all[i]!.at);
		expect(gaps[0]).toBeGreaterThanOrEqual(50);
		expect(gaps[1]).toBeGreaterThanOrEqual(100);
		expect(gaps[2]).toBeGreaterThanOrEqual(150);

		// Terminal: no further respawns, honestly disconnected
		await sleep(400);
		expect(spawns()).toHaveLength(4);
		expect(spawnTimerDelays).toHaveLength(4);
		expect(client.isConnected()).toBe(false);
		expect(events.filter((e) => e === "connect")).toHaveLength(1);
	});

	it("does not respawn when disconnected during the backoff sleep", async () => {
		setPlan(["connect", "connect"]);
		const { client } = createClient({ initialRestartDelayMs: 300 });

		await client.startTunnel();
		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => !client.isConnected());
		client.disconnect();

		await sleep(600);
		expect(spawns()).toHaveLength(1);
	});

	it("kills the in-flight restart child and stops when disconnected during a restart attempt", async () => {
		setPlan(["connect", "hang"]);
		const { client } = createClient();

		await client.startTunnel();
		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => spawns().length === 2);
		const restarting = spawns()[1]!;
		expect(isAlive(restarting.pid)).toBe(true);

		client.disconnect();
		await waitFor(() => !isAlive(restarting.pid));
		await sleep(400);
		expect(spawns()).toHaveLength(2);
		expect(client.isConnected()).toBe(false);
	});

	it("ignores callbacks from a timed-out restart child and keeps a single restart owner", async () => {
		setPlan(["connect", "hang", "connect"]);
		const { client, events } = createClient({ connectTimeoutMs: 300 });

		await client.startTunnel();
		process.kill(spawns()[0]!.pid, "SIGUSR2");

		await waitFor(() => events.filter((e) => e === "connect").length === 2);
		const all = spawns();
		expect(all).toHaveLength(3);
		expect(isAlive(all[1]!.pid)).toBe(false); // hung child was killed
		// The killed child's exit must not schedule an extra restart
		await sleep(400);
		expect(spawns()).toHaveLength(3);
		expect(client.isConnected()).toBe(true);
		expect(events.filter((e) => e.startsWith("disconnect"))).toHaveLength(1);
	});

	it("kills the child on deliberate disconnect, escalating to SIGKILL, and never respawns", async () => {
		setPlan(["connect-ignore-sigint"]);
		const { client, events } = createClient();

		await client.startTunnel();
		const { pid } = spawns()[0]!;
		client.disconnect();
		expect(events).toContain("disconnect: Client disconnected");

		await sleep(100);
		expect(isAlive(pid)).toBe(true); // ignored SIGINT, within grace period
		await waitFor(() => !isAlive(pid), 2000);
		await sleep(200);
		expect(spawns()).toHaveLength(1);
	});
});

describe("CloudflareTunnelClient startup", () => {
	it("fails startup promptly when the child exits before connecting, without respawning", async () => {
		setPlan(["exit:3", "connect"]);
		const { client } = createClient({ connectTimeoutMs: 10000 });

		const started = Date.now();
		await expect(client.startTunnel()).rejects.toThrow(
			"Cloudflare tunnel failed to start: Tunnel process exited with code 3",
		);
		expect(Date.now() - started).toBeLessThan(5000);
		await sleep(300);
		expect(spawns()).toHaveLength(1);
	});

	it("kills the child and does not respawn when the connect timeout elapses", async () => {
		setPlan(["hang", "connect"]);
		const { client } = createClient({ connectTimeoutMs: 300 });

		await expect(client.startTunnel()).rejects.toThrow("Timeout waiting");
		const { pid } = spawns()[0]!;
		await waitFor(() => !isAlive(pid));
		await sleep(300);
		expect(spawns()).toHaveLength(1);
	});

	it("rejects startup and kills the child when disconnected during startup", async () => {
		setPlan(["hang"]);
		const { client, errors } = createClient();

		const start = client.startTunnel();
		await waitFor(() => spawns().length === 1);
		client.disconnect();
		await expect(start).rejects.toThrow("disconnected during startup");
		await waitFor(() => !isAlive(spawns()[0]!.pid));
		expect(errors).toEqual([]);
	});

	it("rejects overlapping startTunnel calls and owns a single child", async () => {
		setPlan(["connect"]);
		const { client } = createClient();

		const first = client.startTunnel();
		await expect(client.startTunnel()).rejects.toThrow("already started");
		await first;
		await sleep(200);
		expect(spawns()).toHaveLength(1);
	});
});

describe("CloudflareTunnelClient listener reentrancy", () => {
	it("stays stopped when a disconnect listener stops the client after an unexpected exit", async () => {
		setPlan(["connect", "connect"]);
		const { client } = createClient();
		await client.startTunnel();
		client.on("disconnect", () => client.disconnect());

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await sleep(400); // well past the 50ms restart delay
		expect(spawns()).toHaveLength(1);
		expect(client.isConnected()).toBe(false);
	});

	it("rejects startup and kills the child when a ready listener stops the client", async () => {
		setPlan(["connect"]);
		const { client, events } = createClient();
		client.on("ready", () => client.disconnect());

		await expect(client.startTunnel()).rejects.toThrow(
			"disconnected during startup",
		);
		await waitFor(() => !isAlive(spawns()[0]!.pid));
		await sleep(200);
		expect(spawns()).toHaveLength(1);
		expect(events).not.toContain("connect");
	});

	it("settles startup and stays stopped when a connected listener stops the client on the first connection", async () => {
		setPlan(["connect"]);
		const { client, events } = createClient();
		client.on("connected", () => client.disconnect());

		await client.startTunnel(); // settled by the connection, not left hanging
		expect(events).not.toContain("connect");
		expect(client.isConnected()).toBe(false);
		await waitFor(() => !isAlive(spawns()[0]!.pid));
		await sleep(200);
		expect(spawns()).toHaveLength(1);
	});

	it("stays stopped when a connect listener stops the client on recovery", async () => {
		setPlan(["connect", "connect"]);
		const { client, events } = createClient();
		await client.startTunnel();
		client.on("connect", () => client.disconnect());

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => events.filter((e) => e === "connect").length === 2);
		await waitFor(() => !isAlive(spawns()[1]!.pid));
		await sleep(300);
		expect(spawns()).toHaveLength(2);
		expect(client.isConnected()).toBe(false);
	});

	it("stays stopped when an error listener stops the client on give-up", async () => {
		setPlan(["connect", "exit:1"]);
		const { client, events } = createClient({ maxRestartAttempts: 1 });
		await client.startTunnel();
		client.on("error", () => client.disconnect());

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => events.includes("disconnect: Client disconnected"));
		await sleep(300);
		expect(spawns()).toHaveLength(2);
		expect(
			events.filter((e) => e === "disconnect: Client disconnected"),
		).toHaveLength(1);
	});
});

describe("CloudflareTunnelClient strict child ownership", () => {
	// Real children; only the restart child's kill() is wrapped so its
	// termination is slow or never happens, independent of SIGKILL speed
	function wrapSecondChildKill(
		wrap: (realKill: (signal: NodeJS.Signals) => boolean) => void,
	) {
		let created = 0;
		let secondExitAt = 0;
		const createTunnel = (token: string) => {
			const tunnel = Tunnel.withToken(token);
			if (++created === 2) {
				const child = tunnel.process;
				const realKill = child.kill.bind(child);
				child.kill = () => {
					wrap((signal) => realKill(signal));
					return true;
				};
				child.once("exit", () => {
					secondExitAt = Date.now();
				});
			}
			return tunnel;
		};
		return { createTunnel, secondExitAt: () => secondExitAt };
	}

	it("waits for a slowly terminating child to exit before spawning the next", async () => {
		setPlan(["connect", "hang", "connect"]);
		const seam = wrapSecondChildKill((realKill) => {
			setTimeout(() => realKill("SIGKILL"), 500);
		});
		const { client, events } = createClient({
			connectTimeoutMs: 300,
			createTunnel: seam.createTunnel,
		});
		await client.startTunnel();

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => spawns().length === 2);
		// Restart child timed out and was killed, but has not exited yet
		await sleep(500);
		expect(isAlive(spawns()[1]!.pid)).toBe(true);
		expect(spawns()).toHaveLength(2);

		await waitFor(() => events.filter((e) => e === "connect").length === 2);
		const all = spawns();
		expect(all).toHaveLength(3);
		expect(seam.secondExitAt()).toBeGreaterThan(0);
		expect(all[2]!.at).toBeGreaterThanOrEqual(seam.secondExitAt());
	});

	it("stops recovery instead of running two children when a killed child never exits", async () => {
		setPlan(["connect", "hang", "connect"]);
		const seam = wrapSecondChildKill(() => {});
		const { client, errors } = createClient({
			connectTimeoutMs: 300,
			killWaitMs: 300,
			createTunnel: seam.createTunnel,
		});
		await client.startTunnel();

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => errors.length > 0, 3000);
		expect(errors[0]!.message).toContain("did not exit within 300ms");
		await sleep(400);
		expect(spawns()).toHaveLength(2);
		expect(isAlive(spawns()[1]!.pid)).toBe(true); // still owned, not replaced
		expect(client.isConnected()).toBe(false);
	});

	it("retries when creating the restart child throws synchronously", async () => {
		setPlan(["connect", "connect"]);
		let created = 0;
		const { client, events, errors } = createClient({
			createTunnel: (token) => {
				created++;
				if (created === 2 || created === 3) throw new Error("spawn EAGAIN");
				return Tunnel.withToken(token);
			},
		});
		await client.startTunnel();

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => events.filter((e) => e === "connect").length === 2);
		expect(created).toBe(4);
		expect(spawns()).toHaveLength(2);
		expect(errors).toEqual([]);
	});

	it("gives up without an uncaught exception when creating restart children keeps throwing", async () => {
		setPlan(["connect"]);
		let created = 0;
		const { client, errors } = createClient({
			createTunnel: (token) => {
				if (++created > 1) throw new Error("spawn EAGAIN");
				return Tunnel.withToken(token);
			},
		});
		await client.startTunnel();

		process.kill(spawns()[0]!.pid, "SIGUSR2");
		await waitFor(() => errors.length > 0);
		expect(errors[0]!.message).toContain(
			"gave up after 3 consecutive failed restart attempts (Tunnel process failed to spawn: spawn EAGAIN)",
		);
		expect(created).toBe(4);
		expect(client.isConnected()).toBe(false);
	});
});
