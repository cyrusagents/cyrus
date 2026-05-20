# Cyrus Configuration File

Cyrus stores configuration in `~/.cyrus/config.json`. This file is created automatically during initial setup and can be edited manually to customize behavior.

Editing this manually only applies to those running the fully end-to-end self-hosted. Those who are paying for Cyrus, management of config.json is automated.

---

## Repository Configuration

Each repository in the `repositories` array can have these properties:

### `allowedTools` (array of strings)

Controls which tools Claude can use when processing issues. Default: all standard tools plus `Bash(git:*)` and `Bash(gh:*)`.

Examples:

- `["Read", "Edit", "Bash(git:*)", "Task"]` - Allow reading, editing, git commands, and task management
- `["Read", "Edit", "Bash(npm:*)", "WebSearch"]` - Allow reading, editing, npm commands, and web search
- `["Read", "Edit", "mcp__github"]` - Allow all tools from the GitHub MCP server
- `["Read", "Edit", "mcp__github__search_repositories"]` - Allow only the search_repositories tool from GitHub MCP

For security configuration details, see: https://code.claude.com/docs/en/settings#permission-settings

### `mcpConfigPath` (string or array of strings)

Path(s) to MCP (Model Context Protocol) configuration files. MCP allows Claude to access external tools and data sources like databases or APIs.

Can be specified as:

- A single string: `"mcpConfigPath": "/home/user/myapp/mcp-config.json"`
- An array of strings: `"mcpConfigPath": ["/home/user/myapp/mcp-base.json", "/home/user/myapp/mcp-local.json"]`

When multiple files are provided, configurations are composed together. Later files override earlier ones for the same server names.

Expected file format:

```json
{
  "mcpServers": {
    "server-name": {
      "type": "stdio",
      "command": "command-to-run",
      "args": ["arg1", "arg2"]
    }
  }
}
```

Learn more about MCP: https://code.claude.com/docs/en/mcp

### `opencode.config` (object)

OpenCode sessions run with Cyrus-managed runtime isolation for config, state, and cache. Cyrus sets OpenCode's config, state, and cache roots under the Cyrus home directory for each workspace so sessions do not implicitly inherit arbitrary machine-wide OpenCode runtime config. Cyrus intentionally leaves OpenCode's data home unchanged so CLI-managed auth and provider metadata remain available. This keeps generated MCP servers and permission rules deterministic while preserving login/provider setup, but it also means plugins, skills, hooks, and other OpenCode-native settings from your normal global OpenCode config are not automatically visible inside Cyrus sessions.

Use `opencode.config` when an OpenCode session needs OpenCode-native runtime configuration such as plugins, instructions, formatters, providers, themes, or other OpenCode config keys. It can be configured globally or per repository.

**Global OpenCode config example:**

```json
{
  "opencode": {
    "config": {
      "plugin": ["opencode-wakatime"],
      "instructions": ["~/.config/opencode/CYRUS.md"],
      "share": "disabled"
    }
  },
  "repositories": [
    {
      "id": "main-app",
      "name": "Main Application",
      "repositoryPath": "/path/to/repo"
    }
  ]
}
```

**Repository OpenCode config example:**

```json
{
  "repositories": [
    {
      "id": "main-app",
      "name": "Main Application",
      "repositoryPath": "/path/to/repo",
      "opencode": {
        "config": {
          "plugin": ["@company/opencode-repo-plugin"],
          "instructions": ["OPENCODE.md"],
          "formatter": true
        }
      }
    }
  ]
}
```

Within the Cyrus-generated inline OpenCode config, values are merged in this order:

1. Global `opencode.config`
2. Repository `opencode.config`
3. Cyrus-generated MCP configuration
4. Cyrus-generated permission configuration

Merge behavior:

- Objects deep-merge.
- Arrays replace earlier arrays instead of concatenating.
- Repository values override global values for the same non-object key.
- Cyrus-generated MCP servers win over user-provided MCP servers with the same name.
- Cyrus-generated permissions replace user-provided OpenCode permissions because they are Cyrus safety controls.

This describes Cyrus's inline config merge order, not OpenCode's complete config-loading precedence. OpenCode applies Cyrus's inline config after project config, so the managed inline config can still override OpenCode settings that were loaded earlier.

For MCP servers that should work across runners, prefer `mcpConfigPath`. Cyrus reads those MCP server definitions and translates them for Claude, OpenCode, and other supported runners. Use `opencode.config` for OpenCode-native runtime config that only applies to OpenCode.

### `teamKeys` (array of strings)

Routes Linear issues from specific teams to this repository. When specified, only issues from matching teams trigger Cyrus.

Example: `["CEE", "FRONT", "BACK"]` - Only process issues from teams CEE, FRONT, and BACK

### `projectKeys` (array of strings)

Routes Linear issues from specific projects to this repository. When specified, only issues belonging to the listed Linear projects will be processed by this repository.

Example: `["Mobile App", "Web Platform", "API Service"]` - Only process issues that belong to these Linear projects

Note: This is useful when you want to separate work by project rather than by team, especially in organizations where multiple projects span across teams.

### `routingLabels` (array of strings)

Routes Linear issues with specific labels to this repository. This is useful when you have multiple repositories handling issues from the same Linear team but want to route based on labels (e.g., "backend" vs "frontend" labels).

Example: `["backend", "api"]` - Only process issues that have the "backend" or "api" label

---

## Routing Priority Order

When multiple routing configurations are present, Cyrus evaluates them in the following priority order:

1. **`routingLabels`** (highest priority) - Label-based routing
2. **`projectKeys`** (medium priority) - Project-based routing
3. **`teamKeys`** (lowest priority) - Team-based routing

If an issue matches multiple routing configurations, the highest priority match will be used. For example, if an issue has a label that matches `routingLabels` and also belongs to a project in `projectKeys`, the label-based routing will take precedence.

---

## Label-Based AI Modes

### `labelPrompts` (object)

Routes issues to different AI modes based on Linear labels and optionally configures allowed tools per mode.

**Simple format (labels only):**

```json
{
  "debugger": ["Bug"],
  "builder": ["Feature", "Improvement"],
  "scoper": ["PRD"]
}
```

**Advanced format (with dynamic tool configuration):**

```json
{
  "debugger": {
    "labels": ["Bug"],
    "allowedTools": "readOnly"
  },
  "builder": {
    "labels": ["Feature", "Improvement"],
    "allowedTools": "safe"
  },
  "scoper": {
    "labels": ["PRD"],
    "allowedTools": ["Read", "Glob", "Grep", "WebFetch", "mcp__linear"]
  }
}
```

**Modes:**

- **debugger**: Systematic problem investigation mode
- **builder**: Feature implementation mode
- **scoper**: Requirements analysis mode

**Tool Presets:**

- **`"readOnly"`**: Only tools that read/view content (17 tools)
   - `Read`, `Glob`, `Grep`, `WebFetch`, `WebSearch`, `TaskCreate`, `TaskUpdate`, `TaskGet`, `TaskList`, `Task`, `Skill`, `ListMcpResourcesTool`, `ReadMcpResourceTool`, `Monitor`, `TaskOutput`, `EnterPlanMode`, `ExitPlanMode`

- **`"safe"`**: All tools except Bash (32 tools)
   - All readOnly tools plus: `Edit`, `Write`, `NotebookEdit`, `AskUserQuestion`, `SendMessage`, `EnterWorktree`, `ExitWorktree`, `CronCreate`, `CronDelete`, `CronList`, `RemoteTrigger`, `ScheduleWakeup`, `TaskStop`, `TeamCreate`, `TeamDelete`

- **`"all"`**: All available tools including Bash (33 tools)
   - All safe tools plus: `Bash`

- **Custom array**: Specify exact tools needed, e.g., `["Read", "Edit", "Task"]`

Note: Linear MCP tools (`mcp__linear`) are always included automatically. Slack MCP tools (`mcp__slack`) are included when the `SLACK_BOT_TOKEN` environment variable is set (Linear and Slack sessions only; excluded from GitHub sessions).

---

## User Access Control

Control which Linear users can delegate issues to Cyrus. Supports both global configuration and per-repository overrides.

### `userAccessControl` (object)

Can be configured at the global level or per-repository.

**Properties:**

- **`allowedUsers`** (array) - Users allowed to delegate issues. If specified, ONLY these users can trigger sessions. Omit to allow everyone.
- **`blockedUsers`** (array) - Users blocked from delegating issues. Takes precedence over allowedUsers.
- **`blockBehavior`** (string) - What happens when a blocked user tries to delegate:
  - `"silent"` (default) - Ignore the webhook quietly
  - `"comment"` - Post a message explaining the user is not authorized
- **`blockMessage`** (string) - Custom message when blockBehavior is "comment". Supports template variables:
  - `{{userName}}` - The user's display name
  - `{{userId}}` - The user's Linear ID

  Default: `"{{userName}}, you are not authorized to delegate issues to this agent."`

**User Identifiers:**

Users can be specified in three formats:
- String (treated as Linear user ID): `"usr_abc123"`
- Object with ID: `{ "id": "usr_abc123" }`
- Object with email: `{ "email": "user@example.com" }` (case-insensitive)

**Example - Global configuration:**

```json
{
  "userAccessControl": {
    "blockedUsers": ["usr_known_bad_actor"],
    "blockBehavior": "comment",
    "blockMessage": "{{userName}}, please contact your team lead to use this agent."
  },
  "repositories": [...]
}
```

**Example - Per-repository configuration:**

```json
{
  "repositories": [{
    "id": "main-app",
    "name": "Main Application",
    "userAccessControl": {
      "allowedUsers": [
        "usr_senior_dev_1",
        { "email": "lead@company.com" },
        { "id": "usr_senior_dev_2" }
      ],
      "blockBehavior": "comment"
    }
  }]
}
```

**Inheritance Rules:**

- **allowedUsers**: Repository config OVERRIDES global (not merged)
- **blockedUsers**: Repository config EXTENDS global (merged/additive)
- **blockBehavior**: Repository config OVERRIDES global
- **blockMessage**: Repository config OVERRIDES global

---

## Sandbox (Network Egress Control)

### `sandbox` (object)

Controls network egress for agent sessions. When enabled, all Bash-spawned subprocess traffic (git, gh, npm, curl, etc.) routes through a local egress proxy for domain filtering, request logging, and per-domain header injection. Claude's inference API, MCP servers, and built-in file tools (Read/Edit/Write) are unaffected.

**Properties:**

- **`enabled`** (boolean) - Enable or disable the egress proxy. Default: `false`
- **`httpProxyPort`** (number) - HTTP proxy port. Default: `9080`
- **`socksProxyPort`** (number) - SOCKS proxy port. Default: `9081`
- **`systemWideCert`** (boolean) - Set to `true` after trusting the CA cert system-wide (e.g., via `sudo security add-trusted-cert`). When true, per-session CA cert env vars (`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, etc.) are skipped — the OS cert store handles trust for all tools. Default: `false`
- **`logRequests`** (boolean) - Log all proxied requests. Default: `true`
- **`networkPolicy`** (object) - Domain allow/deny rules and header transforms. If omitted, all traffic is allowed (passthrough mode with logging).
  - **`preset`** (`"trusted"`) - Pre-populate the allow list with ~200 domains matching [Claude Code on the web's default allowlist](https://docs.anthropic.com/en/docs/claude-code/claude-code-on-the-web#default-allowed-domains). Covers package registries (npm, PyPI, RubyGems, crates.io, Maven, etc.), version control (GitHub, GitLab, Bitbucket), container registries (Docker Hub, GCR, ECR, GHCR), cloud platforms (GCP, Azure, AWS, Oracle), dev tools (Kubernetes, HashiCorp, Anaconda), monitoring (Sentry, Datadog, Honeycomb), and more. Custom `allow` rules are merged on top.
  - **`allow`** (object) - Domain allow rules with optional header transforms. Keys are domain patterns (e.g., `"api.example.com"`, `"*.example.com"`). When present, all unlisted domains are denied.
  - **`subnets`** (object) - IP-range-based allow/deny rules.

**Example — use the trusted preset (recommended starting point):**

```json
{
  "sandbox": {
    "enabled": true,
    "networkPolicy": {
      "preset": "trusted"
    }
  }
}
```

**Example — trusted preset with additional custom domains:**

```json
{
  "sandbox": {
    "enabled": true,
    "networkPolicy": {
      "preset": "trusted",
      "allow": {
        "internal.company.com": [{}],
        "*.internal.corp": [{}]
      }
    }
  }
}
```

**Example — custom allow list with header injection:**

```json
{
  "sandbox": {
    "enabled": true,
    "networkPolicy": {
      "allow": {
        "api.github.com": [{}],
        "registry.npmjs.org": [{}],
        "api.example.com": [
          {
            "transform": [
              {
                "headers": {
                  "Authorization": "Bearer ${API_TOKEN}"
                }
              }
            ]
          }
        ]
      }
    }
  }
}
```

When `networkPolicy.allow` is specified (or expanded from a preset), all domains not in the list are blocked (deny-all). Domains with `transform` rules get TLS termination for header injection; all others pass through as CONNECT tunnels.

### CA Certificate Trust

The egress proxy generates a CA certificate at `~/.cyrus/certs/cyrus-egress-ca.pem` for TLS interception of domains with transform rules. This cert is stable across restarts — once trusted, it stays trusted.

**Automatic (per-session, when `systemWideCert: false`):** Cyrus sets the following env vars automatically for every agent session:

| Env Var | Covers |
|---------|--------|
| `NODE_EXTRA_CA_CERTS` | Node.js, npm, SDK |
| `GIT_SSL_CAINFO` | Git HTTPS |
| `SSL_CERT_FILE` | OpenSSL-based tools, Ruby |
| `REQUESTS_CA_BUNDLE` | Python requests |
| `PIP_CERT` | pip |
| `CURL_CA_BUNDLE` | curl (when compiled against OpenSSL) |
| `CARGO_HTTP_CAINFO` | Rust/Cargo |
| `AWS_CA_BUNDLE` | AWS CLI, boto3 |
| `DENO_CERT` | Deno |

If `NODE_EXTRA_CA_CERTS` is already set in the host environment (e.g., corporate proxy), Cyrus merges both certs into a combined bundle.

**Not covered by env vars (require system-wide trust):**

- **Bun** — uses the system cert store; no env var override
- **.NET (dotnet/nuget)** — uses the system cert store on macOS
- **curl on macOS** — when compiled against SecureTransport (the default), uses the system keychain rather than `CURL_CA_BUNDLE`

For these tools, system-wide trust is required.

**System-wide trust (recommended):** Trust the cert in the OS certificate store, then set `systemWideCert: true` to skip per-session env vars:

```bash
# macOS
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.cyrus/certs/cyrus-egress-ca.pem

# Linux
sudo cp ~/.cyrus/certs/cyrus-egress-ca.pem /usr/local/share/ca-certificates/cyrus-egress-ca.crt
sudo update-ca-certificates
```

Then update config.json:

```json
{
  "sandbox": {
    "enabled": true,
    "systemWideCert": true
  }
}
```

On startup, Cyrus checks whether the cert is trusted system-wide (macOS keychain or Linux CA certificates) and logs the result:

```
🛡️  CA certificate is trusted system-wide ✓
🛡️  systemWideCert: true — per-session CA cert env vars are skipped (OS cert store handles trust)
```

or, if not yet trusted:

```
[WARN] 🛡️  CA certificate is NOT trusted in the macOS System keychain. To trust (requires sudo):
[WARN] 🛡️  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.cyrus/certs/cyrus-egress-ca.pem
```

---

## Global Configuration

In addition to repository-specific settings, you can configure global defaults:

### `promptDefaults` (object)

Sets default allowed tools for each prompt type across all repositories. Repository-specific configurations override these defaults.

```json
{
  "promptDefaults": {
    "debugger": {
      "allowedTools": "readOnly"
    },
    "builder": {
      "allowedTools": "safe"
    },
    "scoper": {
      "allowedTools": ["Read", "Glob", "Grep", "WebFetch", "mcp__linear"]
    }
  }
}
```

### `global_setup_script` (string)

Path to a script that runs for all repositories when creating new worktrees. See the main README for details on setup scripts.

---

## Tool Configuration Priority

When determining allowed tools, Cyrus follows this priority order:

1. Repository-specific prompt configuration (`labelPrompts.debugger.allowedTools`)
2. Global prompt defaults (`promptDefaults.debugger.allowedTools`)
3. Repository-level allowed tools (`allowedTools`)
4. Global default allowed tools
5. Safe tools fallback (all tools except Bash)

---

## Example Configuration

```json
{
  "promptDefaults": {
    "debugger": {
      "allowedTools": "readOnly"
    },
    "builder": {
      "allowedTools": "safe"
    }
  },
  "repositories": [{
    "id": "workspace-123456",
    "name": "my-app",
    "repositoryPath": "/path/to/repo",
    "allowedTools": ["Read", "Edit", "Bash(git:*)", "Bash(gh:*)", "Task"],
    "mcpConfigPath": "./mcp-config.json",
    "teamKeys": ["BACKEND"],
    "projectKeys": ["API Service", "Backend Infrastructure"],
    "routingLabels": ["backend", "api", "infrastructure"],
    "labelPrompts": {
      "debugger": {
        "labels": ["Bug", "Hotfix"],
        "allowedTools": "all"
      },
      "builder": {
        "labels": ["Feature"]
      },
      "scoper": {
        "labels": ["RFC", "Design"]
      }
    }
  }]
}
```

---

## Core Repository Fields

Each repository configuration includes these required fields:

- `id` - Unique identifier for the repository
- `name` - Repository name
- `repositoryPath` - Absolute path to the repository on disk
- `baseBranch` - Default branch for the repository (e.g., "main")
- `githubUrl` - GitHub repository URL (e.g., `"https://github.com/org/repo"`) — used for webhook matching and routing
- `gitlabUrl` - GitLab repository URL (e.g., `"https://gitlab.com/group/project"`) — used for webhook matching and routing
- `workspaceBaseDir` - Directory for git worktrees
- `isActive` - Whether the repository is active
- `linearWorkspaceId` - Linear workspace UUID (references a key in `linearWorkspaces`)

These fields are managed automatically during setup. For self-hosted instances, use the `cyrus self-auth-linear` and `cyrus self-add-repo` commands.
