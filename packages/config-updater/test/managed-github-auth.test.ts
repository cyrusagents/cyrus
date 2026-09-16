import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleGitHubTokens } from "../src/handlers/githubTokens.js";

const scripts = join(__dirname, "..", "scripts");
const token = (organization: string, value = `synthetic-${organization}`) => ({
	installationId: organization,
	organization,
	accountType: "Organization",
	token: value,
	expiresAt: new Date(Date.now() + 3600000).toISOString(),
});

describe("managed GitHub credential revocation (real subprocesses, synthetic credentials)", () => {
	let home: string;
	let store: string;
	let env: NodeJS.ProcessEnv;
	let native: string;
	let launched: string;
	let fallback: string;
	const save = (tokens: unknown[]) =>
		writeFileSync(store, JSON.stringify({ version: 1, tokens }));
	const gh = (args = ["api", "user"], extra = {}) =>
		spawnSync(process.execPath, [join(scripts, "gh-cyrus.cjs"), ...args], {
			cwd: home,
			env: { ...env, ...extra },
			encoding: "utf8",
		});
	const git = (org = "Removed") =>
		spawnSync(
			"git",
			[
				"-c",
				"credential.helper=",
				"-c",
				`credential.helper=!${process.execPath} ${join(scripts, "git-credential-cyrus.cjs")}`,
				"-c",
				`credential.helper=!${process.execPath} ${fallback}`,
				"-c",
				"credential.useHttpPath=true",
				"credential",
				"fill",
			],
			{
				cwd: home,
				env,
				encoding: "utf8",
				input: `protocol=https\nhost=github.com\npath=${org}/repo.git\n\n`,
			},
		);
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "cyrus-revocation-"));
		mkdirSync(join(home, ".cyrus"));
		mkdirSync(join(home, ".config", "gh"), { recursive: true });
		store = join(home, ".cyrus", "github-tokens.json");
		launched = join(home, "launched");
		native = join(home, "native-gh");
		fallback = join(home, "keyring.cjs");
		writeFileSync(
			join(home, ".config", "gh", "hosts.yml"),
			"github.com:\n  oauth_token: synthetic-cached\n",
		);
		writeFileSync(
			native,
			`#!${process.execPath}\nconst fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(launched)},'yes'); console.log(process.env.GH_TOKEN || 'synthetic-cached');`,
			{ mode: 0o755 },
		);
		writeFileSync(
			fallback,
			`require('node:fs').writeFileSync(${JSON.stringify(join(home, "keyring-read"))},'yes'); console.log('username=cached\\npassword=synthetic-keyring');`,
		);
		env = {
			PATH: process.env.PATH,
			HOME: home,
			XDG_CONFIG_HOME: join(home, ".config"),
			GH_CONFIG_DIR: join(home, ".config", "gh"),
			CYRUS_HOME: join(home, ".cyrus"),
			CYRUS_GH_REAL_BIN: native,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: join(home, ".gitconfig"),
			GIT_TERMINAL_PROMPT: "0",
			GH_TOKEN: "synthetic-ambient",
			GITHUB_TOKEN: "synthetic-ambient",
		};
	});
	afterEach(() => rmSync(home, { recursive: true, force: true }));
	for (const state of [
		"empty",
		"expired",
		"corrupt",
		"invalid-version",
		"invalid-shape",
		"unreadable",
		"missing-managed",
	] as const) {
		it(`refuses ${state} stores without native gh, cached keyring, or stale session fallback`, () => {
			save([]);
			if (state === "expired")
				save([{ ...token("Removed"), expiresAt: "2000-01-01T00:00:00Z" }]);
			if (state === "corrupt") writeFileSync(store, "{");
			if (state === "invalid-version")
				writeFileSync(store, '{"version":2,"tokens":[]}');
			if (state === "invalid-shape")
				save([{ ...token("Removed"), token: "bad\npassword=injected" }]);
			if (state === "unreadable") {
				rmSync(store);
				mkdirSync(store);
			}
			if (state === "missing-managed") {
				rmSync(store);
				writeFileSync(join(home, ".cyrus", "github-auth-managed"), "1\n");
			}
			for (const extra of [{}, { CYRUS_GH_TOKEN: "synthetic-stale" }]) {
				const result = gh(undefined, extra);
				expect(result.status).not.toBe(0);
				expect(result.stdout).toBe("");
				expect(existsSync(launched)).toBe(false);
			}
			const result = git();
			expect(result.status).not.toBe(0);
			expect(result.stdout).not.toContain("password=");
			expect(existsSync(join(home, "keyring-read"))).toBe(false);
			expect(
				readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"),
			).toContain("synthetic-cached");
		});
	}
	it("removing one org denies that org while the other continues, without stale session substitution", () => {
		save([token("Removed"), token("Retained")]);
		expect(gh(["repo", "view", "Removed/repo"]).stdout.trim()).toBe(
			"synthetic-Removed",
		);
		expect(git().stdout).toContain("password=synthetic-Removed");
		save([token("Retained")]);
		rmSync(launched);
		for (const args of [
			["repo", "view", "Removed/repo"],
			["pr", "list", "-RRemoved/repo"],
			["api", "repos/Removed/repo"],
			["api", "--method", "GET", "repos/Removed/repo"],
			["api", "https://api.github.com/repos/Removed/repo"],
		]) {
			expect(gh(args, { CYRUS_GH_TOKEN: "synthetic-Removed" }).status).not.toBe(
				0,
			);
		}
		expect(existsSync(launched)).toBe(false);
		expect(git().status).not.toBe(0);
		expect(
			gh(["repo", "view", "Retained/repo"], {
				CYRUS_GH_TOKEN: "synthetic-Removed",
			}).stdout.trim(),
		).toBe("synthetic-Retained");
		expect(git("Retained").stdout).toContain("password=synthetic-Retained");
		expect(
			gh(undefined, { CYRUS_GH_TOKEN: "synthetic-Removed" }).status,
		).not.toBe(0);
	});
	it("re-reads replacement credentials each invocation", () => {
		save([token("Retained", "synthetic-before")]);
		expect(gh(["repo", "view", "Retained/repo"]).stdout.trim()).toBe(
			"synthetic-before",
		);
		save([token("Retained", "synthetic-after")]);
		expect(
			gh(["repo", "view", "Retained/repo"], {
				CYRUS_GH_TOKEN: "synthetic-before",
			}).stdout.trim(),
		).toBe("synthetic-after");
		expect(git("Retained").stdout).toContain("password=synthetic-after");
	});
	it("leaves intentionally unmanaged self-host environment and cached auth available", () => {
		expect(gh().stdout.trim()).toBe("synthetic-ambient");
		expect(
			gh(undefined, {
				GH_TOKEN: undefined,
				GITHUB_TOKEN: undefined,
			}).stdout.trim(),
		).toBe("synthetic-cached");
		expect(git().stdout).toContain("password=synthetic-keyring");
	});
	it("real token-push handler installs both fences, clears auth on empty delivery, and retains the fence after store deletion", async () => {
		const bin = join(home, ".local", "bin");
		mkdirSync(bin, { recursive: true });
		const wrapper = join(bin, "gh");
		writeFileSync(
			wrapper,
			'#!/bin/sh\nexec env -u GH_TOKEN -u GITHUB_TOKEN /usr/bin/gh "$@"\n',
			{ mode: 0o755 },
		);
		try {
			for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
			expect(
				(
					await handleGitHubTokens(
						{ tokens: [token("Removed"), token("Retained")] },
						join(home, ".cyrus"),
					)
				).success,
			).toBe(true);
			const run = () =>
				spawnSync(wrapper, ["repo", "view", "Removed/repo"], {
					cwd: home,
					env: { ...env, CYRUS_GH_TOKEN: "synthetic-Removed" },
					encoding: "utf8",
				});
			const fill = () =>
				spawnSync("git", ["credential", "fill"], {
					cwd: home,
					env,
					encoding: "utf8",
					input: "protocol=https\nhost=github.com\npath=Removed/repo\n\n",
				});
			expect(run().stdout.trim()).toBe("synthetic-Removed");
			expect(fill().stdout).toContain("password=synthetic-Removed");
			expect(
				(await handleGitHubTokens({ tokens: [] }, join(home, ".cyrus")))
					.success,
			).toBe(true);
			rmSync(launched);
			expect(run().status).not.toBe(0);
			expect(fill().status).not.toBe(0);
			expect(existsSync(launched)).toBe(false);
			rmSync(store);
			expect(run().status).not.toBe(0);
			expect(fill().status).not.toBe(0);
			rmSync(join(home, ".cyrus", "scripts", "managed-github-auth.cjs"));
			expect(fill().status).not.toBe(0);
			rmSync(join(home, ".cyrus", "scripts", "gh-cyrus.cjs"));
			expect(run().stderr).toContain("managed credential resolver unavailable");
			expect(run().status).not.toBe(0);
			expect(existsSync(launched)).toBe(false);
			expect(
				readFileSync(join(home, ".config", "gh", "hosts.yml"), "utf8"),
			).toContain("synthetic-cached");
		} finally {
			vi.unstubAllEnvs();
		}
	});
});
