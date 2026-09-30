// Launch explicitly with node --import THIS_FILE and a private config. Never a runtime default.
import {
	chmodSync,
	closeSync,
	constants,
	fstatSync,
	lstatSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
	installWithdrawalProbe,
	PREVIEW_ORIGIN,
	REVIEWED_RUNTIME_SHA,
} from "./withdrawal-probe.mjs";

function privateFile(path) {
	if (!isAbsolute(path)) throw Error("Absolute private file required");
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.uid !== process.getuid() ||
			stat.mode & 0o077 ||
			stat.size > 8192
		)
			throw Error("Unsafe probe config");
		return JSON.parse(readFileSync(fd, "utf8"));
	} finally {
		closeSync(fd);
	}
}
const config = privateFile(process.env.CYRUS_F1_WITHDRAWAL_CONFIG ?? "");
if (
	Object.keys(config).sort().join(",") !==
		"automationId,customerId,directory,revision,runtimePackage,sourceSha,workspaceId" ||
	!["workspaceId", "automationId", "customerId"].every(
		(k) =>
			typeof config[k] === "string" && /^[a-zA-Z0-9_-]{1,200}$/.test(config[k]),
	) ||
	!Number.isSafeInteger(config.revision) ||
	config.revision < 1 ||
	config.sourceSha !== REVIEWED_RUNTIME_SHA ||
	!isAbsolute(config.runtimePackage) ||
	!isAbsolute(config.directory) ||
	new URL(process.env.CYRUS_APP_URL ?? "https://invalid").origin !==
		PREVIEW_ORIGIN
)
	throw Error("Invalid preview probe configuration");
const stat = lstatSync(config.directory);
if (
	!stat.isDirectory() ||
	stat.isSymbolicLink() ||
	stat.uid !== process.getuid() ||
	stat.mode & 0o077
)
	throw Error("Private owned probe directory required");
const packagePath = join(config.runtimePackage, "package.json");
const manifest = JSON.parse(readFileSync(packagePath, "utf8"));
if (
	manifest.name !== "cyrus-edge-worker" ||
	manifest.cyrusLocalTestArtifact?.sourceSha !== config.sourceSha
)
	throw Error("Exact unpublished runtime package required");
const require = createRequire(packagePath);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const {
	StreamableHTTPClientTransport,
} = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const { ScopedAutomationMcpClient } = await import(
	pathToFileURL(
		join(config.runtimePackage, "dist/automations/ScopedMcpClient.js"),
	)
);
const socketPath = join(config.directory, "control.sock");
const evidencePath = join(config.directory, "evidence.json");
const temporaryPath = join(config.directory, "evidence.next");
const target = {
	workspaceId: config.workspaceId,
	automationId: config.automationId,
	customerId: config.customerId,
	revision: config.revision,
};
const probe = installWithdrawalProbe(
	ScopedAutomationMcpClient,
	{ Client, StreamableHTTPClientTransport },
	{
		target,
		report: (status) => {
			writeFileSync(
				temporaryPath,
				`${JSON.stringify({ sourceSha: config.sourceSha, ...status }, null, 2)}\n`,
				{ mode: 0o600, flag: "wx" },
			);
			renameSync(temporaryPath, evidencePath);
		},
	},
);
const server = createServer((socket) => {
	socket.setTimeout(20000, () => socket.destroy());
	let input = "",
		used = false;
	socket.on("error", () => {});
	socket.on("data", (chunk) => {
		if (used) return socket.destroy();
		input += chunk.toString("utf8");
		if (input.length > 4096) return socket.destroy();
		if (!input.includes("\n")) return;
		used = true;
		void (async () => {
			try {
				socket.end(
					`${JSON.stringify(await probe.command(JSON.parse(input)))}\n`,
				);
			} catch {
				socket.end('{"error":"Probe command rejected"}\n');
			}
		})();
	});
});
// Never unlink a pre-existing socket: it may belong to another launch.
await new Promise((resolvePromise, reject) => {
	server.once("error", reject);
	server.listen(socketPath, resolvePromise);
});
chmodSync(socketPath, 0o600);
server.unref();
process.once("exit", () => {
	probe.dispose();
	try {
		unlinkSync(socketPath);
	} catch {}
});
process.stderr.write(
	"[F1 withdrawal probe] private control ready; not armed\n",
);
