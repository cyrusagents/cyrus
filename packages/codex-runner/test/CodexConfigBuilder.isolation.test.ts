import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { CodexConfigBuilder } from "../src/config/CodexConfigBuilder.js";
import { buildCodexMcpServersConfig } from "../src/config/mcpConfigTranslator.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});
it("applies caller environment blanks without mutating its parent, even without home override", async () => {
	vi.stubEnv("CYRUS_API_KEY", "ambient-fixture");
	const config = await new CodexConfigBuilder({
		additionalEnv: { CYRUS_API_KEY: "", JIRA_ENV_FIXTURE: "test" },
	}).build();
	expect(config.env?.CYRUS_API_KEY).toBe("");
	expect(config.env?.JIRA_ENV_FIXTURE).toBe("test");
	expect(process.env.CYRUS_API_KEY).toBe("ambient-fixture");
});
it("suppresses discovery and keeps native auth while replacing ambient config in its owned home", async () => {
	const home = mkdtempSync(join(tmpdir(), "codex-jira-config-"));
	dirs.push(home);
	writeFileSync(
		join(home, ".mcp.json"),
		JSON.stringify({ mcpServers: { forbidden: { command: "do-not-run" } } }),
	);
	writeFileSync(
		join(home, "config.toml"),
		'[mcp_servers.forbidden]\ncommand="do-not-run"\n',
	);
	writeFileSync(join(home, "auth.json"), "synthetic-auth-marker");
	expect(
		buildCodexMcpServersConfig({
			workingDirectory: home,
			disableMcpDiscovery: true,
		}),
	).toBeUndefined();
	const config = await new CodexConfigBuilder({
		workingDirectory: home,
		codexHome: home,
		isolatedProcess: true,
		disableMcpDiscovery: true,
		mcpConfig: { explicit: { command: "do-not-run" } },
		configOverrides: { mcp_servers: { explicit: { command: "do-not-run" } } },
		additionalEnv: { CYRUS_API_KEY: "" },
	}).build();
	expect(config.configOverrides).toEqual({
		features: {
			apps: false,
			plugins: false,
			hooks: false,
			skill_mcp_dependency_install: false,
		},
	});
	expect(config.env?.CODEX_HOME).toBe(home);
	expect(config.env?.CYRUS_API_KEY).toBe("");
	expect(readFileSync(join(home, "auth.json"), "utf8")).toBe(
		"synthetic-auth-marker",
	);
	expect(readFileSync(join(home, "config.toml"), "utf8")).toBe(
		'cli_auth_credentials_store = "file"\n[features]\napps = false\nplugins = false\nhooks = false\nskill_mcp_dependency_install = false\n',
	);
});
