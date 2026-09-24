---
name: miko-setup-launch
description: Print a summary of the Miko setup and offer to start the agent.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.miko/.env` or any file inside `~/.miko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Launch

Prints a summary of the completed setup and offers to start Miko.

Use the absolute `MIKO_ENTRY` launcher from the prerequisites step. Verify `node "$MIKO_ENTRY" --installation` reports the selected mikoagents/miko commit. If this skill is invoked independently, resolve the default or user-selected install directory first; run prerequisites if no verified fork installation exists. Do not resolve a bare global `miko` executable.

Include the source commit and launcher path in the summary. Preserve an already authorized background method. When replacing an existing service, inspect its current command, wait until `/status` reports idle, and gracefully stop it before switching to this launcher; keep its environment and tunnel configuration. Avoid starting a second worker on the same port.

## Step 1: Gather Configuration

Read current state:

```bash
# Base URL
grep '^MIKO_BASE_URL=' ~/.miko/.env 2>/dev/null | cut -d= -f2-

# Linear
grep -c '^LINEAR_CLIENT_ID=' ~/.miko/.env 2>/dev/null

# GitHub
gh auth status 2>&1 | head -1

# Slack
grep -c '^SLACK_BOT_TOKEN=' ~/.miko/.env 2>/dev/null

# Repositories
cat ~/.miko/config.json 2>/dev/null

# Claude auth
grep -c -E '^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN)=' ~/.miko/.env 2>/dev/null
```

## Step 2: Print Summary

Print a formatted summary:

```
┌─────────────────────────────────────┐
│         Miko Setup Complete        │
├─────────────────────────────────────┤
│                                     │
│  Endpoint: https://your-url.com     │
│  Claude:   ✓ API key configured     │
│                                     │
│  Surfaces:                          │
│    Linear:  ✓ Workspace connected   │
│    GitHub:  ✓ CLI authenticated     │
│    Slack:   ✓ Bot configured        │
│                                     │
│  Repositories:                      │
│    • yourorg/yourrepo               │
│    • yourorg/another-repo           │
│                                     │
└─────────────────────────────────────┘
```

Use ✓ for configured items and ✗ for skipped/unconfigured items.

## Step 3: Make Miko Persistent

Miko needs to run as a background process so it stays alive and restarts after reboots. **Use the `AskUserQuestion` tool if available** to ask:

> **How would you like to keep Miko running in the background?**
>
> 1. **pm2** (recommended) — Node.js process manager. Simple to set up, auto-restarts on crash, log management built in. Best for most users.
> 2. **systemd** (Linux only) — OS-level service manager. Starts on boot automatically, managed with `systemctl`. Best for dedicated Linux servers.
> 3. **Neither** — run the fork launcher in the foreground for now.

### Option 1: pm2

The agent should run all of these commands directly:

1. Check if pm2 is installed (`which pm2`). If not, install it (`npm install -g pm2`).
2. Start the verified launcher: `pm2 start "$MIKO_ENTRY" --name miko --interpreter "<absolute node executable>" -- start`. Resolve Node with `command -v node` (Bash) or `(Get-Command node).Source` (PowerShell). For an existing pm2 process, update its script/interpreter to these paths instead of only restarting a process that still points to the npm CLI.
3. Save the process list: `pm2 save`
4. On supported Unix systems, use `pm2 startup` to configure reboot persistence. On Windows, preserve an existing scheduled task or background launcher and replace its Miko invocation with `node "<MIKO_ENTRY>" start`; use `Start-Process -WindowStyle Hidden` for a background launch. Do not claim reboot persistence from `pm2 save` alone on Windows.

After setup, inform the user of useful commands:
- `pm2 logs miko` — view logs
- `pm2 restart miko` — restart
- `pm2 stop miko` — stop

### Option 2: systemd (Linux only)

The agent should run all of these commands directly:

1. Resolve the actual values for the service file:
   ```bash
   NODE_BIN=$(command -v node)
   MIKO_USER=$(whoami)
   ```

2. Write the service file:
   ```bash
   sudo tee /etc/systemd/system/miko.service > /dev/null << EOF
   [Unit]
   Description=Miko AI Agent
   After=network.target

   [Service]
   Type=simple
   User=$MIKO_USER
   EnvironmentFile=/home/$MIKO_USER/.miko/.env
   ExecStart="$NODE_BIN" "$MIKO_ENTRY" start
   Restart=always
   RestartSec=10

   [Install]
   WantedBy=multi-user.target
   EOF
   ```

3. Enable and start:
   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable miko
   sudo systemctl start miko
   ```

After setup, inform the user of useful commands:
- `sudo systemctl status miko` — check status
- `sudo journalctl -u miko -f` — view logs
- `sudo systemctl restart miko` — restart

### Option 3: Foreground

Run directly:

```bash
node "$MIKO_ENTRY" start
```

## Step 4: Start ngrok (if applicable)

If the user configured ngrok in the endpoint step, the agent should start it:

```bash
ngrok start miko
```

If using pm2, also make ngrok persistent:

```bash
pm2 start "ngrok start miko" --name ngrok
pm2 save
```

## Step 5: Sandbox CA Certificate Trust (if sandbox enabled)

If the user's `~/.miko/config.json` has `sandbox.enabled: true`, check whether the egress proxy CA certificate is trusted in the system keychain.

**Check if sandbox is enabled:**

```bash
grep -o '"enabled":\s*true' ~/.miko/config.json 2>/dev/null | head -1
```

If sandbox is enabled, check trust status:

```bash
# macOS — check System keychain for the Miko CA
security find-certificate -c "Miko Egress Proxy CA" /Library/Keychains/System.keychain 2>&1
```

- If the cert is found (exit code 0): report ✓ trusted. Offer to set `sandbox.systemWideCert: true` in config.json to skip per-session cert env vars.
- If not found (exit code 44): inform the user and offer to run the trust command:

```bash
sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain ~/.miko/certs/miko-egress-ca.pem
```

On Linux, check with `test -f /usr/local/share/ca-certificates/miko-egress-ca.crt`. If not present:

```bash
sudo cp ~/.miko/certs/miko-egress-ca.pem /usr/local/share/ca-certificates/miko-egress-ca.crt
sudo update-ca-certificates
```

After trusting system-wide, offer to set `sandbox.systemWideCert: true` in config.json. This skips per-session cert env vars (`NODE_EXTRA_CA_CERTS`, `GIT_SSL_CAINFO`, etc.) since the OS cert store handles trust for all tools.

If the user declines system-wide trust, Miko still works — it sets cert env vars per-session. But some tools (Bun, .NET, curl on macOS with SecureTransport) will only work with system-wide trust.

## Step 6: Verify Running

Once Miko starts, verify it's listening:

```bash
curl -s http://localhost:3456/status
```

Should return `{"status":"idle"}` or similar.

Also load `/board` and `/board/api/snapshot` directly on the same loopback port. Confirm the service's executable/script points to the verified fork launcher; a working `/status` alone can belong to an older official instance. Report the installed source commit and board URL.

> Then try assigning a Linear issue to Miko, or @mentioning it in Slack, to verify the full pipeline works!

## Completion

> ✓ Miko is running and ready. Assign a Linear issue or @mention in Slack to test it out!
