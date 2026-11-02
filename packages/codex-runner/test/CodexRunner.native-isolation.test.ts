/** Native config/transport check only: no account login, provider request or model turn. */
import { execFileSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { AppServerCodexBackend } from "../src/backend/AppServerCodexBackend.js";
import { AppServerClient } from "../src/backend/appServerClient.js";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";

it.skipIf(process.platform === "win32").each([false, true])(
	"native thread startup never launches repository MCP (linked worktree: %s)",
	async (linked) => {
		const root = mkdtempSync(join(tmpdir(), "cyrus-codex-native-isolation-"));
		const repo = join(root, "repo");
		const home = join(root, "home");
		const marker = join(root, "mcp-ran");
		mkdirSync(join(repo, ".codex"), { recursive: true });
		execFileSync("git", ["init", "-q", repo]);
		writeFileSync(join(repo, "README.md"), "isolated fixture\n");
		const args = [
			"-e",
			`require('node:fs').writeFileSync(${JSON.stringify(marker)},'unexpected MCP launch')`,
		];
		writeFileSync(
			join(repo, ".codex/config.toml"),
			`[mcp_servers.forbidden]\ncommand=${JSON.stringify(process.execPath)}\nargs=${JSON.stringify(args)}\n`,
		);
		writeFileSync(
			join(repo, ".mcp.json"),
			JSON.stringify({
				mcpServers: { forbidden: { command: process.execPath, args } },
			}),
		);
		execFileSync("git", ["-C", repo, "add", "."]);
		execFileSync("git", [
			"-C",
			repo,
			"-c",
			"user.name=Fixture",
			"-c",
			"user.email=fixture@example.invalid",
			"commit",
			"-qm",
			"fixture",
		]);
		const cwd = linked ? join(root, "worktree") : repo;
		if (linked)
			execFileSync("git", [
				"-C",
				repo,
				"worktree",
				"add",
				"-q",
				"--detach",
				cwd,
			]);
		let client!: AppServerClient;
		const backend = new AppServerCodexBackend((options) => {
			// Intentionally fake ONLY the auth preflight. Everything that loads
			// project config / starts MCP is the installed real Codex binary.
			client = new AppServerClient({
				...options,
				requestTimeoutMs: 15_000,
				env: { PATH: process.env.PATH ?? "", HOME: root, CODEX_HOME: home },
			});
			const request = client.request.bind(client);
			client.request = async <T>(
				method: string,
				params: unknown,
			): Promise<T> =>
				method === "account/read"
					? ({ account: { type: "chatgpt" }, requiresOpenaiAuth: true } as T)
					: request<T>(method, params);
			return client;
		});
		try {
			const config = await new CodexConfigBuilder({
				workingDirectory: cwd,
				codexHome: home,
				isolatedProcess: true,
				disableMcpDiscovery: true,
				sandbox: "workspace-write",
				sandboxSettings: { allowRead: [], allowWrite: [] },
			}).build();
			const { threadId } = await backend.open(config);
			const servers = await client.request<{ data: unknown[] }>(
				"mcpServerStatus/list",
				{ threadId },
			);
			expect(servers.data).toEqual([]);
			expect(existsSync(marker)).toBe(false);
		} finally {
			await backend.close();
			rmSync(root, { recursive: true, force: true });
		}
	},
	30_000,
);
