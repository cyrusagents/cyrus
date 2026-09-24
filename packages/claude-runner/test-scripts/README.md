# Claude Runner Test Scripts

This directory contains test scripts for validating MCP (Model Context Protocol) configuration and Claude SDK functionality.

## Scripts

### `subagent-functionality-test.js`
Tests Claude subagent functionality through the ClaudeRunner. This script:
- Creates a temporary test workspace with `.claude/agents/` directory
- Defines a test subagent with specific system prompt and tools
- Tests Task tool delegation to subagents
- Verifies subagent identity preservation and response handling
- Provides comprehensive test results and debugging information

**Usage:**
```bash
# Uses Claude Code system authentication (run 'claude auth' first if needed)
node test-scripts/subagent-functionality-test.js
```

**Expected Results:**
- ✅ Task tool available in system tools
- ✅ Task tool delegation working
- ✅ Subagent response with "TEST SUBAGENT:" identifier
- ✅ File reading and tool usage within subagent context

### `test-mcp-config.js`
Tests MCP configuration through the ClaudeRunner wrapper. This script:
- Loads MCP config from `../../../ceedardbmcpconfig.json`
- Extracts allowed tools from `../../../.edge-config.json` 
- Uses ClaudeRunner to start a Claude session with MCP support
- Tests database queries using the `mcp__ceedardb__query` tool

**Usage:**
```bash
node test-scripts/test-mcp-config.js
```

### `test-direct-sdk.js`  
Tests MCP configuration directly through the Claude SDK. This script:
- Bypasses ClaudeRunner and uses the SDK directly
- Demonstrates how to properly parse and pass MCP configuration
- Shows detailed message flow between Claude and MCP tools
- Useful for debugging MCP connectivity issues

**Usage:**
```bash
node test-scripts/test-direct-sdk.js
```

## Configuration Requirements

Both scripts expect these files to exist in the parent directory (relative to miko repo root):
- `../ceedardbmcpconfig.json` - MCP server configuration
- `../.edge-config.json` - Repository and allowed tools configuration

## Example Output

When working correctly, you should see:
1. MCP servers loaded successfully
2. Claude using the `mcp__ceedardb__query` tool
3. Database query results returned as JSON
4. Successful completion with cost and usage stats

## Troubleshooting

If the MCP tool is not available:
1. Check that the MCP config file paths are correct
2. Verify the PostgreSQL connection string and certificates
3. Ensure the `@modelcontextprotocol/server-postgres` package is available
4. Check that `mcp__ceedardb__query` is in the allowed tools list