import { afterEach, expect, it, vi } from "vitest";
import { AppServerClient } from "../src/backend/appServerClient.js";

afterEach(() => vi.restoreAllMocks());

it("retains the close fence through EPERM and resolves only after group absence", async () => {
	let absent = false;
	const kill = vi.spyOn(process, "kill").mockImplementation(() => {
		throw Object.assign(new Error("synthetic group state"), {
			code: absent ? "ESRCH" : "EPERM",
		});
	});
	const client = new AppServerClient({ binaryPath: "unused" });
	// No process is spawned: only the OS group-observation boundary is simulated.
	Object.assign(client, { child: { pid: 123456 } });
	let settled = false;
	const closing = client.close().then(() => {
		settled = true;
	});
	try {
		await vi.waitFor(() => expect(kill.mock.calls.length).toBeGreaterThan(3));
		expect(settled).toBe(false);
	} finally {
		// Finish the polling loop before restoring the real process.kill,
		// including when an assertion fails.
		absent = true;
		await closing;
	}
	expect(settled).toBe(true);
	expect(
		kill.mock.calls.every(
			([pid]) => pid === (process.platform === "win32" ? 123456 : -123456),
		),
	).toBe(true);
});
