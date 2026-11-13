import { afterEach, expect, it, vi } from "vitest";
import { DeviceHeartbeat } from "../src/DeviceHeartbeat.js";

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});
it("reports presence every ten minutes and stops on shutdown", async () => {
	vi.useFakeTimers();
	vi.stubEnv("CYRUS_TEAM_ID", "fixture-team");
	vi.stubEnv("CYRUS_API_KEY", "fixture-key");
	vi.stubEnv("CYRUS_APP_URL", "http://localhost:1234");
	const fetcher = vi.fn().mockResolvedValue(new Response("{}"));
	vi.stubGlobal("fetch", fetcher);
	const heartbeat = new DeviceHeartbeat();
	heartbeat.start();
	await vi.advanceTimersByTimeAsync(0);
	expect(fetcher).toHaveBeenCalledOnce();
	expect(fetcher).toHaveBeenCalledWith(
		"http://localhost:1234/api/devices/heartbeat",
		expect.objectContaining({
			method: "POST",
			headers: {
				Authorization: "Bearer fixture-key",
				"X-Cyrus-Team-Id": "fixture-team",
			},
		}),
	);
	await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
	expect(fetcher).toHaveBeenCalledTimes(2);
	heartbeat.stop();
	await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
	expect(fetcher).toHaveBeenCalledTimes(2);
});
it("does not start for standalone installations", async () => {
	vi.stubEnv("CYRUS_TEAM_ID", "");
	const fetcher = vi.fn();
	vi.stubGlobal("fetch", fetcher);
	const heartbeat = new DeviceHeartbeat();
	heartbeat.start();
	heartbeat.stop();
	expect(fetcher).not.toHaveBeenCalled();
});
