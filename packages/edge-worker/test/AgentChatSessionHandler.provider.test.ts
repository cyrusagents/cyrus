import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentChatSessionHandler,
	type ChatPlatformAdapter,
	readClaudeCredential,
} from "../src/AgentChatSessionHandler.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

// Minimal stand-in for ChatPlatformAdapter. None of these methods are
// invoked by the constructor — they only matter once handleEvent runs —
// so we throw to make accidental invocations loud in test output.
function makeAdapter(): ChatPlatformAdapter<unknown> {
	const fail = (name: string) => () => {
		throw new Error(`unexpected call to ${name} in constructor test`);
	};
	return {
		platformName: "slack",
		extractTaskInstructions: fail("extractTaskInstructions") as never,
		getThreadKey: fail("getThreadKey") as never,
		getEventId: fail("getEventId") as never,
		buildSystemPrompt: fail("buildSystemPrompt") as never,
		fetchThreadContext: fail("fetchThreadContext") as never,
		postReply: fail("postReply") as never,
		acknowledgeReceipt: fail("acknowledgeReceipt") as never,
		notifyBusy: fail("notifyBusy") as never,
	};
}

function makeDeps(
	overrides: Partial<
		Parameters<(typeof AgentChatSessionHandler.prototype)["constructor"]>[1]
	> = {},
) {
	return {
		onWebhookStart: () => {},
		onWebhookEnd: () => {},
		onError: () => {},
		...overrides,
	};
}

describe("AgentChatSessionHandler provider selection", () => {
	const SNAPSHOT_ENV_VARS = [
		"DAYTONA_API_KEY",
		"DAYTONA_SNAPSHOT",
		"DAYTONA_WORKING_DIR",
		"DAYTONA_CLAUDE_CLI_PATH",
	] as const;
	const originalEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const name of SNAPSHOT_ENV_VARS) {
			originalEnv.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(async () => {
		for (const name of SNAPSHOT_ENV_VARS) {
			const prev = originalEnv.get(name);
			if (prev === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = prev;
			}
		}
		originalEnv.clear();
	});

	it("defaults to local provider when none specified and does not require DAYTONA_API_KEY", () => {
		expect(
			() =>
				new AgentChatSessionHandler(makeAdapter(), makeDeps(), silentLogger),
		).not.toThrow();
	});

	it("accepts provider='local' without DAYTONA_API_KEY", () => {
		expect(
			() =>
				new AgentChatSessionHandler(
					makeAdapter(),
					makeDeps({ provider: "local" }),
					silentLogger,
				),
		).not.toThrow();
	});

	it("throws when provider='daytona' is requested without DAYTONA_API_KEY", () => {
		expect(
			() =>
				new AgentChatSessionHandler(
					makeAdapter(),
					makeDeps({ provider: "daytona" }),
					silentLogger,
				),
		).toThrow(/DAYTONA_API_KEY/);
	});

	it("accepts provider='daytona' when DAYTONA_API_KEY is set", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		expect(
			() =>
				new AgentChatSessionHandler(
					makeAdapter(),
					makeDeps({ provider: "daytona" }),
					silentLogger,
				),
		).not.toThrow();
	});

	it("threads DAYTONA_SNAPSHOT into the Daytona sandbox config when set", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		process.env.DAYTONA_SNAPSHOT = "cyrus-base-v3";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "snap-set");
		expect(config.sandbox?.snapshot).toBe("cyrus-base-v3");
	});

	it("omits sandbox.snapshot when DAYTONA_SNAPSHOT is unset", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "snap-unset");
		expect(config.sandbox?.snapshot).toBeUndefined();
	});

	it("treats whitespace-only DAYTONA_SNAPSHOT as unset", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		process.env.DAYTONA_SNAPSHOT = "   ";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "snap-empty");
		expect(config.sandbox?.snapshot).toBeUndefined();
	});

	it("uses default working dir, CLI path, and npm setup commands when DAYTONA_SNAPSHOT is unset", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "defaults");
		expect(config.sandbox?.workingDirectory).toBe("/home/daytona");
		expect(config.harness?.command).toBe(
			"/home/daytona/.npm-global/bin/claude",
		);
		expect(config.packages?.commands).toEqual([
			"npm config set prefix /home/daytona/.npm-global",
			// Pinned to match `@anthropic-ai/claude-agent-sdk@0.2.141` (the
			// SDK version `HarnessRawByKind["claude"]` is typed against).
			// If we bump the pin, we bump it here too.
			"npm install -g @anthropic-ai/claude-code@2.1.145 >/dev/null 2>&1",
			"/home/daytona/.npm-global/bin/claude --version",
		]);
	});

	it("skips npm setup and defaults claude to PATH when DAYTONA_SNAPSHOT is set", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		process.env.DAYTONA_SNAPSHOT = "cyrus-base-v3";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "with-snapshot");
		expect(config.harness?.command).toBe("claude");
		expect(config.packages).toBeUndefined();
	});

	it("honors DAYTONA_WORKING_DIR override", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		process.env.DAYTONA_SNAPSHOT = "cyrus-base-v3";
		process.env.DAYTONA_WORKING_DIR = "/home/cyrus";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "wd-override");
		expect(config.sandbox?.workingDirectory).toBe("/home/cyrus");
	});

	it("honors DAYTONA_CLAUDE_CLI_PATH override", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		process.env.DAYTONA_SNAPSHOT = "cyrus-base-v3";
		process.env.DAYTONA_CLAUDE_CLI_PATH = "/usr/local/bin/claude";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "cli-override");
		expect(config.harness?.command).toBe("/usr/local/bin/claude");
	});

	it("bypasses Claude permission prompts for Daytona sessions", () => {
		process.env.DAYTONA_API_KEY = "fake-key-for-test";
		const handler = new AgentChatSessionHandler(
			makeAdapter(),
			makeDeps({ provider: "daytona" }),
			silentLogger,
		);
		const config = buildDaytonaConfig(handler, "perm-bypass");
		expect(config.permissions?.mode).toBe("bypass");
	});
});

interface DaytonaSessionConfigShape {
	harness?: { command?: string };
	packages?: { commands?: string[] };
	permissions?: { mode?: string };
	sandbox?: { workingDirectory?: string; snapshot?: string };
	secrets?: Record<string, { value: string } | string>;
}

function buildDaytonaConfig(
	handler: AgentChatSessionHandler<unknown>,
	sessionId: string,
	credential: {
		kind: "oauth" | "apiKey" | "authToken";
		token: string;
	} = { kind: "apiKey", token: "tok" },
): DaytonaSessionConfigShape {
	return (
		handler as unknown as {
			buildSessionConfig: (args: {
				sessionId: string;
				threadKey: string;
				systemPrompt: string;
				credential: typeof credential;
			}) => DaytonaSessionConfigShape;
		}
	).buildSessionConfig({
		sessionId,
		threadKey: `thread-${sessionId}`,
		systemPrompt: "sys",
		credential,
	});
}

describe("AgentChatSessionHandler credential detection", () => {
	const CRED_ENV_VARS = [
		"CLAUDE_CODE_OAUTH_TOKEN",
		"ANTHROPIC_API_KEY",
		"ANTHROPIC_AUTH_TOKEN",
	] as const;
	const originalEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const name of CRED_ENV_VARS) {
			originalEnv.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(() => {
		for (const name of CRED_ENV_VARS) {
			const prev = originalEnv.get(name);
			if (prev === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = prev;
			}
		}
		originalEnv.clear();
	});

	it("returns undefined when no credential env var is set", () => {
		expect(readClaudeCredential()).toBeUndefined();
	});

	it("detects ANTHROPIC_AUTH_TOKEN when it is the only one set", () => {
		// Regression guard — earlier revision of this handler dropped
		// ANTHROPIC_AUTH_TOKEN entirely, which broke deployments that
		// auth Claude via a proxy/gateway. The legacy claude-runner
		// (packages/claude-runner/src/session-env.ts AUTH_ENV_KEYS) still
		// forwards this env var, so the chat handler must accept it too.
		process.env.ANTHROPIC_AUTH_TOKEN = "auth-token-value";
		expect(readClaudeCredential()).toEqual({
			kind: "authToken",
			token: "auth-token-value",
		});
	});

	it("CLAUDE_CODE_OAUTH_TOKEN > ANTHROPIC_API_KEY > ANTHROPIC_AUTH_TOKEN", () => {
		// Precedence matches claude-runner's AUTH_ENV_KEYS scan order
		// so the chat handler and the legacy runner pick the same one
		// on hosts that have multiple set.
		process.env.CLAUDE_CODE_OAUTH_TOKEN = "oauth";
		process.env.ANTHROPIC_API_KEY = "api";
		process.env.ANTHROPIC_AUTH_TOKEN = "auth";
		expect(readClaudeCredential()).toEqual({ kind: "oauth", token: "oauth" });

		delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
		expect(readClaudeCredential()).toEqual({ kind: "apiKey", token: "api" });

		delete process.env.ANTHROPIC_API_KEY;
		expect(readClaudeCredential()).toEqual({
			kind: "authToken",
			token: "auth",
		});
	});

	it("trims whitespace-only env vars to empty / undefined", () => {
		process.env.ANTHROPIC_AUTH_TOKEN = "   ";
		expect(readClaudeCredential()).toBeUndefined();
	});
});

describe("AgentChatSessionHandler credential forwarding", () => {
	const SNAPSHOT_ENV_VARS = ["DAYTONA_API_KEY"] as const;
	const originalEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		for (const name of SNAPSHOT_ENV_VARS) {
			originalEnv.set(name, process.env[name]);
			delete process.env[name];
		}
		process.env.DAYTONA_API_KEY = "dt-test";
	});

	afterEach(() => {
		for (const name of SNAPSHOT_ENV_VARS) {
			const prev = originalEnv.get(name);
			if (prev === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = prev;
			}
		}
		originalEnv.clear();
	});

	function makeHandler(): AgentChatSessionHandler<unknown> {
		return new AgentChatSessionHandler(
			{ adapter: makeAdapter(), provider: "daytona" },
			makeDeps(),
			silentLogger,
		);
	}

	it("forwards CLAUDE_CODE_OAUTH_TOKEN for kind='oauth'", () => {
		const config = buildDaytonaConfig(makeHandler(), "cred-oauth", {
			kind: "oauth",
			token: "oauth-token",
		});
		expect(config.secrets?.CLAUDE_CODE_OAUTH_TOKEN).toBe("oauth-token");
		expect(config.secrets?.ANTHROPIC_API_KEY).toBeUndefined();
		expect(config.secrets?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	it("forwards ANTHROPIC_API_KEY for kind='apiKey'", () => {
		const config = buildDaytonaConfig(makeHandler(), "cred-api", {
			kind: "apiKey",
			token: "api-key",
		});
		expect(config.secrets?.ANTHROPIC_API_KEY).toBe("api-key");
		expect(config.secrets?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(config.secrets?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
	});

	it("forwards ANTHROPIC_AUTH_TOKEN for kind='authToken'", () => {
		// Mirrors the kind='apiKey' assertion. With Claude Code's distinct
		// auth-mode handling, sending two of these env vars at once would
		// conflate billing / routing, so the handler picks one and only
		// sets that one — verify the right one ships through.
		const config = buildDaytonaConfig(makeHandler(), "cred-auth", {
			kind: "authToken",
			token: "auth-token",
		});
		expect(config.secrets?.ANTHROPIC_AUTH_TOKEN).toBe("auth-token");
		expect(config.secrets?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
		expect(config.secrets?.ANTHROPIC_API_KEY).toBeUndefined();
	});
});
