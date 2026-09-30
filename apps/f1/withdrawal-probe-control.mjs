import { lstatSync } from "node:fs";
import { connect } from "node:net";
import { isAbsolute, join } from "node:path";

const [directory, op, value] = process.argv.slice(2);
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
	op === "arm"
		? { op, occurrenceId: value }
		: op === "probe-paused" || op === "probe-resumed"
			? { op, confirmedAt: value }
			: { op };
if (
	!["status", "cancel", "arm", "probe-paused", "probe-resumed"].includes(op) ||
	["arm", "probe-paused", "probe-resumed"].includes(op) !== !!value
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
