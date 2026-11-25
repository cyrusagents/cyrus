#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

function fail(message) {
	process.stderr.write(`ERROR: ${message}\n`);
	process.exitCode = 1;
}

function parseArguments(argv) {
	const options = { cli: undefined, timeoutMs: 20_000, cliArguments: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--cli") {
			options.cli = argv[++index];
		} else if (argument === "--timeout-ms") {
			options.timeoutMs = Number(argv[++index]);
		} else if (argument === "--") {
			options.cliArguments = argv.slice(index + 1);
			break;
		} else {
			throw new Error(`Unknown argument: ${argument}`);
		}
	}

	if (!options.cli) throw new Error("--cli is required");
	if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 100) {
		throw new Error("--timeout-ms must be an integer of at least 100");
	}
	return options;
}

function stopProcessGroup(child, signal) {
	if (!child.pid || child.exitCode !== null) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch (error) {
		if (error.code !== "ESRCH") throw error;
	}
}

let options;
try {
	options = parseArguments(process.argv.slice(2));
} catch (error) {
	fail(error.message);
	process.exit();
}

const isolatedHome = mkdtempSync(join(tmpdir(), "claude-tool-extraction-"));
const configDirectory = join(isolatedHome, "claude-config");
mkdirSync(configDirectory, { recursive: true });

let providerRequests = 0;
const provider = createServer((request, response) => {
	providerRequests += 1;
	request.resume();
	response.writeHead(401, { "content-type": "application/json" });
	response.end(
		JSON.stringify({
			type: "error",
			error: {
				type: "authentication_error",
				message: "local extraction fixture",
			},
		}),
	);
});

await new Promise((resolve, reject) => {
	provider.once("error", reject);
	provider.listen(0, "127.0.0.1", resolve);
});

const address = provider.address();
if (!address || typeof address === "string") {
	provider.close();
	rmSync(isolatedHome, { force: true, recursive: true });
	fail("Could not bind the loopback provider fixture");
	process.exit();
}

// Intentionally construct the child environment rather than copying process.env.
// This prevents operator credentials and provider-selection flags (Bedrock,
// Vertex, Foundry, custom gateways, proxies, and Claude login state) from
// influencing this inventory-only check.
const childEnvironment = {
	ANTHROPIC_API_KEY: "credential-free-local-extraction",
	ANTHROPIC_BASE_URL: `http://127.0.0.1:${address.port}`,
	CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
	CLAUDE_CODE_ENABLE_TODO_TOOLS: "1",
	CLAUDE_CONFIG_DIR: configDirectory,
	DISABLE_TELEMETRY: "1",
	HOME: isolatedHome,
	LANG: "C.UTF-8",
	LC_ALL: "C.UTF-8",
	NO_PROXY: "127.0.0.1,localhost",
	PATH: process.env.PATH ?? "/usr/bin:/bin",
	TMPDIR: isolatedHome,
	XDG_CACHE_HOME: join(isolatedHome, "cache"),
	XDG_CONFIG_HOME: join(isolatedHome, "config"),
};

const child = spawn(options.cli, options.cliArguments, {
	detached: process.platform !== "win32",
	env: childEnvironment,
	stdio: ["ignore", "pipe", "pipe"],
});

let initMessage;
let stderr = "";
let timedOut = false;
const lines = createInterface({ input: child.stdout });
lines.on("line", (line) => {
	try {
		const message = JSON.parse(line);
		if (message.type === "system" && message.subtype === "init") {
			initMessage = message;
			stopProcessGroup(child, "SIGTERM");
		}
	} catch {
		// The native CLI may print non-JSON diagnostics before stream-json starts.
	}
});
child.stderr.on("data", (chunk) => {
	stderr = `${stderr}${chunk}`.slice(-4_000);
});

const deadline = setTimeout(() => {
	timedOut = true;
	stopProcessGroup(child, "SIGTERM");
	setTimeout(() => stopProcessGroup(child, "SIGKILL"), 500).unref();
}, options.timeoutMs);

let childError;
child.once("error", (error) => {
	childError = error;
});
await new Promise((resolve) => child.once("close", resolve));
clearTimeout(deadline);
lines.close();
await new Promise((resolve) => provider.close(resolve));
rmSync(isolatedHome, { force: true, recursive: true });

if (initMessage) {
	process.stdout.write(`${JSON.stringify(initMessage)}\n`);
} else if (childError) {
	fail(`Claude Code failed to start: ${childError.message}`);
} else if (timedOut) {
	fail(
		`Claude Code did not emit init within ${options.timeoutMs}ms (loopback provider requests: ${providerRequests})`,
	);
} else {
	fail(
		`Claude Code exited before init (loopback provider requests: ${providerRequests})${stderr.trim() ? `: ${stderr.trim()}` : ""}`,
	);
}
