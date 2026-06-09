import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureGitHubCredentialHelper,
	handleGitHubTokens,
} from "../../src/handlers/githubTokens.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

function validPayload() {
	return {
		tokens: [
			{
				installationId: "111",
				organization: "OrgOne",
				accountType: "Organization",
				token: "ghs_one",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
			{
				installationId: "222",
				organization: null,
				accountType: "User",
				token: "ghs_two",
				expiresAt: new Date(Date.now() + 3600_000).toISOString(),
			},
		],
	};
}

describe("handleGitHubTokens", () => {
	let cyrusHome: string;

	beforeEach(() => {
		vi.clearAllMocks();
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-github-tokens-"));
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("persists tokens to github-tokens.json and returns success", async () => {
		const response = await handleGitHubTokens(validPayload(), cyrusHome);

		expect(response.success).toBe(true);
		if (response.success) {
			expect(response.data?.tokensCount).toBe(2);
		}

		const filePath = join(cyrusHome, "github-tokens.json");
		expect(existsSync(filePath)).toBe(true);
		const written = JSON.parse(readFileSync(filePath, "utf-8"));
		expect(written.version).toBe(1);
		expect(written.tokens).toHaveLength(2);
		expect(written.tokens[0].organization).toBe("OrgOne");
		expect(written.tokens[1].organization).toBeNull();
	});

	it("installs the credential helper script and configures git", async () => {
		const response = await handleGitHubTokens(validPayload(), cyrusHome);
		expect(response.success).toBe(true);

		const scriptPath = join(cyrusHome, "scripts", "git-credential-cyrus.cjs");
		expect(existsSync(scriptPath)).toBe(true);
		// Executable bit set
		expect(statSync(scriptPath).mode & 0o111).not.toBe(0);

		expect(mockedExecFileSync).toHaveBeenCalledTimes(3);
		expect(mockedExecFileSync).toHaveBeenNthCalledWith(
			1,
			"git",
			[
				"config",
				"--global",
				"credential.https://github.com.useHttpPath",
				"true",
			],
			expect.anything(),
		);
		expect(mockedExecFileSync).toHaveBeenNthCalledWith(
			2,
			"git",
			[
				"config",
				"--global",
				"--replace-all",
				"credential.https://github.com.helper",
				"",
			],
			expect.anything(),
		);
		expect(mockedExecFileSync).toHaveBeenNthCalledWith(
			3,
			"git",
			[
				"config",
				"--global",
				"--add",
				"credential.https://github.com.helper",
				`!node "${scriptPath}"`,
			],
			expect.anything(),
		);
	});

	it("is idempotent across repeated pushes", async () => {
		const first = await handleGitHubTokens(validPayload(), cyrusHome);
		const second = await handleGitHubTokens(validPayload(), cyrusHome);
		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		// Each push re-runs the same replace-all + add sequence (3 git calls each)
		expect(mockedExecFileSync).toHaveBeenCalledTimes(6);
	});

	it("rejects a payload without a tokens array", async () => {
		const response = await handleGitHubTokens({ nope: true }, cyrusHome);
		expect(response.success).toBe(false);
		if (!response.success) {
			expect(response.error).toBe("GitHub tokens payload validation failed");
		}
		expect(existsSync(join(cyrusHome, "github-tokens.json"))).toBe(false);
		expect(mockedExecFileSync).not.toHaveBeenCalled();
	});

	it("rejects token entries missing required fields", async () => {
		const response = await handleGitHubTokens(
			{ tokens: [{ installationId: "111", organization: "OrgOne" }] },
			cyrusHome,
		);
		expect(response.success).toBe(false);
		expect(existsSync(join(cyrusHome, "github-tokens.json"))).toBe(false);
	});

	it("returns an error when git configuration fails", async () => {
		mockedExecFileSync.mockImplementationOnce(() => {
			throw new Error("git not found");
		});
		const response = await handleGitHubTokens(validPayload(), cyrusHome);
		expect(response.success).toBe(false);
		if (!response.success) {
			expect(response.error).toBe("Failed to configure git credential helper");
		}
		// Tokens were still persisted before git config failed
		expect(existsSync(join(cyrusHome, "github-tokens.json"))).toBe(true);
	});
});

describe("ensureGitHubCredentialHelper", () => {
	let cyrusHome: string;

	beforeEach(() => {
		vi.clearAllMocks();
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-cred-helper-"));
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("returns the installed script path", () => {
		const scriptPath = ensureGitHubCredentialHelper(cyrusHome);
		expect(scriptPath).toBe(
			join(cyrusHome, "scripts", "git-credential-cyrus.cjs"),
		);
		expect(existsSync(scriptPath)).toBe(true);
	});
});
