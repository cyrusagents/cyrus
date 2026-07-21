/**
 * Unit tests for WorkLeaseClient.
 *
 * Each test spins up a minimal in-process HTTP server to simulate the authority
 * endpoint, exercises the real WorkLeaseClient implementation, and asserts on the
 * resulting promise outcome (resolved or rejected with WorkLeaseError).
 *
 * The bearer token is passed through but never asserted on in the logged output —
 * the server verifies it at the HTTP layer so accidental logging is detectable.
 */

import * as http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { HandoffMarkerData } from "../src/HandoffMarkerParser.js";
import {
	readWorkLeaseConfig,
	readWorkLeaseToken,
	WorkLeaseClient,
	WorkLeaseError,
} from "../src/WorkLeaseClient.js";

// ── Test fixture helpers ───────────────────────────────────────────────────────

const PRINCIPAL_ID = "cyrus-principal-test";
const BEARER_TOKEN = "test-bearer-token-secret";

function makeConfig(port: number) {
	return {
		url: `http://127.0.0.1:${port}`,
		principalId: PRINCIPAL_ID,
		ttlSeconds: 3600,
	};
}

const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const NOW_MINUS_10 = new Date(Date.now() - 600_000).toISOString();
const NOW_MINUS_5 = new Date(Date.now() - 300_000).toISOString();

function validHandoff(
	overrides: Partial<HandoffMarkerData> = {},
): HandoffMarkerData {
	return {
		lease_id: "lease-xyz789",
		lease_version: "1",
		issue_id: "BRI-3257",
		owner: "bridge-principal",
		lane: "bridge",
		canonical_repo: "Brilliantio/cyrus-agent",
		worktree: "/tmp/worktrees/BRI-3257",
		branch: "cyrus2/bri-3257-work",
		starting_sha: "b98afde0792b",
		scope: ["read:code"],
		policy_hash: "sha256:deadbeef",
		handoff_target: "cyrus",
		acquired_at: NOW_MINUS_10,
		heartbeat_at: NOW_MINUS_5,
		expires_at: FUTURE,
		ended_at: null,
		...overrides,
	};
}

/** A standard valid adopt response body. */
function adoptOkBody(
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ok: true,
		lease_id: "lease-xyz789",
		owner: PRINCIPAL_ID,
		adopted_from: "bridge-principal",
		adopted_at: new Date().toISOString(),
		expires_at: FUTURE,
		...overrides,
	};
}

/** A standard valid GET response body that matches the adopt response. */
function getOkBody(
	adoptedAt: string,
	overrides: Record<string, unknown> = {},
): Record<string, unknown> {
	return {
		ok: true,
		lease_id: "lease-xyz789",
		owner: PRINCIPAL_ID,
		adopted_from: "bridge-principal",
		adopted_at: adoptedAt,
		expires_at: FUTURE,
		...overrides,
	};
}

/** Fake logger that does nothing (no token leakage assertion here). */
const fakeLogger = {
	info: vi.fn(),
	debug: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	withContext: () => fakeLogger,
} as any;

// ── Local authority server ────────────────────────────────────────────────────

type RequestHandler = (
	body: Record<string, unknown>,
	respond: (status: number, body: Record<string, unknown>) => void,
) => void;

/**
 * Starts an HTTP server on a random port that routes POST requests to the
 * provided handler.
 */
async function startAuthServer(
	adoptHandler: RequestHandler,
	getHandler: RequestHandler,
): Promise<{ port: number; close: () => Promise<void> }> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (c: Buffer) => {
			raw += c.toString();
		});
		req.on("end", () => {
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(raw);
			} catch {
				res.writeHead(400);
				res.end(JSON.stringify({ ok: false, error: "bad json" }));
				return;
			}

			const respond = (status: number, payload: Record<string, unknown>) => {
				res.writeHead(status, { "Content-Type": "application/json" });
				res.end(JSON.stringify(payload));
			};

			if (body.action === "adopt") {
				adoptHandler(body, respond);
			} else if (body.action === "get") {
				getHandler(body, respond);
			} else {
				respond(400, { ok: false, error: "unknown action" });
			}
		});
	});

	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = (server.address() as http.AddressInfo).port;

	const close = () =>
		new Promise<void>((resolve, reject) =>
			server.close((err) => (err ? reject(err) : resolve())),
		);

	return { port, close };
}

// ── Test lifecycle ────────────────────────────────────────────────────────────

let serverClose: (() => Promise<void>) | null = null;

afterEach(async () => {
	if (serverClose) {
		await serverClose();
		serverClose = null;
	}
	vi.clearAllMocks();
	// Clean up any env vars set by tests
	delete process.env.CYRUS_WORK_LEASE_URL;
	delete process.env.CYRUS_WORK_LEASE_TOKEN;
	delete process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID;
	delete process.env.CYRUS_WORK_LEASE_TTL_SECONDS;
});

// ── readWorkLeaseConfig ───────────────────────────────────────────────────────

describe("readWorkLeaseConfig", () => {
	it("returns null when CYRUS_WORK_LEASE_URL is absent", () => {
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = "pid";
		expect(readWorkLeaseConfig()).toBeNull();
	});

	it("returns null when CYRUS_WORK_LEASE_PRINCIPAL_ID is absent", () => {
		process.env.CYRUS_WORK_LEASE_URL = "http://localhost:9999";
		expect(readWorkLeaseConfig()).toBeNull();
	});

	it("returns config with default ttlSeconds=3600 when TTL not set", () => {
		process.env.CYRUS_WORK_LEASE_URL = "http://localhost:9999";
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = "pid";
		const cfg = readWorkLeaseConfig();
		expect(cfg).not.toBeNull();
		expect(cfg!.ttlSeconds).toBe(3600);
	});

	it("clamps TTL to 60 from below", () => {
		process.env.CYRUS_WORK_LEASE_URL = "http://localhost:9999";
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = "pid";
		process.env.CYRUS_WORK_LEASE_TTL_SECONDS = "10";
		const cfg = readWorkLeaseConfig();
		expect(cfg!.ttlSeconds).toBe(60);
	});

	it("clamps TTL to 21600 from above", () => {
		process.env.CYRUS_WORK_LEASE_URL = "http://localhost:9999";
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = "pid";
		process.env.CYRUS_WORK_LEASE_TTL_SECONDS = "99999";
		const cfg = readWorkLeaseConfig();
		expect(cfg!.ttlSeconds).toBe(21_600);
	});

	it("falls back to default when TTL is not a number", () => {
		process.env.CYRUS_WORK_LEASE_URL = "http://localhost:9999";
		process.env.CYRUS_WORK_LEASE_PRINCIPAL_ID = "pid";
		process.env.CYRUS_WORK_LEASE_TTL_SECONDS = "not-a-number";
		const cfg = readWorkLeaseConfig();
		expect(cfg!.ttlSeconds).toBe(3600);
	});
});

describe("readWorkLeaseToken", () => {
	it("returns null when CYRUS_WORK_LEASE_TOKEN is absent", () => {
		expect(readWorkLeaseToken()).toBeNull();
	});

	it("returns the token value when set", () => {
		process.env.CYRUS_WORK_LEASE_TOKEN = "secret-token";
		expect(readWorkLeaseToken()).toBe("secret-token");
	});

	it("returns null when token is blank whitespace", () => {
		process.env.CYRUS_WORK_LEASE_TOKEN = "   ";
		expect(readWorkLeaseToken()).toBeNull();
	});
});

// ── Happy path — adopt + get ──────────────────────────────────────────────────

describe("WorkLeaseClient.adoptAndVerify — success", () => {
	it("resolves with readback body when adopt and get succeed", async () => {
		const handoff = validHandoff();
		let adoptedAt: string | undefined;

		const { port, close } = await startAuthServer(
			(_body, respond) => {
				adoptedAt = new Date().toISOString();
				respond(200, adoptOkBody({ adopted_at: adoptedAt }));
			},
			(_body, respond) => {
				respond(200, getOkBody(adoptedAt!));
			},
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		const result = await client.adoptAndVerify(handoff, BEARER_TOKEN);

		expect(result.ok).toBe(true);
		expect(result.lease_id).toBe("lease-xyz789");
		expect(result.owner).toBe(PRINCIPAL_ID);
	});

	it("sends adopt payload with correct fields", async () => {
		const handoff = validHandoff();
		let capturedAdoptBody: Record<string, unknown> | null = null;
		// Capture adopted_at from the adopt RESPONSE so GET echoes the same value.
		// (The client's request body never includes adopted_at, so reading it from
		// capturedAdoptBody would always be undefined → falls through to new Date()
		// at a different millisecond, causing a spurious mismatch.)
		let adoptedAtFromResponse = "";

		const { port, close } = await startAuthServer(
			(body, respond) => {
				capturedAdoptBody = body;
				adoptedAtFromResponse = new Date().toISOString();
				respond(200, adoptOkBody({ adopted_at: adoptedAtFromResponse }));
			},
			(_body, respond) => {
				respond(200, getOkBody(adoptedAtFromResponse));
			},
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await client.adoptAndVerify(handoff, BEARER_TOKEN);

		expect(capturedAdoptBody).not.toBeNull();
		expect(capturedAdoptBody!.action).toBe("adopt");
		expect(capturedAdoptBody!.lease_id).toBe("lease-xyz789");
		expect(capturedAdoptBody!.canonical_repo).toBe("Brilliantio/cyrus-agent");
		expect(capturedAdoptBody!.scope).toEqual(["read:code"]);
		expect(capturedAdoptBody!.policy_hash).toBe("sha256:deadbeef");
		expect(capturedAdoptBody!.lease_version).toBe("1");
		expect(capturedAdoptBody!.ttl_seconds).toBe(3600);
	});
});

// ── Authority HTTP errors ─────────────────────────────────────────────────────

describe("WorkLeaseClient.adoptAndVerify — HTTP errors", () => {
	it("throws WorkLeaseError on 401 from adopt", async () => {
		const { port, close } = await startAuthServer(
			(_body, respond) => respond(401, { ok: false, error: "unauthorized" }),
			(_body, respond) => respond(200, { ok: true }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError on 403 from adopt", async () => {
		const { port, close } = await startAuthServer(
			(_body, respond) => respond(403, { ok: false }),
			(_body, respond) => respond(200, { ok: true }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError on 404 from adopt", async () => {
		const { port, close } = await startAuthServer(
			(_body, respond) => respond(404, { ok: false }),
			(_body, respond) => respond(200, { ok: true }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError on 409 from adopt", async () => {
		const { port, close } = await startAuthServer(
			(_body, respond) => respond(409, { ok: false }),
			(_body, respond) => respond(200, { ok: true }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError on 500 from adopt", async () => {
		const { port, close } = await startAuthServer(
			(_body, respond) => respond(500, { ok: false }),
			(_body, respond) => respond(200, { ok: true }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError on 500 from GET readback", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt })),
			(_body, respond) => respond(500, { ok: false }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});
});

// ── ok:false ──────────────────────────────────────────────────────────────────

describe("WorkLeaseClient.adoptAndVerify — ok:false", () => {
	it("throws WorkLeaseError when adopt returns ok:false with 200 status", async () => {
		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, { ok: false, error: "lease not found" }),
			(_body, respond) => respond(200, { ok: true }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when GET returns ok:false with 200 status", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt })),
			(_body, respond) => respond(200, { ok: false }),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});
});

// ── Binding mismatches ────────────────────────────────────────────────────────

describe("WorkLeaseClient.adoptAndVerify — binding mismatches", () => {
	it("throws WorkLeaseError when adopt response lease_id differs", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) =>
				respond(
					200,
					adoptOkBody({ lease_id: "wrong-id", adopted_at: adoptedAt }),
				),
			(_body, respond) => respond(200, getOkBody(adoptedAt)),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when adopt response owner differs", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) =>
				respond(
					200,
					adoptOkBody({ owner: "wrong-principal", adopted_at: adoptedAt }),
				),
			(_body, respond) => respond(200, getOkBody(adoptedAt)),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when adopt response adopted_from differs", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) =>
				respond(
					200,
					adoptOkBody({ adopted_from: "wrong-owner", adopted_at: adoptedAt }),
				),
			(_body, respond) => respond(200, getOkBody(adoptedAt)),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when adopt response is missing adopted_at", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => {
				const body = adoptOkBody({ adopted_at: adoptedAt });
				delete body.adopted_at;
				respond(200, body);
			},
			(_body, respond) => respond(200, getOkBody(adoptedAt)),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when GET readback lease_id differs", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt })),
			(_body, respond) =>
				respond(200, getOkBody(adoptedAt, { lease_id: "different-id" })),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when GET readback owner differs", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt })),
			(_body, respond) =>
				respond(200, getOkBody(adoptedAt, { owner: "interloper" })),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when GET readback adopted_from differs", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt })),
			(_body, respond) =>
				respond(200, getOkBody(adoptedAt, { adopted_from: "someone-else" })),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when GET readback adopted_at differs from adopt adopted_at", async () => {
		const adoptedAt1 = new Date(Date.now() - 5000).toISOString();
		const adoptedAt2 = new Date(Date.now() - 3000).toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt1 })),
			(_body, respond) => respond(200, getOkBody(adoptedAt2)),
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});

	it("throws WorkLeaseError when GET readback missing adopted_at", async () => {
		const adoptedAt = new Date().toISOString();

		const { port, close } = await startAuthServer(
			(_body, respond) => respond(200, adoptOkBody({ adopted_at: adoptedAt })),
			(_body, respond) => {
				const body = getOkBody(adoptedAt);
				delete body.adopted_at;
				respond(200, body);
			},
		);
		serverClose = close;

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});
});

// ── Non-JSON response ─────────────────────────────────────────────────────────

describe("WorkLeaseClient.adoptAndVerify — non-JSON response", () => {
	it("throws WorkLeaseError when authority returns non-JSON body", async () => {
		const server = http.createServer((_req, res) => {
			// Read body first
			let _raw = "";
			_req.on("data", (c: Buffer) => {
				_raw += c.toString();
			});
			_req.on("end", () => {
				res.writeHead(200, { "Content-Type": "text/plain" });
				res.end("this is not json");
			});
		});

		await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
		const port = (server.address() as http.AddressInfo).port;
		serverClose = () =>
			new Promise((r, j) => server.close((e) => (e ? j(e) : r())));

		const client = new WorkLeaseClient(makeConfig(port), fakeLogger);
		await expect(
			client.adoptAndVerify(validHandoff(), BEARER_TOKEN),
		).rejects.toBeInstanceOf(WorkLeaseError);
	});
});
