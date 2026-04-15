import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
	createAppJwt,
	GitHubAppTokenProvider,
} from "../src/GitHubAppTokenProvider.js";

// Generate a test RSA key pair once for all tests
const { privateKey: testPrivateKeyObj, publicKey: testPublicKeyObj } =
	generateKeyPairSync("rsa", { modulusLength: 2048 });

const testPrivateKeyPem = testPrivateKeyObj
	.export({ type: "pkcs8", format: "pem" })
	.toString();

let tmpDir: string;
let pemPath: string;

beforeAll(async () => {
	tmpDir = await mkdtemp(join(tmpdir(), "github-app-test-"));
	pemPath = join(tmpDir, "test-app.pem");
	await writeFile(pemPath, testPrivateKeyPem);
});

afterAll(async () => {
	await rm(tmpDir, { recursive: true, force: true });
});

describe("createAppJwt", () => {
	it("produces a valid 3-part JWT", () => {
		const jwt = createAppJwt("12345", testPrivateKeyPem);
		const parts = jwt.split(".");
		expect(parts).toHaveLength(3);
	});

	it("sets correct header", () => {
		const jwt = createAppJwt("12345", testPrivateKeyPem);
		const header = JSON.parse(
			Buffer.from(jwt.split(".")[0], "base64url").toString(),
		);
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });
	});

	it("sets correct payload with iss = appId", () => {
		const jwt = createAppJwt("99999", testPrivateKeyPem);
		const payload = JSON.parse(
			Buffer.from(jwt.split(".")[1], "base64url").toString(),
		);
		expect(payload.iss).toBe("99999");
		expect(payload.exp).toBeGreaterThan(payload.iat);
		// JWT should expire in ~10 minutes
		expect(payload.exp - payload.iat).toBeLessThanOrEqual(11 * 60);
	});

	it("produces a verifiable RS256 signature", () => {
		const jwt = createAppJwt("12345", testPrivateKeyPem);
		const [headerB64, payloadB64, signatureB64] = jwt.split(".");
		const { createVerify } = require("node:crypto");
		const verify = createVerify("RSA-SHA256");
		verify.update(`${headerB64}.${payloadB64}`);
		const isValid = verify.verify(testPublicKeyObj, signatureB64, "base64url");
		expect(isValid).toBe(true);
	});
});

describe("GitHubAppTokenProvider", () => {
	it("mints a token by calling the GitHub API", async () => {
		const mockToken = "ghs_mock_installation_token_abc123";
		const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ token: mockToken, expires_at: expiresAt }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		const provider = new GitHubAppTokenProvider({
			appId: "12345",
			installationId: "67890",
			privateKeyPath: pemPath,
		});

		const token = await provider.getToken();
		expect(token).toBe(mockToken);

		// Verify the API call
		expect(fetchSpy).toHaveBeenCalledOnce();
		const [url, opts] = fetchSpy.mock.calls[0];
		expect(url).toBe(
			"https://api.github.com/app/installations/67890/access_tokens",
		);
		expect((opts as RequestInit).method).toBe("POST");
		expect(
			(opts as RequestInit).headers as Record<string, string>,
		).toHaveProperty("Authorization");

		fetchSpy.mockRestore();
	});

	it("returns cached token on subsequent calls", async () => {
		const mockToken = "ghs_cached_token";
		const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ token: mockToken, expires_at: expiresAt }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		const provider = new GitHubAppTokenProvider({
			appId: "12345",
			installationId: "67890",
			privateKeyPath: pemPath,
		});

		const token1 = await provider.getToken();
		const token2 = await provider.getToken();

		expect(token1).toBe(mockToken);
		expect(token2).toBe(mockToken);
		// Should only call fetch once (cached)
		expect(fetchSpy).toHaveBeenCalledOnce();

		fetchSpy.mockRestore();
	});

	it("refreshes token when close to expiry", async () => {
		const token1 = "ghs_first_token";
		const token2 = "ghs_refreshed_token";
		// Expires in 4 minutes (less than 5-minute buffer)
		const nearExpiry = new Date(Date.now() + 4 * 60 * 1000).toISOString();
		const farExpiry = new Date(Date.now() + 3600 * 1000).toISOString();

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ token: token1, expires_at: nearExpiry }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ token: token2, expires_at: farExpiry }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				}),
			);

		const provider = new GitHubAppTokenProvider({
			appId: "12345",
			installationId: "67890",
			privateKeyPath: pemPath,
		});

		const first = await provider.getToken();
		expect(first).toBe(token1);

		// Second call should refresh because token expires in < 5 minutes
		const second = await provider.getToken();
		expect(second).toBe(token2);
		expect(fetchSpy).toHaveBeenCalledTimes(2);

		fetchSpy.mockRestore();
	});

	it("throws on API error", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
			new Response("Unauthorized", {
				status: 401,
				statusText: "Unauthorized",
			}),
		);

		const provider = new GitHubAppTokenProvider({
			appId: "bad-id",
			installationId: "67890",
			privateKeyPath: pemPath,
		});

		await expect(provider.getToken()).rejects.toThrow(
			"Failed to create installation token: 401",
		);

		fetchSpy.mockRestore();
	});

	it("supports custom API base URL", async () => {
		const mockToken = "ghs_enterprise_token";
		const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();

		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({ token: mockToken, expires_at: expiresAt }),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				),
			);

		const provider = new GitHubAppTokenProvider({
			appId: "12345",
			installationId: "67890",
			privateKeyPath: pemPath,
			apiBaseUrl: "https://github.example.com/api/v3",
		});

		await provider.getToken();

		const [url] = fetchSpy.mock.calls[0];
		expect(url).toBe(
			"https://github.example.com/api/v3/app/installations/67890/access_tokens",
		);

		fetchSpy.mockRestore();
	});
});
