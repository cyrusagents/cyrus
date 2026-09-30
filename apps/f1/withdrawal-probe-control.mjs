import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";

const [directory, op, value, revision, ...extra] = process.argv.slice(2);
if (!directory || !isAbsolute(directory))
	throw Error("Absolute private control directory required");
const dir = lstatSync(directory),
	path = join(directory, "control.sock"),
	sock = lstatSync(path);
if (
	!dir.isDirectory() ||
	dir.isSymbolicLink() ||
	dir.uid !== process.getuid() ||
	dir.mode & 0o077 ||
	!sock.isSocket() ||
	sock.uid !== process.getuid() ||
	sock.mode & 0o077
)
	throw Error("Unsafe probe control");
const command =
	op === "arm-current"
		? { op, occurrenceId: value, revision: Number(revision) }
		: op === "arm"
			? { op, occurrenceId: value }
			: [
						"probe-paused",
						"probe-resumed",
						"probe-removed",
						"probe-reconnected",
					].includes(op)
				? { op, confirmedAt: value }
				: { op };
if (
	extra.length ||
	(op !== "arm-current" && revision !== undefined) ||
	![
		"status",
		"cancel",
		"arm",
		"arm-current",
		"probe-paused",
		"probe-resumed",
		"probe-removed",
		"probe-reconnected",
	].includes(op) ||
	[
		"arm",
		"arm-current",
		"probe-paused",
		"probe-resumed",
		"probe-removed",
		"probe-reconnected",
	].includes(op) !== !!value
)
	throw Error("Invalid command");
await new Promise((resolve, reject) => {
	const socket = connect(path);
	let output = "";
	socket.setTimeout(20000, () =>
		socket.destroy(Error("Probe control timeout")),
	);
	socket.on("connect", () => socket.write(`${JSON.stringify(command)}\n`));
	socket.on("data", (chunk) => {
		output += chunk;
		if (output.length > 65536) socket.destroy(Error("Probe response bound"));
	});
	socket.on("error", reject);
	socket.on("end", () => {
		const result = JSON.parse(output);
		process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
		resolve();
	});
});
