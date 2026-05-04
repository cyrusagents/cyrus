#!/usr/bin/env node
// Cursor SDK hook entrypoint that enforces Cyrus allow/deny permissions.
//
// Runs once per hook invocation. Reads a sibling `cyrus-permissions.json`
// alongside this script, matches the hook payload against the configured
// patterns, and prints a JSON decision document on stdout for the SDK.
//
// Pattern syntax:
//   Read(<glob>)           — file reads
//   Write(<glob>)          — file writes/edits
//   Shell(<cmd>)           — shell commands by leading word
//   Shell(<cmd>:<args>)    — shell commands with argument glob
//   Mcp(<server>:<tool>)   — MCP tool calls
//   Tool(<Name>)           — preToolUse name (Shell, Read, Write, ...)
//
// We only ever return permission "allow" or "deny" — never "ask", because
// "ask" auto-allows in headless and that is never what Cyrus wants.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(HERE, "cyrus-permissions.json");
const LOG_PATH = process.env.CYRUS_PERM_LOG; // optional debug log

function log(obj) {
	if (!LOG_PATH) return;
	try {
		appendFileSync(LOG_PATH, `${JSON.stringify(obj)}\n`);
	} catch {}
}

function loadConfig() {
	if (!existsSync(CONFIG_PATH)) {
		return { allow: [], deny: [], workspace: process.cwd() };
	}
	try {
		return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
	} catch {
		return { allow: [], deny: [], workspace: process.cwd() };
	}
}

let stdin = "";
try {
	stdin = readFileSync(0, "utf8");
} catch {}

let payload = {};
try {
	payload = JSON.parse(stdin);
} catch {}

const cfg = loadConfig();
const eventName = payload.hook_event_name;

function normalizePath(p) {
	if (!p) return "";
	const ws = cfg.workspace ?? process.cwd();
	if (isAbsolute(p)) {
		const rel = relative(ws, p);
		if (rel && !rel.startsWith("..")) return rel;
		return p;
	}
	return p;
}

// Tiny glob matcher: ** = any chars (including /), * = no slash, ? = single.
function globToRegex(glob) {
	let re = "^";
	for (let i = 0; i < glob.length; i++) {
		const c = glob[i];
		if (c === "*" && glob[i + 1] === "*") {
			re += ".*";
			i++;
		} else if (c === "*") re += "[^/]*";
		else if (c === "?") re += ".";
		else if (".+^$()|{}[]\\".includes(c)) re += `\\${c}`;
		else re += c;
	}
	return new RegExp(`${re}$`);
}

function patternMatches(pattern, candidate) {
	const m = pattern.match(/^([A-Za-z][A-Za-z0-9]*)(?:\((.*)\))?$/);
	if (!m) return false;
	const [, kind, arg] = m;
	if (kind !== candidate.kind) return false;
	if (!arg || arg === "*") return true;
	return globToRegex(arg).test(candidate.value);
}

function lookupMcpServerName(p) {
	const servers = Array.isArray(cfg.mcpServers) ? cfg.mcpServers : [];
	if (servers.length === 0) return null;
	if (typeof p.url === "string" && p.url) {
		const m = servers.find((s) => s.url === p.url);
		if (m) return m.name;
	}
	if (typeof p.command === "string" && p.command) {
		const m = servers.find((s) => s.commandLine === p.command);
		if (m) return m.name;
	}
	return null;
}

function getCandidates(p) {
	const out = [];
	if (eventName === "preToolUse") {
		// The SDK fires `preToolUse` for MCP tools with `tool_name` prefixed
		// `MCP:<bare-tool>` (e.g. `MCP:get_issue`) and NO `command`/`url`
		// field — there is no way to identify the logical server yet. The
		// subsequent `beforeMCPExecution` event has both the bare tool name
		// AND the transport (`command`/`url`) which our server lookup uses
		// to evaluate `Mcp(<server>:<tool>)` patterns. Defer to that stage
		// here by returning no candidates (== allow).
		const toolName = typeof p.tool_name === "string" ? p.tool_name : "";
		if (toolName.startsWith("MCP:")) return [];
		out.push({ kind: "Tool", value: toolName });
	} else if (eventName === "beforeShellExecution") {
		const cmd = p.command ?? "";
		const trimmed = cmd.trim();
		const base = trimmed.split(/\s+/)[0] ?? "";
		const rest = trimmed.slice(base.length).trim();
		out.push({ kind: "Shell", value: base });
		out.push({ kind: "Shell", value: rest ? `${base}:${rest}` : base });
	} else if (eventName === "beforeReadFile") {
		out.push({ kind: "Read", value: normalizePath(p.file_path) });
	} else if (eventName === "beforeMCPExecution") {
		// SDK payload only carries the bare tool_name (e.g. "save_comment") and
		// the underlying transport (`command` or `url`) — never a logical
		// server name. We map the transport back to the configured server
		// name via cfg.mcpServers so server-scoped patterns like
		// `Mcp(linear:save_comment)` and `Mcp(linear:*)` can match.
		const tool = p.tool_name ?? "";
		const server = lookupMcpServerName(p);
		if (server) out.push({ kind: "Mcp", value: `${server}:${tool}` });
		out.push({ kind: "Mcp", value: tool });
	}
	return out;
}

function evaluate() {
	const candidates = getCandidates(payload);
	if (candidates.length === 0) return { permission: "allow" };

	// Deny wins over allow.
	for (const cand of candidates) {
		for (const pat of cfg.deny ?? []) {
			if (patternMatches(pat, cand)) {
				return {
					permission: "deny",
					user_message: `Cyrus blocked: ${pat} (event=${eventName})`,
				};
			}
		}
	}

	// If an allow list is defined, require an allow match.
	if ((cfg.allow ?? []).length > 0) {
		const matched = candidates.some((cand) =>
			(cfg.allow ?? []).some((pat) => patternMatches(pat, cand)),
		);
		if (!matched) {
			return {
				permission: "deny",
				user_message: `Cyrus blocked: no allow rule matched (event=${eventName}, candidates=${JSON.stringify(candidates)})`,
			};
		}
	}

	return { permission: "allow" };
}

const decision = evaluate();
log({ ts: Date.now(), event: eventName, decision, payload });
process.stdout.write(JSON.stringify(decision));
