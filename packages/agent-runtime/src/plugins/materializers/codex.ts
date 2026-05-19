import type { RunnerSandbox, RuntimePlugin } from "../../types.js";
import { renderSkillMd } from "../skill-md.js";

export interface CodexMaterializeResult {
	/**
	 * Inline `-c` CLI overrides the caller should append to the codex
	 * invocation, e.g. `-c 'mcp_servers.<name>={command="...",args=[...]}'`.
	 * Each entry is a complete `key=value` string ready for `-c`.
	 */
	cliConfigOverrides: string[];
	/**
	 * The `HOME` value the caller should set in the harness invocation
	 * env. Codex discovers skills at `$HOME/.agents/skills/<name>/`
	 * (NOT `$CODEX_HOME/skills/` — verified empirically), so we pin
	 * HOME to a per-session directory.
	 */
	homeOverride: string;
	filesWritten: string[];
}

/**
 * Materialize a RuntimePlugin for Codex.
 *
 * Skills → files at `<homeOverride>/.agents/skills/<name>/SKILL.md` +
 *          optional `agents/openai.yaml` for the OpenAI runtime.
 * MCP servers → returned as inline `-c mcp_servers.<name>={...}` CLI
 *               overrides (no file written). Caller appends them to
 *               the codex invocation.
 * Hooks → deferred. Codex 0.130.0 has a full hooks engine
 *         (SessionStart / PreToolUse / PostToolUse / PermissionRequest /
 *         UserPromptSubmit / Stop, schema documented at
 *         https://developers.openai.com/codex/hooks), but in `codex
 *         exec` (non-interactive) mode every newly-discovered hook
 *         stays `HookTrustStatus::Untrusted` and is silently filtered
 *         before dispatch. Trust is granted via the TUI ("1 hook
 *         needs review before it can run. Open /hooks to review it.")
 *         which writes a `hooks.state.<hash>` entry into config.toml.
 *
 *         There is no working trust-bypass in 0.130.0:
 *
 *           • The `bypass_hook_trust` field shown in the github.com
 *             /openai/codex `main` branch (`discovery.rs`) does not
 *             exist in 0.130.0 — `strings` on the installed binary
 *             returns zero occurrences of `bypass_hook_trust` /
 *             `bypass-hook-trust` / `bypassHookTrust` in any form.
 *             `--bypass-hook-trust` errors as "unexpected argument";
 *             `-c bypass_hook_trust=true` is a silent no-op because
 *             nothing reads that key.
 *           • Pre-seeding `hooks.state.<hash>` would work in principle
 *             (the trust check would pass), but the matching hash is
 *             computed from a `NormalizedHookIdentity` whose
 *             serialization is internal and unversioned across codex
 *             releases.
 *           • Plugin-bundled hooks (`[features].plugin_hooks = true`)
 *             are still under development per `codex features list`
 *             and would need the same trust step anyway.
 *
 *         Revisit once codex ships a stable trust-bypass CLI flag, or
 *         pre-trusts plugin-bundled hooks delivered through a
 *         marketplace the caller controls. Until then the materializer
 *         silently drops `plugin.hooks` rather than write a config
 *         tree the runtime will refuse to execute.
 *
 * `homeOverride` is the value the caller must set as the harness's
 * HOME env var. Override HOME (not CODEX_HOME) for skill isolation.
 */
export async function materializePluginForCodex(
	plugin: RuntimePlugin,
	sandbox: RunnerSandbox,
	homeOverride: string,
): Promise<CodexMaterializeResult> {
	const filesWritten: string[] = [];

	if (plugin.skills && plugin.skills.length > 0) {
		const skillsRoot = joinPath(homeOverride, ".agents", "skills");
		await sandbox.filesystem.mkdir(skillsRoot);
		for (const skill of plugin.skills) {
			const skillDir = joinPath(skillsRoot, skill.name);
			await sandbox.filesystem.mkdir(skillDir);
			const skillPath = joinPath(skillDir, "SKILL.md");
			await sandbox.filesystem.writeFile(skillPath, renderSkillMd(skill));
			filesWritten.push(skillPath);

			// Codex's OpenAI runtime expects an `agents/openai.yaml` sibling
			// describing the skill at the protocol level. Without this, codex
			// will still load the SKILL.md but the surface area in the agent
			// directory is incomplete. Emit a minimal one.
			const agentsDir = joinPath(skillDir, "agents");
			await sandbox.filesystem.mkdir(agentsDir);
			const openaiYamlPath = joinPath(agentsDir, "openai.yaml");
			const yaml = [
				"interface:",
				`  display_name: ${skill.name}`,
				`  short_description: ${yamlString(skill.description)}`,
				`  default_prompt: ${yamlString(skill.description)}`,
			].join("\n");
			await sandbox.filesystem.writeFile(openaiYamlPath, `${yaml}\n`);
			filesWritten.push(openaiYamlPath);

			for (const asset of skill.assets ?? []) {
				const assetPath = joinPath(skillDir, asset.path);
				const assetDir = dirnameOf(assetPath);
				if (assetDir) await sandbox.filesystem.mkdir(assetDir);
				await sandbox.filesystem.writeFile(assetPath, asset.content);
				filesWritten.push(assetPath);
			}
		}
	}

	const cliConfigOverrides: string[] = [];
	if (plugin.mcpServers) {
		for (const [serverName, cfg] of Object.entries(plugin.mcpServers)) {
			// Build inline TOML for codex's `-c key=value` flag.
			// Codex parses the value as TOML, so command/args/env become a
			// TOML table literal.
			const parts: string[] = [];
			if (cfg.command) parts.push(`command=${tomlString(cfg.command)}`);
			if (cfg.args && cfg.args.length > 0) {
				const argsLit = cfg.args.map(tomlString).join(",");
				parts.push(`args=[${argsLit}]`);
			}
			if (cfg.env && Object.keys(cfg.env).length > 0) {
				const envEntries = Object.entries(cfg.env)
					.map(([k, v]) => `${tomlKey(k)}=${tomlString(v)}`)
					.join(",");
				parts.push(`env={${envEntries}}`);
			}
			if (cfg.url) parts.push(`url=${tomlString(cfg.url)}`);
			cliConfigOverrides.push(
				`mcp_servers.${tomlKey(serverName)}={${parts.join(",")}}`,
			);
		}
	}

	// Hooks intentionally not materialized — see the top-of-file comment
	// for why codex 0.130.0's `codex exec` filters untrusted hooks before
	// dispatch and the trust hash is internal to the binary.

	return { cliConfigOverrides, homeOverride, filesWritten };
}

function joinPath(...parts: string[]): string {
	return parts
		.filter((p) => p !== "")
		.map((p) => p.replace(/\/+$/, ""))
		.join("/")
		.replace(/\/{2,}/g, "/");
}

function dirnameOf(path: string): string | undefined {
	const idx = path.lastIndexOf("/");
	return idx > 0 ? path.slice(0, idx) : undefined;
}

/** Wrap a TOML string scalar. */
function tomlString(value: string): string {
	return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Quote a TOML bare key when it contains non-bare characters. */
function tomlKey(value: string): string {
	if (/^[A-Za-z0-9_-]+$/.test(value)) return value;
	return tomlString(value);
}

function yamlString(value: string): string {
	if (/[:#\n\\"]/.test(value)) {
		return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
	}
	return value;
}
