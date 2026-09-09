# Zulip

Cyrus can join a Zulip realm as a bot: @mention it in a topic and it replies in
that topic, exactly as it does in a Slack thread.

A Zulip **topic** is the thread unit, so one Cyrus session is bound to one
`channel + topic` pair. Direct messages to the bot get a session of their own.

## What you need

Four values, all from the same bot user:

| Variable | Where it comes from |
| --- | --- |
| `ZULIP_SITE` | Your realm's base URL, e.g. `https://example.zulipchat.com` |
| `ZULIP_BOT_EMAIL` | The bot's Zulip API email address |
| `ZULIP_API_KEY` | **Personal settings → Bots → manage bot → API key** |
| `ZULIP_WEBHOOK_TOKEN` | The `token` value in the bot's downloadable Zulip Botserver config — it is *not* the API key |

Cyrus registers the Zulip endpoint only when all four are set.

## Setup

1. **Create the bot.** In Zulip, go to **Personal settings → Bots → Add a new
   bot** and choose **Outgoing webhook** as the bot type. Creating this bot type
   requires organization administrator permissions.

2. **Point it at Cyrus.** Set the bot's **Endpoint URL** to your Cyrus host plus
   `/zulip-webhook`, e.g.
   `https://cyrus.example.com/zulip-webhook`. Leave the interface as
   **Generic**.

3. **Collect the credentials.** The API key is on the bot's *manage bot* screen.
   The webhook token is only exposed in the bot's downloadable Zulip Botserver
   config file, so download that and copy the `token` value out of it.

4. **Put them in `~/.cyrus/.env`:**

   ```sh
   ZULIP_SITE=https://example.zulipchat.com
   ZULIP_BOT_EMAIL=impala-bot@example.zulipchat.com
   ZULIP_API_KEY=...
   ZULIP_WEBHOOK_TOKEN=...
   ```

5. **Restart Cyrus.** The log line `Zulip event transport registered` confirms
   the endpoint is mounted.

6. **Subscribe the bot** to the channels you want to use it in. This is required
   for private channels, and it is what lets the bot post its replies. Check the
   channel's **Who can post to this channel** setting too — an
   administrators-only channel blocks the bot like any other member.

## How it behaves

**It only hears messages addressed to it.** A Zulip outgoing webhook bot is
notified about @mentions and DMs, and nothing else. There is no equivalent of
Slack's thread following, so Cyrus cannot passively watch a topic.

**It catches up on what it missed.** Because of the above, everything said in a
topic between two mentions would otherwise be invisible. Cyrus records the last
message it had context for, and on the next mention reads the newest 50
messages of the topic and hands the agent the ones posted since. That read is a
single request whose cost does not grow with the topic, so a busy channel is no
more expensive than a quiet one. If more than 50 messages piled up since the
last mention, the agent gets the most recent 50 and is told that older ones are
not shown.

**Resolving a topic does not end the conversation.** Zulip marks a topic
resolved by renaming it with a `\u2714 ` prefix, so Cyrus identifies a session by
the topic's name without that marker. Resolving or unresolving mid-thread keeps
the same session and its catch-up position. Renaming a topic outright, or
moving messages to another topic, still starts a new session.

**Replies do not come back through the webhook.** Zulip's protocol expects the
bot's answer in the HTTP response, which cannot work for a turn that takes
minutes. Cyrus acknowledges the webhook immediately and posts the real reply
through the REST API with the bot's API key. That same key adds the 👀 reaction
on receipt and swaps it for ✅ when the turn completes.

## Configuration

`zulipMcpConfigs` in `~/.cyrus/config.json` takes a list of paths to custom
`.mcp.json` files to load for Zulip sessions only, mirroring `slackMcpConfigs`.
Like all chat sessions, the tool allow-list comes from `slackAllowedTools`
(which governs every chat platform, not just Slack) or the built-in read-only
chat default.

## Security note

Zulip does not sign outgoing webhook requests. The only credential in the
payload is the bot's fixed token, so that is what Cyrus verifies — a
constant-time comparison against `ZULIP_WEBHOOK_TOKEN`. This is weaker than
Slack's request signing: anyone who learns the token can invoke your agent.
Serve the endpoint over TLS, and rotate the bot if the token leaks.
