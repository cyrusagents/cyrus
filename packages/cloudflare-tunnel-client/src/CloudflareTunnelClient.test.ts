import { EventEmitter } from "node:events";
import { Tunnel } from "cloudflared";
import { afterEach, expect, it, vi } from "vitest";
import { CloudflareTunnelClient } from "./CloudflareTunnelClient.js";
import { inspectManagedRouting } from "./routing.js";

vi.mock("node:fs", () => ({ existsSync: () => true }));
afterEach(() => vi.restoreAllMocks());

it("distinguishes four connector connections from wrong-port managed ingress and its correction", async () => {
	// Control only the cloudflared process. Exercise the real package ConfigHandler
	// and production client; no tunnel/account/token is created or reconfigured.
	const process = { kill: vi.fn() };
	const handlers: ((output: string, tunnel: unknown) => void)[] = [];
	const tunnel = Object.assign(new EventEmitter(), {
		process,
		addHandler: (handler: (output: string, tunnel: unknown) => void) =>
			handlers.push(handler),
	});
	vi.spyOn(Tunnel, "withToken").mockReturnValue(tunnel as unknown as Tunnel);
	const log = vi.spyOn(console, "log").mockImplementation(() => {});
	const client = new CloudflareTunnelClient("fixture-token", 50967);
	const events = vi.fn();
	client.on("routing", events);
	const started = client.startTunnel();
	for (let i = 0; i < 4; i++) tunnel.emit("connected", { id: `fixture-${i}` });
	await started;
	expect(client.isConnected()).toBe(true);
	expect(client.getRoutingStatus()).toEqual({
		state: "unverified",
		expectedPort: 50967,
	});
	const managed = (service: string) => {
		const config = {
			ingress: [
				{ hostname: "fixture.invalid", service },
				{ service: "http_status:404" },
			],
		};
		const line = `Updated to new configuration config=${JSON.stringify(JSON.stringify(config))} version=1`;
		for (const handler of handlers) handler(line, tunnel);
	};
	managed("http://localhost:3456");
	expect(client.getRoutingStatus()).toEqual({
		state: "mismatch",
		expectedPort: 50967,
	});
	managed("http://127.0.0.1:50967");
	expect(client.getRoutingStatus()).toEqual({
		state: "matches-local-port",
		expectedPort: 50967,
	});
	managed("http://user:secret-origin-password@localhost:50967");
	expect(client.getRoutingStatus().state).toBe("mismatch");
	for (const handler of handlers)
		handler('config="{invalid-secret-config}" version=2', tunnel);
	expect(client.getRoutingStatus().state).toBe("unverified");
	expect(
		JSON.stringify(events.mock.calls) + JSON.stringify(log.mock.calls),
	).not.toMatch(/fixture-token|secret-origin-password|invalid-secret-config/);
	client.disconnect();
	expect(process.kill).toHaveBeenCalledOnce();
	expect(client.isConnected()).toBe(false);
	expect(client.getRoutingStatus().state).toBe("unverified");
});

it.each([
	[{}, "unverified"],
	[{ ingress: [] }, "unverified"],
	[{ ingress: [{ service: "http_status:404" }] }, "unverified"],
	[{ ingress: [{ service: "http://[::1]:50967" }] }, "matches-local-port"],
	[
		{
			ingress: [
				{ service: "http://localhost:50967" },
				{ service: "http://localhost:3456" },
			],
		},
		"mismatch",
	],
	[{ ingress: [{ service: "http://foreign.invalid:50967" }] }, "mismatch"],
])("never treats missing or foreign managed origins as local routing: %j", (config, state) => {
	expect(inspectManagedRouting(config, 50967).state).toBe(state);
});
