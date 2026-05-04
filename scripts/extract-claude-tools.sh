#!/usr/bin/env bash
#
# Extract the current tool list from Claude Code's init block.
#
# Usage:
#   ./scripts/extract-claude-tools.sh
#
# This runs a minimal Claude Code session with stream-json output and
# extracts the tool names from the 'init' message. Use this whenever
# updating @anthropic-ai/claude-agent-sdk to refresh the tool allowance
# lists in packages/claude-runner/src/config.ts.

set -euo pipefail

# Resolve the native Claude Code binary bundled inside @anthropic-ai/claude-agent-sdk.
# Since SDK >=0.2.113, the SDK ships platform-specific optional dependency packages
# (e.g. @anthropic-ai/claude-agent-sdk-darwin-arm64) instead of a bundled cli.js.
# We resolve the platform package via the SDK's own node_modules context (pnpm hoists
# the optional dep alongside the SDK, not in the consumer package).
CLI_PATH=$(node -e "
  const { createRequire } = require('module');
  const { dirname, join } = require('path');
  const { existsSync } = require('fs');
  const os = require('os');
  const arch = os.arch() === 'arm64' ? 'arm64' : 'x64';
  const plat = os.platform(); // darwin, linux, win32
  const platform = plat + '-' + arch;
  const binaryName = plat === 'win32' ? 'claude.exe' : 'claude';
  const pkgName = '@anthropic-ai/claude-agent-sdk-' + platform;

  // Resolve the SDK from claude-runner's context, then resolve the platform
  // package from the SDK's own directory (where pnpm co-installs optional deps).
  const runnerReq = createRequire(require.resolve('./packages/claude-runner/package.json'));
  const sdkPath = runnerReq.resolve('@anthropic-ai/claude-agent-sdk');
  const sdkReq = createRequire(join(dirname(sdkPath), 'package.json'));

  try {
    const pkgJsonPath = sdkReq.resolve(pkgName + '/package.json');
    const binaryPath = join(dirname(pkgJsonPath), binaryName);
    if (!existsSync(binaryPath)) {
      process.stderr.write('Binary not found at: ' + binaryPath + '\n');
      process.exit(1);
    }
    process.stdout.write(binaryPath);
  } catch (e) {
    process.stderr.write('Could not resolve ' + pkgName + ': ' + e.message + '\n');
    process.exit(1);
  }
" 2>/dev/null) || {
  echo "ERROR: Could not resolve @anthropic-ai/claude-agent-sdk native binary."
  echo "Make sure dependencies are installed: pnpm install"
  exit 1
}

echo "Using SDK CLI: $CLI_PATH"
echo "Running Claude Code to capture init block..."
# Capture full output to a temp file to avoid SIGPIPE from head -1
# (pipefail + head causes claude to exit non-zero when the pipe closes early)
tmpfile=$(mktemp)
trap 'rm -f "$tmpfile"' EXIT
"$CLI_PATH" -p "say hi" --output-format stream-json --verbose 2>/dev/null > "$tmpfile" || true

# The init message (subtype: "init") contains the tool list — it's on line 2 since
# SDK >=0.2.113 emits a session_state_changed line first before the init.
init_json=$(grep '"subtype":"init"' "$tmpfile" | head -1)

# Fall back to first line for older SDK versions that don't have session_state_changed
if [ -z "$init_json" ]; then
  init_json=$(head -1 "$tmpfile")
fi

tools=$(echo "$init_json" | jq -r '.tools[]' 2>/dev/null)

if [ -z "$tools" ]; then
  echo "ERROR: Could not extract tools from init block."
  echo "Raw init line:"
  echo "$init_json"
  exit 1
fi

echo ""
echo "=== Claude Code Available Tools ==="
echo "$tools" | sort
echo ""
echo "Total: $(echo "$tools" | wc -l | tr -d ' ') tools"
echo ""
echo "Compare these against packages/claude-runner/src/config.ts availableTools"
echo "and update the list if there are differences."
