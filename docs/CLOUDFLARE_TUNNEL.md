# Cloudflare Tunnel Setup (Optional)

This guide covers setting up a Cloudflare Tunnel to expose your local Cyrus instance to the public internet for receiving Linear webhooks.

> **Note:** This is one option for exposing your Cyrus instance. Other options include ngrok, a reverse proxy with a public domain, or a server with a public IP. See [Self-Hosting Guide](./SELF_HOSTING.md) for alternatives.

---

## Prerequisites

- A Cloudflare account (free tier works)
- Your own domain added to Cloudflare (required for permanent tunnels)

> **Note:** Free `trycloudflare.com` URLs are only for temporary quick tunnels and change on restart.

---

## Step 1: Create Cloudflare Account (if needed)

1. Go to https://cloudflare.com
2. Click **Sign up**
3. Create free account
4. Verify email

---

## Step 2: Create Cloudflare Tunnel

1. **Log in to Cloudflare Dashboard:**
   - Go to https://one.dash.cloudflare.com/

2. **Navigate to Tunnels:**
   - In left sidebar: Click **Access**
   - Then click **Tunnels**

3. **Create New Tunnel:**
   - Click **Create a tunnel**
   - Name it: `cyrus-local`
   - Click **Save tunnel**

4. **Copy Tunnel Token:**
   - You'll see a long token starting with `eyJ...`
   - Click **Copy** or select and copy the entire token
   - **SAVE THIS** - you'll need it for environment variables

5. **Configure Public Hostname:**
   - Click **Next** or go to tunnel settings
   - Click **Public Hostname** tab
   - Click **Add a public hostname**

   Fill in:
   - **Subdomain:** `cyrus` (or whatever you want)
   - **Domain:** Select your domain from dropdown
   - **Path:** Leave empty
   - **Type:** HTTP
   - **URL:** `localhost:3456`

6. **Save Hostname:**
   - Click **Save hostname**
   - **Copy the full public URL** (e.g., `https://cyrus.yourdomain.com`)
   - **SAVE THIS** - this is your `CYRUS_BASE_URL`

---

## Step 3: Configure Environment Variables

Set these environment variables for Cloudflare Tunnel integration:

```bash
export CYRUS_BASE_URL=https://cyrus.yourdomain.com
export CYRUS_SERVER_PORT=3456
export CLOUDFLARE_TOKEN=eyJhIjoiXXXXXXX...your_token_here...XXXXXXX
```

Cyrus will automatically start the Cloudflare tunnel in the background when it detects the `CLOUDFLARE_TOKEN` environment variable.

`cloudflared` reaches the origin over loopback, so if you have `CYRUS_HOST_EXTERNAL=true` set, add
`export CYRUS_SERVER_HOST=127.0.0.1` to keep the port off your public interfaces. See
[Self-Hosting](./SELF_HOSTING.md#43-cyrus_server_host) for what the override does and does not change.

---

## Troubleshooting

### Tunnel Connection Timeout (0/4 connections)

If you see an error like "Timeout waiting for Cloudflare tunnel (0/4 connections)", this indicates that the `cloudflared` binary cannot establish connections to Cloudflare's edge network. This is almost always a network/firewall configuration issue.

**Common Causes:**

1. **Corporate Firewall**: Your organization's firewall may be blocking `cloudflared` connections
   - Contact your IT department about allowing Cloudflare tunnel connections
   - See [Cloudflare's connectivity prechecks](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/troubleshoot-tunnels/connectivity-prechecks/)

2. **VPN Interference**: Active VPNs may prevent tunnel establishment
   - Try temporarily disabling your VPN
   - Some VPNs have split-tunneling options that may help

3. **Network Proxy**: If you're behind a proxy, `cloudflared` needs configuration
   - Set environment variables: `HTTP_PROXY`, `HTTPS_PROXY`
   - See [Cloudflare's proxy documentation](https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/agentless/dns/locations/dns-over-https/#proxy-support)

4. **Invalid Token**: Ensure your token hasn't expired
   - Check token in Cloudflare dashboard: https://one.dash.cloudflare.com/
   - Regenerate token if needed

**Alternative Solutions:**

If you cannot resolve the connectivity issue, consider these alternatives:
- Use [ngrok](https://ngrok.com/) instead of Cloudflare tunnel
- Set up a reverse proxy on a server with a public IP
- Use a cloud VM with Docker to host Cyrus
- See [Self-Hosting Guide](./SELF_HOSTING.md) for more options

### Tunnel Not Starting

- Verify `CLOUDFLARE_TOKEN` is set correctly
- Check Cyrus logs for tunnel-related errors
- Ensure the token hasn't expired in Cloudflare dashboard

### Webhooks Not Received

- Verify the public hostname is configured correctly in Cloudflare
- Check that `CYRUS_BASE_URL` matches your Cloudflare hostname exactly
- Ensure Linear webhook URL uses the same base URL

---

## Alternative: Quick Tunnel (Development Only)

For quick testing without a domain, you can use Cloudflare's quick tunnel feature, but note that the URL changes on each restart:

```bash
# This is not recommended for production use
cloudflared tunnel --url http://localhost:3456
```

For production self-hosting, use a permanent tunnel with your own domain.
