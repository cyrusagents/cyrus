/** Private parent/child protocol for source-installed Miko launchers. */
export function registerManagedUpdates(
	prepare: () => boolean,
	shutdown: () => Promise<void>,
	channel: NodeJS.Process = process,
	activate: () => void = () => {},
): void {
	if (channel.env.MIKO_MANAGED_WORKER !== "1" || !channel.send) return;
	let stopping = false;
	channel.on("message", (message: unknown) => {
		if (
			message &&
			typeof message === "object" &&
			"type" in message &&
			message.type === "miko:activate-update" &&
			!stopping
		) {
			activate();
			channel.send?.({ type: "miko:activated" });
			return;
		}
		if (
			!message ||
			typeof message !== "object" ||
			!("type" in message) ||
			message.type !== "miko:prepare-update"
		)
			return;
		if (stopping) return;
		const accepted = prepare();
		stopping = accepted;
		channel.send?.({ type: "miko:update-restart", accepted }, () => {
			if (accepted) void shutdown();
		});
	});
	// Do not leave an orphan listening on the port after the supervisor exits.
	channel.once("disconnect", () => {
		if (!stopping) {
			stopping = true;
			void shutdown();
		}
	});
	channel.send({
		type: "miko:ready",
		autoUpdate: !["0", "false"].includes(
			channel.env.MIKO_AUTO_UPDATE?.toLowerCase() ?? "",
		),
	});
}
