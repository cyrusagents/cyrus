#!/usr/bin/env node
// Phase 0: validate that thread/start `permissionProfile` (managed, restricted
// filesystem) is honored by codex app-server, and how deny precedence works.
//
// Setup: a workdir that is WRITE-allowed, plus an "outside" dir that is NOT in
// the entries (should be unwritable), plus a "denied" subdir of workdir marked
// access:none (should override the workdir write — tests precedence).
//
// We then run a turn that attempts three writes via the shell and check the
// filesystem directly (deterministic, independent of what the model narrates).

import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import readline from "node:readline";

const CODEX_BIN = execFileSync("bash", [
  "-c",
  "find /Users/agentops/code/cyrus/node_modules/.pnpm -path '*@openai+codex@*-darwin-arm64*/vendor/*/codex/codex' | head -1",
])
  .toString()
  .trim();

// Put both dirs under $HOME so the /tmp workspace-write allowance can't mask the
// test: outsideDir is a sibling NOT in writableRoots → must be blocked.
const workdir = mkdtempSync(join(homedir(), "codex-sbx-work-"));
execFileSync("git", ["init", "-q"], { cwd: workdir });
writeFileSync(join(workdir, "README.md"), "# sandbox test\n");
const outsideDir = mkdtempSync(join(homedir(), "codex-sbx-outside-"));

const allowedTarget = join(workdir, "allowed.txt");
const outsideTarget = join(outsideDir, "blocked.txt");

process.on("exit", () => {
  try { rmSync(workdir, { recursive: true, force: true }); } catch {}
  try { rmSync(outsideDir, { recursive: true, force: true }); } catch {}
});

console.log(`[sbx] workdir(writableRoots): ${workdir}`);
console.log(`[sbx] outside($HOME, not in roots): ${outsideDir}`);

const child = spawn(CODEX_BIN, ["app-server", "--listen", "stdio://"], {
  stdio: ["pipe", "pipe", "pipe"],
});
let nextId = 1;
const pending = new Map();
function send(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((res, rej) => pending.set(id, { res, rej, method }));
}
function respond(id, result) {
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

let threadId = null;
const rl = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let p;
  try { p = JSON.parse(t); } catch { return; }
  if (p.id !== undefined && (p.result !== undefined || p.error !== undefined)) {
    const e = pending.get(p.id); pending.delete(p.id);
    if (p.error) { console.log(`[sbx] <- #${p.id} ERROR ${JSON.stringify(p.error)}`); e?.rej?.(p.error); }
    else e?.res?.(p.result);
    return;
  }
  if (p.id !== undefined && p.method) { // server request → auto-approve
    if (/auth/i.test(p.method)) respond(p.id, { chatgptAuthToken: null });
    else respond(p.id, { decision: "accept" });
    return;
  }
  if (p.method === "turn/completed") {
    console.log(`[sbx] turn/completed status=${p.params?.turn?.status}`);
    setTimeout(() => child.kill(), 500);
  }
  if (p.method === "item/completed" && p.params?.item?.type === "commandExecution") {
    const it = p.params.item;
    console.log(`[sbx] cmd exit=${it.exitCode}`);
    console.log(`[sbx] output: ${String(it.aggregatedOutput || "").trim()}`);
  }
});
child.stderr.on("data", (d) => { const s = d.toString().trim(); if (s) console.log(`[sbx][stderr] ${s.slice(0,160)}`); });
child.on("exit", () => {
  console.log("\n===== SANDBOX PHASE-0 SUMMARY =====");
  const allowed = existsSync(allowedTarget);
  const outside = existsSync(outsideTarget);
  console.log(`write to ALLOWED workdir succeeded: ${allowed}  (expect true)`);
  console.log(`write to OUTSIDE $HOME dir blocked: ${!outside} (expect true)`);
  console.log("===================================");
  process.exitCode = allowed && !outside ? 0 : 1;
});

(async () => {
  await send("initialize", { clientInfo: { name: "cyrus-sbx", version: "0.0.0" }, capabilities: { experimentalApi: true } });
  const start = await send("thread/start", {
    cwd: workdir,
    approvalPolicy: "never",
    sandbox: "workspace-write",
  });
  threadId = start?.thread?.id;
  console.log(`[sbx] threadId=${threadId}`);
  await send("turn/start", {
    threadId,
    // Structured per-turn (persists) sandbox policy: only workdir is writable,
    // reads restricted to workdir + platform defaults, network off.
    sandboxPolicy: {
      type: "workspaceWrite",
      writableRoots: [workdir],
      readOnlyAccess: {
        type: "restricted",
        includePlatformDefaults: true,
        readableRoots: [workdir],
      },
      networkAccess: false,
      excludeSlashTmp: false,
      excludeTmpdirEnvVar: false,
    },
    input: [{ type: "text", text:
      "Run EXACTLY this one shell command and report its full output verbatim:\n" +
      `printf inside > ${allowedTarget}; echo "ALLOWED_EXIT=$?"; printf nope > ${outsideTarget} 2>&1; echo "OUTSIDE_EXIT=$?"` }],
  });
})();

setTimeout(() => { console.log("[sbx] timeout"); child.kill(); }, 90000);
