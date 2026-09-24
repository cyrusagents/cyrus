---
name: miko-setup-endpoint
description: Configure the public webhook endpoint for Miko — ngrok, Cloudflare Tunnel, or custom URL.
---

**CRITICAL: Never use `Read`, `Edit`, or `Write` tools on `~/.miko/.env` or any file inside `~/.miko/`. Use only `Bash` commands (`grep`, `printf >>`, etc.) to interact with env files — secrets must never be read into the conversation context.**

# Setup Endpoint

Configures a public URL so Linear (and other integrations) can send webhooks to your Miko instance.

## Step 1: Check Existing Configuration

```bash
grep -E '^MIKO_BASE_URL=' ~/.miko/.env 2>/dev/null
```

If `MIKO_BASE_URL` is already set, inform the user:

> Webhook endpoint already configured: `<value>`
> To reconfigure, remove `MIKO_BASE_URL` from `~/.miko/.env` and re-run this skill.

Skip to Step 4 (write port/webhooks if missing).

## Step 2: Choose Endpoint Method

Ask the user:

> **How will you expose Miko to the internet for webhooks?**
>
> 1. **ngrok** (recommended — every free account includes one static domain that persists across restarts)
> 2. **Cloudflare Tunnel** (permanent, requires Cloudflare account)
> 3. **Own URL** (you already have a public URL/domain)

**Important:** ngrok's free tier includes a permanent static domain — do NOT tell the user this is a paid feature or that URLs change on restart. Every free ngrok account gets one static domain at https://dashboard.ngrok.com/domains.

## Step 3: Configure Endpoint

### Option 1: ngrok

#### 3a. Check if ngrok is installed

```bash
which ngrok
```

If not installed, provide install instructions:

**macOS:**
```bash
brew install ngrok
```

**Linux:**
```bash
curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok-v3-stable-linux-amd64.tgz | sudo tar xvz -C /usr/local/bin
```

#### 3b. Guide ngrok domain setup

Instruct the user:

> ngrok provides a free static domain so your URL doesn't change between restarts.
>
> 1. Sign up or log in at https://dashboard.ngrok.com
> 2. Go to https://dashboard.ngrok.com/domains
> 3. Copy your free static domain (e.g., `your-name-here.ngrok-free.app`)
> 4. Go to https://dashboard.ngrok.com/get-started/your-authtoken and copy your authtoken

Ask the user to provide:
- Their ngrok domain
- Their ngrok authtoken

**CRITICAL: The authtoken is a secret. Use clipboard-to-file commands.**

#### 3c. Write ngrok configuration

Write the ngrok config so it can be started with `ngrok start miko`:

```bash
mkdir -p ~/.config/ngrok
```

Then write `~/.config/ngrok/ngrok.yml` (merge with existing if present):

```yaml
version: 3
agent:
  authtoken: <token>
endpoints:
  - name: miko
    url: <domain>
    upstream:
      url: 3456
```

For the authtoken, use a clipboard-to-file approach:

**macOS:**
```bash
# User copies authtoken, then runs:
NGROK_TOKEN=$(pbpaste) && cat > ~/.config/ngrok/ngrok.yml << EOF
version: 3
agent:
  authtoken: $NGROK_TOKEN
endpoints:
  - name: miko
    url: <domain>
    upstream:
      url: 3456
EOF
```

**Universal fallback:**
```bash
read -s -p "Paste your ngrok authtoken: " NGROK_TOKEN && cat > ~/.config/ngrok/ngrok.yml << EOF
version: 3
agent:
  authtoken: $NGROK_TOKEN
endpoints:
  - name: miko
    url: <domain>
    upstream:
      url: 3456
EOF
echo " ✓ Saved"
```

#### 3d. Write MIKO_BASE_URL

```bash
printf 'MIKO_BASE_URL=https://%s\n' "<domain>" >> ~/.miko/.env
```

Where `<domain>` is the ngrok domain the user provided (e.g., `your-name-here.ngrok-free.app`).

Inform the user:

> To start ngrok, run: `ngrok start miko`
> Run this in a separate terminal before starting Miko.

### Option 2: Cloudflare Tunnel

Ask the user for:
- Their Cloudflare Tunnel token
- Their tunnel hostname (e.g., `miko.yourdomain.com`)

**Token is a secret — use clipboard-to-env:**

**macOS:**
```bash
printf 'CLOUDFLARE_TOKEN=%s\n' "$(pbpaste)" >> ~/.miko/.env
```

**Universal fallback:**
```bash
read -s -p "Paste your Cloudflare token: " val && printf 'CLOUDFLARE_TOKEN=%s\n' "$val" >> ~/.miko/.env && echo " ✓ Saved"
```

Then write the base URL (not a secret — agent can write directly):

```bash
printf 'MIKO_BASE_URL=https://<hostname>\n' >> ~/.miko/.env
```

### Option 3: Own URL

Ask the user for their URL. Validate it starts with `https://`.

```bash
printf 'MIKO_BASE_URL=%s\n' "<url>" >> ~/.miko/.env
```

## Step 4: Write Common Config

Ensure these are present in `~/.miko/.env` (add only if missing):

```bash
grep -q '^MIKO_SERVER_PORT=' ~/.miko/.env 2>/dev/null || printf 'MIKO_SERVER_PORT=3456\n' >> ~/.miko/.env
grep -q '^LINEAR_DIRECT_WEBHOOKS=' ~/.miko/.env 2>/dev/null || printf 'LINEAR_DIRECT_WEBHOOKS=true\n' >> ~/.miko/.env
grep -q '^MIKO_HOST_EXTERNAL=' ~/.miko/.env 2>/dev/null || printf 'MIKO_HOST_EXTERNAL=true\n' >> ~/.miko/.env
```

`LINEAR_DIRECT_WEBHOOKS=true` enables direct Linear webhook signature verification. `MIKO_HOST_EXTERNAL=true` enables direct Slack and GitHub webhook signature verification. Both are required for self-hosted setups where webhooks come directly from the services (not forwarded through CYHOST).

## Completion

> ✓ Webhook endpoint configured: `<MIKO_BASE_URL>`
> ✓ Server port: 3456
> ✓ Direct webhooks: enabled
