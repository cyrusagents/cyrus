import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { registerManagedUpdates } from "../src/ManagedUpdateController.js";

function channel() {
	const channel = new EventEmitter() as NodeJS.Process;
	channel.env = { MIKO_MANAGED_WORKER: "1" };
	channel.send = vi.fn((_data, callback) => {
		callback?.(null);
		return true;
	}) as NodeJS.Process["send"];
	return channel;
}

describe("managed update IPC", () => {
	it("opens a verified candidate only after the launcher activates it", () => {
		const process = channel();
		const activate = vi.fn();
		registerManagedUpdates(() => false, vi.fn(), process, activate);
		expect(activate).not.toHaveBeenCalled();
		process.emit("message", { type: "miko:activate-update" });
		expect(activate).toHaveBeenCalledTimes(1);
		expect(process.send).toHaveBeenCalledWith({ type: "miko:activated" });
	});
	it("keeps a busy worker alive and shuts down once an idle drain is accepted", () => {
		const process = channel();
		const prepare = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
		const shutdown = vi.fn().mockResolvedValue(undefined);
		registerManagedUpdates(prepare, shutdown, process);
		expect(process.send).toHaveBeenCalledWith({
			type: "miko:ready",
			autoUpdate: true,
		});
		process.emit("message", { type: "miko:prepare-update" });
		expect(shutdown).not.toHaveBeenCalled();
		process.emit("message", { type: "miko:prepare-update" });
		process.emit("message", { type: "miko:prepare-update" });
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
	it("does not register updates for direct CLI runs and forwards an explicit opt-out", () => {
		const process = channel();
		process.env = {};
		registerManagedUpdates(() => true, vi.fn(), process);
		expect(process.send).not.toHaveBeenCalled();
		process.env = { MIKO_MANAGED_WORKER: "1", MIKO_AUTO_UPDATE: "false" };
		registerManagedUpdates(() => true, vi.fn(), process);
		expect(process.send).toHaveBeenCalledWith({
			type: "miko:ready",
			autoUpdate: false,
		});
	});
	it("stops an orphaned worker if the launcher exits", () => {
		const process = channel();
		const shutdown = vi.fn().mockResolvedValue(undefined);
		registerManagedUpdates(() => false, shutdown, process);
		process.emit("disconnect");
		expect(shutdown).toHaveBeenCalledTimes(1);
	});
});
