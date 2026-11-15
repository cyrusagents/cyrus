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

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd -- "$SCRIPT_DIR/.." && pwd)
cd "$REPO_ROOT"

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
echo "Running clean default-permission Claude Code init profiles..."
work_dir=$(mktemp -d "${TMPDIR:-/tmp}/claude-tools.XXXXXX")
trap 'rm -rf "$work_dir"' EXIT
mkdir -p "$work_dir/claude-config"

node_path=$(command -v node)
jq -n \
  --arg command "$node_path" \
  --arg fixture "$REPO_ROOT/scripts/fixtures/mcp-resource-server.mjs" \
  '{mcpServers: {"resource-fixture": {command: $command, args: [$fixture]}}}' \
  > "$work_dir/resource-mcp.json"

capture_init() {
  local output_file=$1
  shift
  # Use an isolated configuration and a non-secret placeholder API key. The
  # init block is emitted before the expected authentication failure. This
  # keeps the extraction deterministic without reading operator settings,
  # plugins, credentials, or configured MCP servers.
  CLAUDE_CONFIG_DIR="$work_dir/claude-config" \
  ANTHROPIC_API_KEY="tool-extraction-placeholder" \
  CLAUDE_CODE_ENABLE_TODO_TOOLS=1 \
    "$CLI_PATH" -p "say hi" \
      --output-format stream-json \
      --verbose \
      --permission-mode default \
      --setting-sources "" \
      --strict-mcp-config \
      --no-session-persistence \
      "$@" 2>/dev/null \
    | awk '/"subtype":"init"/ {print; exit}' > "$output_file" || true

  if ! jq -e '.subtype == "init"' "$output_file" >/dev/null 2>&1; then
    echo "ERROR: Could not extract an init block."
    cat "$output_file"
    exit 1
  fi
}

capture_init "$work_dir/default-init.json"
capture_init "$work_dir/resource-init.json" --mcp-config "$work_dir/resource-mcp.json"

jq -r '.tools[]' "$work_dir/default-init.json" | sort > "$work_dir/default-tools.txt"
jq -r '.tools[]' "$work_dir/resource-init.json" | sort > "$work_dir/resource-tools.txt"

echo ""
echo "=== Clean Default Tools ==="
cat "$work_dir/default-tools.txt"
echo ""
echo "Total: $(wc -l < "$work_dir/default-tools.txt" | tr -d ' ') tools"

echo ""
echo "=== Added By A Resource-Capable MCP Server ==="
comm -13 "$work_dir/default-tools.txt" "$work_dir/resource-tools.txt"
echo ""
echo "Resource-enabled total: $(wc -l < "$work_dir/resource-tools.txt" | tr -d ' ') tools"
echo ""
echo "Compare these against packages/claude-runner/src/config.ts availableTools"
echo "and packages/core/src/allowed-tools-defaults.ts. MCP resource tools are"
echo "dynamic and appear only when a connected server advertises resources."
