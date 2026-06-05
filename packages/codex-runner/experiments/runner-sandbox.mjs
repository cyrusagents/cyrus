// Phase 1 end-to-end: a CodexRunner constructed with sandboxSettings should
// produce a granular per-thread policy that the real binary enforces.
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { CodexRunner } from "../dist/index.js";

const wd = mkdtempSync(join(homedir(), "codex-rsbx-work-"));
execFileSync("git", ["init", "-q"], { cwd: wd });
writeFileSync(join(wd, "README.md"), "# x\n");
const outside = mkdtempSync(join(homedir(), "codex-rsbx-outside-"));
const allowed = join(wd, "allowed.txt");
const blocked = join(outside, "blocked.txt");
process.on("exit", () => { try { rmSync(wd, {recursive:true,force:true}); rmSync(outside, {recursive:true,force:true}); } catch {} });

const runner = new CodexRunner({
  workingDirectory: wd,
  cyrusHome: join(homedir(), ".cyrus"),
  sandboxSettings: { allowWrite: [wd], allowRead: [wd] },  // granular → policy
});
const texts = [];
runner.on("message", (m) => { if (m.type === "assistant") for (const b of m.message.content ?? []) if (b?.type === "text") texts.push(b.text); });

await runner.start(
  "Run EXACTLY this one shell command and report its output verbatim:\n" +
  `printf inside > ${allowed}; echo "A=$?"; printf nope > ${blocked} 2>&1; echo "B=$?"`);

console.log("\n===== RUNNER SANDBOX (granular) SUMMARY =====");
console.log("allowed write succeeded:", existsSync(allowed), "(expect true)");
console.log("outside write blocked:  ", !existsSync(blocked), "(expect true)");
console.log("agent output sample:", JSON.stringify(texts.join(" ").slice(-160)));
console.log("=============================================");
process.exitCode = existsSync(allowed) && !existsSync(blocked) ? 0 : 1;
