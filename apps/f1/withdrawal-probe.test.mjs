import { afterEach, expect, it, vi } from "vitest";
import {
	installWithdrawalProbe,
	PREVIEW_ORIGIN,
	REVIEWED_RUNTIME_SHA,
} from "./withdrawal-probe.mjs";

let probe;
afterEach(() => {
	probe?.dispose();
	vi.useRealTimers();
});
function fixture(patch = {}, remaining = 60000, mode = "pause") {
	const target = {
		workspaceId: "workspace",
		automationId: "automation",
		scopeRef: "internal-customer",
		linearCustomerId: "external-customer",
		revision: 1,
	};
	const authority = {
		definition: {
			workspaceId: "workspace",
			id: "automation",
			revision: 1,
			role: "coordinator",
			namespace: "internal-customer",
			scopeRef: "internal-customer",
			grants: [
				{
					id: "grant",
					resource: { provider: "linear", customerId: "external-customer" },
					permissions: ["read"],
				},
			],
			...patch,
		},
		occurrenceId: "occurrence",
		attemptId: "attempt",
		fence: 1,
		phase: "execute",
		leaseUntil: new Date(Date.now() + remaining).toISOString(),
	};
	class FakeClient {
		url = new URL(`${PREVIEW_ORIGIN}/mcp`);
		names = new Set(["get_issue"]);
		references = new Set(["private-reference"]);
		client = {};
		transport = {
			sessionId: "private-session",
			_protocolVersion: "2025-11-25",
		};
		connectedCredential = {
			token: "private-token",
			grantId: "grant",
			audience: "/mcp",
			expiresAt: new Date(Date.now() + remaining).toISOString(),
		};
		queue = Promise.resolve();
		authority = () => authority;
		exclusive(fn) {
			const next = this.queue.then(fn);
			this.queue = next.catch(() => {});
			return next;
		}
		call() {
			return this.exclusive(async () => ({
				items: [{ text: "private-body" }],
			}));
		}
	}
	probe = installWithdrawalProbe(
		FakeClient,
		{ Client: class {} },
		{ target, mode },
	);
	return new FakeClient();
}
const arm = () => probe.command({ op: "arm", occurrenceId: "occurrence" });
const read = (c) =>
	c.call({ name: "get_issue", arguments: { reference: "private-reference" } });
const flush = async () => {
	for (let i = 0; i < 15; i++) await Promise.resolve();
};
it("does nothing without explicit arm and rejects forged command fields", async () => {
	const c = fixture();
	await read(c);
	expect(probe.status().phase).toBe("idle");
	await expect(
		probe.command({
			op: "arm",
			occurrenceId: "occurrence",
			customerId: "other",
		}),
	).rejects.toThrow();
	await expect(
		probe.command({ op: "read", name: "reply", text: "never" }),
	).rejects.toThrow();
	await expect(
		probe.command({
			op: "probe-paused",
			confirmedAt: new Date().toISOString(),
		}),
	).rejects.toThrow();
});
it("denies non-read operations on the armed occurrence before normal tool dispatch", async () => {
	const c = fixture();
	await arm();
	await expect(
		c.call({
			name: "delegate_investigation",
			arguments: { instruction: "never", tracking: "direct" },
		}),
	).rejects.toThrow("read-only");
	await expect(
		c.call({ name: "reply", arguments: { text: "never" } }),
	).rejects.toThrow("read-only");
	expect(probe.status().phase).toBe("armed");
});
it.each([
	{ workspaceId: "foreign" },
	{ id: "foreign" },
	{ revision: 2 },
	{ scopeRef: "foreign" },
	{ namespace: "foreign" },
	{ scopeRef: "external-customer", namespace: "external-customer" },
	{
		grants: [
			{
				id: "grant",
				resource: { provider: "linear", customerId: "internal-customer" },
				permissions: ["read"],
			},
		],
	},
	{ role: "investigator" },
	{
		grants: [
			{
				resource: { provider: "linear", customerId: "foreign" },
				permissions: ["read"],
			},
		],
	},
])("does not attach to another admitted scope: %j", async (patch) => {
	const c = fixture(patch);
	await arm();
	await read(c);
	expect(probe.status().phase).toBe("armed");
});
it("declares short natural expiry inconclusive instead of calling a local error a server denial", async () => {
	const c = fixture({}, 1000);
	await arm();
	await read(c);
	expect(probe.status().phase).toBe("inconclusive");
	expect(probe.status().events.map((e) => e.type)).toEqual([
		"armed",
		"inconclusive",
	]);
});
it("bounds the barrier, releases queued work and forgets private material on timeout", async () => {
	vi.useFakeTimers();
	const c = fixture();
	await arm();
	const pending = read(c);
	await flush();
	expect(probe.status().phase).toBe("ready");
	let ran = false;
	const queued = c.exclusive(async () => {
		ran = true;
	});
	await flush();
	expect(ran).toBe(false);
	await vi.advanceTimersByTimeAsync(45000);
	await pending;
	await queued;
	expect(ran).toBe(true);
	expect(probe.status().phase).toBe("inconclusive");
	expect(probe.status().expiresInMs).toBe(null);
	const serialized = JSON.stringify(probe.status());
	for (const secret of [
		"private-token",
		"private-session",
		"private-reference",
		"private-body",
	])
		expect(serialized).not.toContain(secret);
});
it("cancel restores ordinary calls and cannot arm a second occurrence", async () => {
	const c = fixture();
	await arm();
	const pending = read(c);
	await flush();
	await probe.command({ op: "cancel" });
	await pending;
	await read(c);
	expect(probe.status().phase).toBe("cancelled");
	await expect(
		probe.command({ op: "arm", occurrenceId: "other" }),
	).rejects.toThrow();
});

it("preloader is explicit, private, fixed-origin, source-pinned and exposes only a local socket", async () => {
	const { mkdtemp, mkdir, writeFile, symlink, chmod, rm, readFile } =
		await import("node:fs/promises");
	const { tmpdir } = await import("node:os");
	const { join } = await import("node:path");
	const { fileURLToPath } = await import("node:url");
	const { spawn, spawnSync } = await import("node:child_process");
	const { connect } = await import("node:net");
	const root = await mkdtemp(join(tmpdir(), "withdrawal-preload-test-"));
	const entry = fileURLToPath(
		new URL("./withdrawal-probe-preload.mjs", import.meta.url),
	);
	const worker = fileURLToPath(
		new URL("../../packages/edge-worker/", import.meta.url),
	);
	const control = join(root, "control"),
		runtimePackage = join(root, "runtime"),
		configPath = join(root, "config.json");
	let child;
	try {
		await mkdir(control, { mode: 0o700 });
		await mkdir(join(runtimePackage, "dist/automations"), { recursive: true });
		await writeFile(
			join(runtimePackage, "package.json"),
			JSON.stringify({
				name: "cyrus-edge-worker",
				type: "module",
				cyrusLocalTestArtifact: { sourceSha: REVIEWED_RUNTIME_SHA },
			}),
		);
		await symlink(
			join(worker, "node_modules"),
			join(runtimePackage, "node_modules"),
		);
		await writeFile(
			join(runtimePackage, "dist/automations/ScopedMcpClient.js"),
			`export { ScopedAutomationMcpClient } from ${JSON.stringify(join(worker, "dist/automations/ScopedMcpClient.js"))};`,
		);
		const config = {
			runtimePackage,
			directory: control,
			sourceSha: REVIEWED_RUNTIME_SHA,
			workspaceId: "workspace",
			automationId: "automation",
			scopeRef: "internal-customer",
			linearCustomerId: "external-customer",
			revision: 1,
		};
		await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
		const env = {
			...process.env,
			CYRUS_APP_URL: PREVIEW_ORIGIN,
			CYRUS_F1_WITHDRAWAL_CONFIG: configPath,
		};
		delete env.NODE_OPTIONS;
		const run = (patch = {}) =>
			spawnSync(process.execPath, ["--import", entry, "--eval", ""], {
				env: { ...env, ...patch },
				encoding: "utf8",
			});
		expect(run({ CYRUS_F1_WITHDRAWAL_CONFIG: "" }).status).not.toBe(0);
		expect(
			run({ CYRUS_APP_URL: "https://production.invalid" }).status,
		).not.toBe(0);
		await chmod(configPath, 0o644);
		expect(run().status).not.toBe(0);
		await chmod(configPath, 0o600);
		await writeFile(
			configPath,
			JSON.stringify({ ...config, sourceSha: "b".repeat(40) }),
		);
		expect(run().status).not.toBe(0);
		await writeFile(configPath, JSON.stringify(config));
		const existing = join(control, "control.sock");
		await writeFile(existing, "do-not-delete");
		expect(run().status).not.toBe(0);
		expect(await readFile(existing, "utf8")).toBe("do-not-delete");
		await rm(existing);
		await writeFile(
			configPath,
			JSON.stringify({ ...config, mode: "arbitrary" }),
		);
		expect(run().status).not.toBe(0);
		await writeFile(
			configPath,
			JSON.stringify({ ...config, mode: "source-withdrawal" }),
		);
		child = spawn(
			process.execPath,
			["--import", entry, "--eval", "setTimeout(()=>{},60000)"],
			{ env, stdio: ["ignore", "pipe", "pipe"] },
		);
		await new Promise((resolveReady, reject) => {
			const timer = setTimeout(() => reject(Error("preloader timeout")), 5000);
			child.once("exit", () => {
				clearTimeout(timer);
				reject(Error("preloader exited"));
			});
			child.stderr.on("data", (chunk) => {
				if (String(chunk).includes("private control ready")) {
					clearTimeout(timer);
					resolveReady();
				}
			});
		});
		const send = (command) =>
			new Promise((resolveResponse, reject) => {
				const socket = connect(existing);
				let data = "";
				socket.on("connect", () =>
					socket.write(`${JSON.stringify(command)}\n`),
				);
				socket.on("data", (chunk) => {
					data += chunk;
				});
				socket.on("error", reject);
				socket.on("end", () => resolveResponse(JSON.parse(data)));
			});
		expect((await send({ op: "status" })).phase).toBe("idle");
		expect((await send({ op: "status" })).mode).toBe("source-withdrawal");
		expect(
			await send({
				op: "arm",
				occurrenceId: "occurrence",
				token: "must-not-export",
			}),
		).toEqual({ error: "Probe command rejected" });
		expect((await send({ op: "arm", occurrenceId: "occurrence" })).phase).toBe(
			"armed",
		);
		expect((await send({ op: "cancel" })).phase).toBe("cancelled");
		expect(
			await readFile(join(control, "evidence.json"), "utf8"),
		).not.toContain("must-not-export");
	} finally {
		if (child && child.exitCode === null) {
			const exited = new Promise((resolveExit) =>
				child.once("exit", resolveExit),
			);
			child.kill();
			await exited;
		}
		await rm(root, { recursive: true, force: true });
	}
}, 15000);

it("source withdrawal rejects Pause/rebind controls and expired retained authority", async () => {
	vi.useFakeTimers();
	const c = fixture({}, 60000, "source-withdrawal");
	await arm();
	const pending = read(c).catch((error) => error.message);
	await flush();
	expect(probe.status().phase).toBe("ready");
	await expect(
		probe.command({
			op: "probe-paused",
			confirmedAt: new Date().toISOString(),
		}),
	).rejects.toThrow();
	await expect(
		probe.command({ op: "arm-current", occurrenceId: "other", revision: 2 }),
	).rejects.toThrow();
	vi.setSystemTime(Date.now() + 61000);
	expect(
		(
			await probe.command({
				op: "probe-removed",
				confirmedAt: new Date().toISOString(),
			})
		).phase,
	).toBe("inconclusive");
	expect(
		probe
			.status()
			.events.filter((e) => e.type === "probe")
			.every((e) => !e.httpObserved && !e.denied),
	).toBe(true);
	expect(probe.status().expiresInMs).toBe(null);
	await pending;
});
it("Pause mode cannot be switched to source withdrawal through commands", async () => {
	fixture();
	await arm();
	await expect(
		probe.command({
			op: "arm-current",
			occurrenceId: "different",
			revision: 2,
		}),
	).rejects.toThrow();
	await expect(
		probe.command({
			op: "probe-removed",
			confirmedAt: new Date().toISOString(),
		}),
	).rejects.toThrow();
	expect(probe.status().mode).toBe("pause");
});
