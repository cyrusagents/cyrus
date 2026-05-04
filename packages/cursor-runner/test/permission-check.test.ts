import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const HELPER = join(HERE, "..", "src", "permission-check.mjs");

interface RunArgs {
	allow?: string[];
	deny?: string[];
	mcpServers?: Array<{ name: string; commandLine?: string; url?: string }>;
	payload: Record<string, unknown>;
}

const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function runHelper(args: RunArgs): { decision: any; stderr: string } {
	const dir = mkdtempSync(join(tmpdir(), "perm-check-"));
	tempDirs.push(dir);
	const cursorDir = join(dir, ".cursor");
	require("node:fs").mkdirSync(cursorDir, { recursive: true });
	const helperCopy = join(cursorDir, "cyrus-permission-check.mjs");
	require("node:fs").copyFileSync(HELPER, helperCopy);
	require("node:fs").chmodSync(helperCopy, 0o755);
	writeFileSync(
		join(cursorDir, "cyrus-permissions.json"),
		JSON.stringify({
			workspace: dir,
			allow: args.allow ?? [],
			deny: args.deny ?? [],
			mcpServers: args.mcpServers ?? [],
		}),
	);

	const proc = spawnSync(process.execPath, [helperCopy], {
		input: JSON.stringify(args.payload),
		encoding: "utf8",
	});
	let decision: any = null;
	try {
		decision = JSON.parse(proc.stdout || "{}");
	} catch {
		decision = { _raw: proc.stdout };
	}
	return { decision, stderr: proc.stderr };
}

describe("permission-check helper", () => {
	it("allows by default when no patterns configured", () => {
		const { decision } = runHelper({
			payload: { hook_event_name: "preToolUse", tool_name: "Read" },
		});
		expect(decision.permission).toBe("allow");
	});

	it("denies a deny-listed shell command", () => {
		const { decision } = runHelper({
			deny: ["Shell(rm)"],
			payload: {
				hook_event_name: "beforeShellExecution",
				command: "rm -rf /tmp/x",
			},
		});
		expect(decision.permission).toBe("deny");
	});

	it("denies an unmatched call when an allow list is set", () => {
		const { decision } = runHelper({
			allow: ["Shell(ls)"],
			payload: {
				hook_event_name: "beforeShellExecution",
				command: "cat README.md",
			},
		});
		expect(decision.permission).toBe("deny");
	});

	it("allows when allow list matches", () => {
		const { decision } = runHelper({
			allow: ["Shell(ls)", "Shell(ls:*)"],
			payload: {
				hook_event_name: "beforeShellExecution",
				command: "ls -la",
			},
		});
		expect(decision.permission).toBe("allow");
	});

	it("denies a beforeReadFile of a denied path", () => {
		const { decision } = runHelper({
			deny: ["Read(secret.txt)"],
			payload: {
				hook_event_name: "beforeReadFile",
				file_path: "secret.txt",
			},
		});
		expect(decision.permission).toBe("deny");
	});

	// Regression for CYPACK-1154/1155: the SDK fires preToolUse for MCP tools
	// with `tool_name="MCP:<bare-tool>"` and NO command/url field — which
	// means we cannot identify the logical server yet. Helper must defer
	// to the subsequent beforeMCPExecution event (where command/url is
	// present) instead of denying based on `Tool("MCP:get_issue")` against
	// a `Tool(Read)` / `Tool(Bash)` allow list.
	it("allows preToolUse for an MCP tool when allow list scopes via Mcp(server:*)", () => {
		const { decision } = runHelper({
			allow: [
				"Tool(Read)",
				"Tool(Bash)",
				"Mcp(linear:*)", // the actual server-scoped allow comes from the user
			],
			mcpServers: [
				{ name: "linear", commandLine: "node /path/to/linear-mcp.mjs" },
			],
			payload: {
				hook_event_name: "preToolUse",
				tool_name: "MCP:get_issue",
				tool_input: { id: "CYPACK-1155" },
			},
		});
		expect(decision.permission).toBe("allow");
	});

	it("denies an MCP call by exact Mcp(server:tool) pattern", () => {
		const { decision } = runHelper({
			deny: ["Mcp(linear:delete_issue)"],
			mcpServers: [
				{ name: "linear", commandLine: "node /path/to/linear-mcp.mjs" },
			],
			payload: {
				hook_event_name: "beforeMCPExecution",
				// SDK puts the bare tool name here — NOT "linear:delete_issue".
				tool_name: "delete_issue",
				command: "node /path/to/linear-mcp.mjs",
			},
		});
		expect(decision.permission).toBe("deny");
	});

	// Regression for CYPACK-1151: production allow lists like
	// `Mcp(linear:save_comment)` or `Mcp(linear:*)` must match even though
	// the SDK's beforeMCPExecution payload only carries `tool_name=save_comment`
	// and the underlying transport (`command`/`url`), never the logical server.
	// We rely on cfg.mcpServers as a transport→name lookup table.
	it("matches Mcp(server:*) by looking up server from command", () => {
		const { decision } = runHelper({
			allow: ["Mcp(linear:*)"],
			mcpServers: [
				{ name: "linear", commandLine: "node /path/to/linear-mcp.mjs" },
			],
			payload: {
				hook_event_name: "beforeMCPExecution",
				tool_name: "save_comment",
				command: "node /path/to/linear-mcp.mjs",
			},
		});
		expect(decision.permission).toBe("allow");
	});

	it("matches Mcp(server:tool) for HTTP MCP servers via url lookup", () => {
		const { decision } = runHelper({
			allow: ["Mcp(remote:read_doc)"],
			mcpServers: [{ name: "remote", url: "https://example.com/mcp" }],
			payload: {
				hook_event_name: "beforeMCPExecution",
				tool_name: "read_doc",
				url: "https://example.com/mcp",
			},
		});
		expect(decision.permission).toBe("allow");
	});

	it("denies server-scoped MCP calls when no server lookup matches", () => {
		const { decision } = runHelper({
			allow: ["Mcp(linear:*)"],
			mcpServers: [
				{ name: "linear", commandLine: "node /path/to/linear-mcp.mjs" },
			],
			payload: {
				hook_event_name: "beforeMCPExecution",
				tool_name: "delete_database",
				command: "node /path/to/UNKNOWN-mcp.mjs",
			},
		});
		// No server match => candidate is just `Mcp(delete_database)`,
		// which does not satisfy the `Mcp(linear:*)` allow.
		expect(decision.permission).toBe("deny");
	});

	it("never returns ask", () => {
		const { decision } = runHelper({
			allow: ["Tool(Read)"],
			payload: { hook_event_name: "preToolUse", tool_name: "Read" },
		});
		expect(decision.permission).toBe("allow");
		expect(decision.permission).not.toBe("ask");
	});
});
