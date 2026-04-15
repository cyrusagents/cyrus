import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Claude SDK
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
	query: vi.fn(),
}));

// Track readFileSync calls per path so we can change .env contents between sessions
const envFileContents = new Map<string, string>();

// Mock file system operations
vi.mock("fs", () => ({
	mkdirSync: vi.fn(),
	existsSync: vi.fn((path: string) => {
		if (typeof path === "string" && path.endsWith(".env")) {
			return envFileContents.has(path);
		}
		return false;
	}),
	readFileSync: vi.fn((path: string) => {
		if (typeof path === "string" && envFileContents.has(path)) {
			return envFileContents.get(path);
		}
		return "";
	}),
	createWriteStream: vi.fn(() => ({
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
	})),
	writeFileSync: vi.fn(),
}));

// Mock os module
vi.mock("os", () => ({
	homedir: vi.fn(() => "/mock/home"),
}));

import { query } from "@anthropic-ai/claude-agent-sdk";
import { ClaudeRunner } from "../src/ClaudeRunner";
import type { ClaudeRunnerConfig } from "../src/types";

describe("Environment variable isolation", () => {
	let mockQuery: any;

	const makeConfig = (workingDirectory: string): ClaudeRunnerConfig => ({
		workingDirectory,
		cyrusHome: "/tmp/test-cyrus-home",
	});

	function mockSuccessfulQuery() {
		mockQuery.mockImplementation(async function* () {
			yield {
				type: "assistant",
				message: { content: [{ type: "text", text: "Done" }] },
				parent_tool_use_id: null,
				session_id: "test-session",
			} as any;
		});
	}

	function getQueryEnv(): Record<string, string> {
		const call = mockQuery.mock.calls[mockQuery.mock.calls.length - 1];
		return call[0].options.env;
	}

	beforeEach(() => {
		vi.clearAllMocks();
		envFileContents.clear();
		mockQuery = vi.mocked(query);
	});

	afterEach(() => {
		envFileContents.clear();
	});

	it("should load .env vars into the child env without polluting process.env", async () => {
		envFileContents.set(
			"/repo-a/.env",
			"DOCKER_HOST=unix:///run/podman/podman.sock\nMY_VAR=hello",
		);

		// Ensure process.env doesn't have these before
		const hadDockerHost = "DOCKER_HOST" in process.env;
		const hadMyVar = "MY_VAR" in process.env;
		const origDockerHost = process.env.DOCKER_HOST;
		const origMyVar = process.env.MY_VAR;

		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig("/repo-a"));
		await runner.start("test");

		const env = getQueryEnv();
		expect(env.DOCKER_HOST).toBe("unix:///run/podman/podman.sock");
		expect(env.MY_VAR).toBe("hello");

		// Verify process.env was NOT mutated
		if (!hadDockerHost) {
			expect(process.env.DOCKER_HOST).toBeUndefined();
		} else {
			expect(process.env.DOCKER_HOST).toBe(origDockerHost);
		}
		if (!hadMyVar) {
			expect(process.env.MY_VAR).toBeUndefined();
		} else {
			expect(process.env.MY_VAR).toBe(origMyVar);
		}
	});

	it("should pick up updated .env values on subsequent sessions", async () => {
		// First session: DOCKER_HOST is set
		envFileContents.set(
			"/repo-a/.env",
			"DOCKER_HOST=unix:///run/podman/podman.sock",
		);

		mockSuccessfulQuery();
		const runner1 = new ClaudeRunner(makeConfig("/repo-a"));
		await runner1.start("test");

		const env1 = getQueryEnv();
		expect(env1.DOCKER_HOST).toBe("unix:///run/podman/podman.sock");

		// Second session: DOCKER_HOST is changed
		envFileContents.set("/repo-a/.env", "DOCKER_HOST=tcp://localhost:2375");

		mockSuccessfulQuery();
		const runner2 = new ClaudeRunner(makeConfig("/repo-a"));
		await runner2.start("test");

		const env2 = getQueryEnv();
		expect(env2.DOCKER_HOST).toBe("tcp://localhost:2375");
	});

	it("should not carry removed .env vars into subsequent sessions", async () => {
		// First session: two vars
		envFileContents.set("/repo-a/.env", "VAR_A=one\nVAR_B=two");

		mockSuccessfulQuery();
		const runner1 = new ClaudeRunner(makeConfig("/repo-a"));
		await runner1.start("test");

		const env1 = getQueryEnv();
		expect(env1.VAR_A).toBe("one");
		expect(env1.VAR_B).toBe("two");

		// Second session: VAR_B removed
		envFileContents.set("/repo-a/.env", "VAR_A=updated");

		mockSuccessfulQuery();
		const runner2 = new ClaudeRunner(makeConfig("/repo-a"));
		await runner2.start("test");

		const env2 = getQueryEnv();
		expect(env2.VAR_A).toBe("updated");
		// VAR_B should NOT be present (it was removed from .env)
		// It would only be present if it exists in process.env
		if (!("VAR_B" in process.env)) {
			expect(env2.VAR_B).toBeUndefined();
		}
	});

	it("should isolate env vars between different repositories", async () => {
		envFileContents.set("/repo-a/.env", "REPO_VAR=from-repo-a");
		envFileContents.set(
			"/repo-b/.env",
			"REPO_VAR=from-repo-b\nOTHER=only-in-b",
		);

		// Start session for repo-a
		mockSuccessfulQuery();
		const runnerA = new ClaudeRunner(makeConfig("/repo-a"));
		await runnerA.start("test");

		const envA = getQueryEnv();
		expect(envA.REPO_VAR).toBe("from-repo-a");
		if (!("OTHER" in process.env)) {
			expect(envA.OTHER).toBeUndefined();
		}

		// Start session for repo-b
		mockSuccessfulQuery();
		const runnerB = new ClaudeRunner(makeConfig("/repo-b"));
		await runnerB.start("test");

		const envB = getQueryEnv();
		expect(envB.REPO_VAR).toBe("from-repo-b");
		expect(envB.OTHER).toBe("only-in-b");
	});

	it("should let process.env take precedence over .env values", async () => {
		// Set a value in process.env
		const originalPath = process.env.PATH;
		envFileContents.set("/repo-a/.env", `PATH=/should-not-override`);

		mockSuccessfulQuery();
		const runner = new ClaudeRunner(makeConfig("/repo-a"));
		await runner.start("test");

		const env = getQueryEnv();
		// process.env.PATH should win over .env's PATH
		expect(env.PATH).toBe(originalPath);
	});
});
