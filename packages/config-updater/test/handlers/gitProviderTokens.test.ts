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
import { handleGitProviderTokens } from "../../src/handlers/gitProviderTokens.js";

vi.mock("node:child_process", () => ({
	execFileSync: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);

describe("handleGitProviderTokens", () => {
	let cyrusHome: string;

	beforeEach(() => {
		vi.clearAllMocks();
		cyrusHome = mkdtempSync(join(tmpdir(), "cyrus-provider-tokens-"));
	});

	afterEach(() => {
		rmSync(cyrusHome, { recursive: true, force: true });
	});

	it("persists provider-neutral tokens and configures the git helper", async () => {
		const response = await handleGitProviderTokens(
			{
				tokens: [
					{
						provider: "gitlab",
						host: "gitlab.com",
						namespace: "group/subgroup",
						connectionId: "conn-1",
						token: "glpat_token",
						expiresAt: null,
						username: "oauth2",
					},
				],
			},
			cyrusHome,
		);

		expect(response.success).toBe(true);
		const filePath = join(cyrusHome, "git-provider-tokens.json");
		expect(existsSync(filePath)).toBe(true);
		expect(statSync(filePath).mode & 0o777).toBe(0o600);
		const written = JSON.parse(readFileSync(filePath, "utf8"));
		expect(written.version).toBe(1);
		expect(written.tokens[0]).toMatchObject({
			provider: "gitlab",
			host: "gitlab.com",
			namespace: "group/subgroup",
		});
		expect(mockedExecFileSync).toHaveBeenCalledTimes(6);
	});

	it("rejects unsupported providers", async () => {
		const response = await handleGitProviderTokens(
			{
				tokens: [{ provider: "bitbucket", host: "bitbucket.org", token: "x" }],
			},
			cyrusHome,
		);

		expect(response.success).toBe(false);
		expect(existsSync(join(cyrusHome, "git-provider-tokens.json"))).toBe(false);
		expect(mockedExecFileSync).not.toHaveBeenCalled();
	});
});
