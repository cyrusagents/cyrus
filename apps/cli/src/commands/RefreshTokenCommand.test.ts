import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	mockCreateServer: vi.fn(),
	mockOpen: vi.fn(),
	mockAsk: vi.fn(),
	mockFetch: vi.fn(),
}));

vi.mock("node:http", () => ({
	default: { createServer: mocks.mockCreateServer },
	createServer: mocks.mockCreateServer,
}));

vi.mock("open", () => ({
	default: mocks.mockOpen,
}));

vi.mock("../ui/CLIPrompts.js", () => ({
	CLIPrompts: { ask: mocks.mockAsk },
}));

// Import after mocks
import { RefreshTokenCommand } from "./RefreshTokenCommand.js";

/** Args of the single `server.listen(port, host, callback)` call. */
type ListenCall = [number, string, () => void];

const createMockApp = () => ({
	cyrusHome: "/home/user/.cyrus",
	config: {
		exists: vi.fn().mockReturnValue(true),
		load: vi.fn().mockReturnValue({
			linearWorkspaces: {
				"workspace-1": {
					linearToken: "lin_oauth_old",
					linearWorkspaceName: "Test Workspace",
				},
			},
		}),
		update: vi.fn(),
	},
	getProxyUrl: vi.fn().mockReturnValue("https://proxy.example.com"),
	logger: {
		info: vi.fn(),
		error: vi.fn(),
		warn: vi.fn(),
		success: vi.fn(),
		divider: vi.fn(),
	},
});

describe("RefreshTokenCommand", () => {
	let listenCalls: ListenCall[];
	let command: RefreshTokenCommand;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, "log").mockImplementation(() => {});
		listenCalls = [];

		for (const key of ["CYRUS_SERVER_HOST", "CYRUS_HOST_EXTERNAL"]) {
			vi.stubEnv(key, undefined as unknown as string);
		}

		// Refresh the first (only) workspace, then hand the callback server a
		// valid token so `execute` finishes instead of polling for two minutes.
		mocks.mockAsk.mockResolvedValue("1");
		mocks.mockOpen.mockResolvedValue(undefined);
		mocks.mockFetch.mockResolvedValue({
			json: async () => ({ data: { viewer: { id: "u1" } } }),
		});
		global.fetch = mocks.mockFetch as unknown as typeof fetch;

		mocks.mockCreateServer.mockImplementation(
			(handler: (req: unknown, res: unknown) => void) => ({
				listen: (...args: ListenCall) => {
					listenCalls.push(args);
					handler(
						{ url: "/callback?token=lin_oauth_new" },
						{ writeHead: vi.fn(), end: vi.fn() },
					);
					args[2]();
				},
				close: vi.fn(),
			}),
		);

		command = new RefreshTokenCommand(createMockApp() as any);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
	});

	it("binds the OAuth callback listener to localhost", async () => {
		await command.execute([]);

		expect(listenCalls).toHaveLength(1);
		expect(listenCalls[0][1]).toBe("localhost");
	});

	it("ignores CYRUS_SERVER_HOST, whose callback URL is not this one", async () => {
		vi.stubEnv("CYRUS_SERVER_HOST", "0.0.0.0");

		await command.execute([]);

		expect(listenCalls[0][1]).toBe("localhost");
	});

	it("stays on localhost even with CYRUS_HOST_EXTERNAL=true", async () => {
		vi.stubEnv("CYRUS_HOST_EXTERNAL", "true");
		vi.stubEnv("CYRUS_SERVER_HOST", "192.168.1.10");

		await command.execute([]);

		expect(listenCalls[0][1]).toBe("localhost");
	});
});
