import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	ensureGhWrapperSupportsCyrusToken,
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

		// The per-invocation gh token resolver is installed alongside.
		expect(existsSync(join(cyrusHome, "scripts", "gh-cyrus.cjs"))).toBe(true);

		const scriptPath = join(cyrusHome, "scripts", "git-credential-cyrus.cjs");
		expect(existsSync(scriptPath)).toBe(true);
		// Executable bit set
		expect(statSync(scriptPath).mode & 0o111).not.toBe(0);

		expect(mockedExecFileSync).toHaveBeenCalledTimes(7);
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

	it("refreshes gh CLI auth with the first pushed token", async () => {
		const payload = validPayload();
		const response = await handleGitHubTokens(payload, cyrusHome);
		expect(response.success).toBe(true);
		if (response.success) {
			expect(response.data?.ghAuthConfigured).toBe(true);
		}
		expect(mockedExecFileSync).toHaveBeenNthCalledWith(
			7,
			"gh",
			["auth", "login", "--with-token"],
			expect.objectContaining({ input: payload.tokens[0].token }),
		);
	});

	it("succeeds even when gh CLI auth fails (gh not installed)", async () => {
		// First 3 calls (git config) succeed; the gh call throws.
		mockedExecFileSync.mockImplementation((cmd: unknown) => {
			if (cmd === "gh") throw new Error("gh: command not found");
			return Buffer.from("");
		});
		const response = await handleGitHubTokens(validPayload(), cyrusHome);
		expect(response.success).toBe(true);
		if (response.success) {
			expect(response.data?.ghAuthConfigured).toBe(false);
		}
	});

	it("is idempotent across repeated pushes", async () => {
		const first = await handleGitHubTokens(validPayload(), cyrusHome);
		const second = await handleGitHubTokens(validPayload(), cyrusHome);
		expect(first.success).toBe(true);
		expect(second.success).toBe(true);
		// Each push re-runs the same replace-all + add for github.com and
		// gitlab.com, then refreshes gh auth (6 git calls + 1 gh call each).
		expect(mockedExecFileSync).toHaveBeenCalledTimes(14);
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

describe("ensureGhWrapperSupportsCyrusToken", () => {
	const OLD_WRAPPER = `#!/usr/bin/env bash
exec env -u GITHUB_TOKEN -u GH_TOKEN /usr/bin/gh "$@"
`;
	let home: string;

	beforeEach(() => {
		vi.clearAllMocks();
		home = mkdtempSync(join(tmpdir(), "cyrus-gh-wrapper-"));
	});

	afterEach(() => {
		rmSync(home, { recursive: true, force: true });
	});

	function writeWrapper(content: string): string {
		const binDir = join(home, ".local", "bin");
		mkdirSync(binDir, { recursive: true });
		const wrapperPath = join(binDir, "gh");
		writeFileSync(wrapperPath, content, { mode: 0o755 });
		return wrapperPath;
	}

	it("rewrites an old strip-everything wrapper to honor CYRUS_GH_TOKEN", () => {
		const wrapperPath = writeWrapper(OLD_WRAPPER);

		expect(ensureGhWrapperSupportsCyrusToken(home)).toBe(true);

		const updated = readFileSync(wrapperPath, "utf8");
		expect(updated).toContain("CYRUS_GH_TOKEN");
		expect(updated).toContain('GH_TOKEN="$CYRUS_GH_TOKEN"');
		expect(updated).toContain("-u GITHUB_TOKEN");
		expect(statSync(wrapperPath).mode & 0o111).not.toBe(0);
	});

	it("upgrades the interim CYRUS_GH_TOKEN-only wrapper to the resolver", () => {
		const interim = `#!/usr/bin/env bash
if [ -n "\${CYRUS_GH_TOKEN:-}" ]; then
  exec env -u GITHUB_TOKEN GH_TOKEN="$CYRUS_GH_TOKEN" /usr/bin/gh "$@"
fi
exec env -u GITHUB_TOKEN -u GH_TOKEN /usr/bin/gh "$@"
`;
		const wrapperPath = writeWrapper(interim);

		expect(ensureGhWrapperSupportsCyrusToken(home)).toBe(true);
		expect(readFileSync(wrapperPath, "utf8")).toContain("gh-cyrus.cjs");
	});

	it("leaves an already-updated wrapper untouched", () => {
		const wrapperPath = writeWrapper(OLD_WRAPPER);
		expect(ensureGhWrapperSupportsCyrusToken(home)).toBe(true);
		const afterFirst = readFileSync(wrapperPath, "utf8");

		expect(ensureGhWrapperSupportsCyrusToken(home)).toBe(false);
		expect(readFileSync(wrapperPath, "utf8")).toBe(afterFirst);
	});

	it("does not touch a wrapper with an unrecognized shape", () => {
		const custom = '#!/bin/sh\nexec /opt/custom/gh "$@"\n';
		const wrapperPath = writeWrapper(custom);

		expect(ensureGhWrapperSupportsCyrusToken(home)).toBe(false);
		expect(readFileSync(wrapperPath, "utf8")).toBe(custom);
	});

	it("is a no-op when no wrapper exists (self-host)", () => {
		expect(ensureGhWrapperSupportsCyrusToken(home)).toBe(false);
	});

	it("runs during a token push when cyrusHome sits inside the home dir", async () => {
		const wrapperPath = writeWrapper(OLD_WRAPPER);
		const nestedCyrusHome = join(home, ".cyrus");
		mkdirSync(nestedCyrusHome, { recursive: true });

		const response = await handleGitHubTokens(
			{
				tokens: [
					{
						installationId: "111",
						organization: "OrgOne",
						accountType: "Organization",
						token: "ghs_one",
						expiresAt: new Date(Date.now() + 3600_000).toISOString(),
					},
				],
			},
			nestedCyrusHome,
		);

		expect(response.success).toBe(true);
		expect(readFileSync(wrapperPath, "utf8")).toContain("CYRUS_GH_TOKEN");
	});
});
