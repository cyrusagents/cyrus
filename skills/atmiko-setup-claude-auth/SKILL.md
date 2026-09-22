---
name: atmiko-setup-claude-auth
description: Configure Claude Code authentication for Atmiko — API key, OAuth token, or third-party provider.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.atmiko/.env` or any file inside `~/.atmiko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Claude Auth

Configures Claude Code credentials so Atmiko can run AI sessions.

## Step 1: Check Existing Auth

Check if credentials are already configured:

```bash
grep -c -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' ~/.atmiko/.env 2>/dev/null || echo "0"
```

If the count is >= 1, inform the user:

> Claude Code authentication is already configured. Skipping this step.
> To reconfigure, remove the existing key from `~/.atmiko/.env` and re-run this skill.

Skip to completion.

## Step 2: Choose Auth Method

Ask the user:

> **How would you like to authenticate Claude Code?**
>
> 1. **Current account** (easiest) — use the credentials from your active `claude` CLI session
> 2. **API Key** — from [console.anthropic.com](https://console.anthropic.com/)
> 3. **Separate OAuth token** — run `claude setup-token` to generate a token for a specific account
> 4. **Third-Party Provider** — Vertex AI, AWS Bedrock, Azure, etc.

## Step 3: Configure Credentials

**CRITICAL: Secrets must NEVER appear in the conversation.** Do not explore `~/.claude/` looking for credential files. Use only the methods below.

Detect the OS for the right clipboard command:

```bash
uname -s
```

### Option 1: Current Account

Check if `claude` is authenticated on this machine:

```bash
claude auth status
```

If authenticated, instruct the user to run `claude setup-token` which will output a token.

To capture it safely, **append a placeholder line** to the env file, then open it in a GUI window so the user can paste the token:

```bash
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' ~/.atmiko/.env || echo 'CLAUDE_CODE_OAUTH_TOKEN=' >> ~/.atmiko/.env
```

Then open the file in a separate window — use whatever GUI editor is available:

```bash
# macOS: VS Code if available, otherwise TextEdit
code --new-window ~/.atmiko/.env 2>/dev/null || open -a TextEdit ~/.atmiko/.env

# Linux
code ~/.atmiko/.env 2>/dev/null || xdg-open ~/.atmiko/.env
```

Tell the user:

> 1. Run `claude setup-token` in a separate terminal
> 2. Copy the token it outputs
> 3. I've opened `~/.atmiko/.env` — find the `CLAUDE_CODE_OAUTH_TOKEN=` line
> 4. Paste the token right after the `=` (no spaces, no newline)
> 5. Save and close the file

### Option 2: API Key

Instruct the user to copy their API key from the [Anthropic Console](https://console.anthropic.com/), then provide the appropriate command:

**macOS:**
```bash
printf 'ANTHROPIC_API_KEY=%s\n' "$(pbpaste)" >> ~/.atmiko/.env
```

**Linux:**
```bash
printf 'ANTHROPIC_API_KEY=%s\n' "$(xclip -selection clipboard -o)" >> ~/.atmiko/.env
```

**Universal fallback:**
```bash
read -s -p "Paste your Anthropic API key: " val && printf 'ANTHROPIC_API_KEY=%s\n' "$val" >> ~/.atmiko/.env && echo " ✓ Saved"
```

### Option 3: Separate OAuth Token

This is for when the user wants to generate a token for a different account than the one currently logged in (e.g., running `claude setup-token` on another machine).

Append the placeholder, then open the file for the user to paste:

```bash
grep -q '^CLAUDE_CODE_OAUTH_TOKEN=' ~/.atmiko/.env || echo 'CLAUDE_CODE_OAUTH_TOKEN=' >> ~/.atmiko/.env
```

```bash
# macOS
code --new-window ~/.atmiko/.env 2>/dev/null || open -a TextEdit ~/.atmiko/.env
# Linux
code ~/.atmiko/.env 2>/dev/null || xdg-open ~/.atmiko/.env
```

Tell the user:

> 1. On the other machine, run `claude setup-token`
> 2. Copy the token it outputs
> 3. I've opened `~/.atmiko/.env` — find `CLAUDE_CODE_OAUTH_TOKEN=` and paste the token after the `=`
> 4. Save and close

### Option 4: Third-Party Provider

Inform the user:

> For third-party providers, you'll need to set provider-specific environment variables.
> See [Third-Party Integrations](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex) for details.
>
> Common configurations:
>
> **AWS Bedrock:**
> ```
> CLAUDE_CODE_USE_BEDROCK=1
> AWS_REGION=us-east-1
> ```
>
> **Google Vertex AI:**
> ```
> CLAUDE_CODE_USE_VERTEX=1
> CLOUD_ML_REGION=us-east5
> ANTHROPIC_VERTEX_PROJECT_ID=your-project-id
> ```

Guide the user to add the appropriate variables to `~/.atmiko/.env` using the clipboard-to-env pattern.

## Step 4: Verify

After the user runs the command, verify the key was written:

```bash
grep -c -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CODE_USE_BEDROCK|CLAUDE_CODE_USE_VERTEX)=' ~/.atmiko/.env
```

If the count is 0, the credential was not saved. Ask the user to try again.

## Completion

> ✓ Claude Code authentication configured.
