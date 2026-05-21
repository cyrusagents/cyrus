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
 * Hooks → deferred. Codex has a full hooks engine (SessionStart /
 *         PreToolUse / PostToolUse / PermissionRequest /
 *         UserPromptSubmit / Stop, schema at
 *         https://developers.openai.com/codex/hooks), but two
 *         stacked upstream bugs make hooks materialization unusable
 *         from `codex exec` on every release we can reach. Both are
 *         open as of codex 0.131.0:
 *
 *           1. Direct config-layer hooks regression — open as
 *              https://github.com/openai/codex/issues/21639.
 *              Hooks declared in `~/.codex/hooks.json` or inline as
 *              `[[hooks.<Event>]]` in `~/.codex/config.toml` stopped
 *              firing starting in 0.129.0. ≥5 users independently
 *              confirmed across 0.129.0-alpha.15, 0.130.0, and
 *              Codex Desktop 26.506.21252; we have also reproduced
 *              on 0.131.0 with `--dangerously-bypass-hook-trust`,
 *              `[features].hooks = true`, `[features].codex_hooks
 *              = true`, valid JSON schema with `matcher` set, and
 *              both fresh and warmed `CODEX_HOME`s. Was working
 *              on 0.128.0-alpha.1 per the issue thread.
 *
 *           2. Plugin manifest `hooks` field silently dropped —
 *              open as https://github.com/openai/codex/issues/16430.
 *              `codex-rs/core/src/plugins/manifest.rs` parses
 *              `skills`, `mcpServers`, and `apps` but does not read
 *              the `hooks` field at all, and `hooks/src/engine/
 *              discovery.rs` only walks config-layer folders, never
 *              the installed-plugin tree under `<CODEX_HOME>/
 *              plugins/cache/<marketplace>/<plugin>/`. So even with
 *              a fully-installed enabled plugin (verified via
 *              `codex plugin list` reporting "(installed, enabled)")
 *              and `[features].plugin_hooks = true` (now stable in
 *              0.131.0), plugin-bundled hooks never register. The
 *              `plugin_hooks` feature flag toggles a gate whose
 *              implementation isn't shipped yet — the field is
 *              discarded before the gate is ever checked.
 *
 *         The `--dangerously-bypass-hook-trust` flag landed in
 *         0.131.0 (absent in 0.130.0) but doesn't help on either
 *         path: #21639 prevents the underlying discovery from
 *         finding any hook to bypass-trust, and #16430 prevents the
 *         plugin manifest from contributing any hook to discovery
 *         in the first place.
 *
 *         Revisit when both issues close. Earliest: ship a learning
 *         test against the release that closes #21639 — if direct
 *         hooks fire again, we have a fallback materialization
 *         strategy (write to a session-local `hooks.json` under a
 *         per-session CODEX_HOME). Adding plugin-bundled support
 *         then waits on #16430 closing. Until then the materializer
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
