import type { ILogger } from "cyrus-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	AgentChatSessionHandler,
	type ChatPlatformAdapter,
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
}

function buildDaytonaConfig(
	handler: AgentChatSessionHandler<unknown>,
	sessionId: string,
): DaytonaSessionConfigShape {
	return (
		handler as unknown as {
			buildSessionConfig: (args: {
				sessionId: string;
				threadKey: string;
				systemPrompt: string;
				credential: { kind: "apiKey"; token: string };
			}) => DaytonaSessionConfigShape;
		}
	).buildSessionConfig({
		sessionId,
		threadKey: `thread-${sessionId}`,
		systemPrompt: "sys",
		credential: { kind: "apiKey", token: "tok" },
	});
}
