# CYPACK-1611: GitHub webhook source IP admission

Date: 2026-11-01
Tested code: `8b0cb42b4f9faab5afeee0f7beb4f788fb52a9d8` (same source and tests as the working tree used for this drive).
Test repository: `/tmp/cypack-1611-f1-repo`.

## Scenario

Exercise the EdgeWorker's real `/github-webhook` route in signature mode with
the three IPv4 ranges from [GitHub's October 29 announcement](https://github.blog/changelog/2026-10-29-webhook-ip-ranges-added-to-the-meta-api/).
Assert that valid signed deliveries from the new ranges pass, neighboring IPs
remain blocked, and allowed IPs still require a valid signature.

## Setup and execution

```sh
pnpm build
apps/f1/f1 init-test-repo --path /tmp/cypack-1611-f1-repo
env -u CLOUDFLARE_TOKEN -u CYRUS_API_KEY -u CYRUS_SANDBOX -u CYRUS_REPO_PATH_2 \
  CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/cypack-1611-f1-repo \
  CYRUS_HOST_EXTERNAL=true GITHUB_WEBHOOK_SECRET=cypack-1611-test-secret \
  bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
```

The server registered the GitHub transport in signature mode and passed health
checks. Requests used the `issueCommentPayload` fixture from
`packages/github-event-transport/test/fixtures.ts`, with its comment body replaced
by `Webhook admission validation without an agent mention`. This exercises
accepted event delivery without starting an agent or posting to GitHub.

For each source address below, POST the JSON body to `/github-webhook` with:

- `content-type: application/json`
- `x-github-event: issue_comment`
- A unique `x-github-delivery` value (`cypack-1611-1` through `cypack-1611-20`)
- `x-forwarded-for` set to the simulated source IP
- `x-hub-signature-256` set to `sha256=` followed by the hex HMAC-SHA256 of the exact JSON body using the test secret

## Results

| Source IPs | Expected and observed |
| --- | --- |
| `9.234.98.160`, `9.234.98.175`, `9.234.98.176`, `9.234.98.191`, `9.234.106.48`, `9.234.106.63` | 200, exactly `{"success":true}` |
| `192.30.253.1` (existing range) | 200, exactly `{"success":true}` |
| All seven accepted addresses with `::ffff:` prefixes | 200, exactly `{"success":true}` |
| `9.234.98.159`, `9.234.98.192`, `9.234.106.47`, `9.234.106.64`, `8.8.8.8` | 403 |
| `9.234.98.160` with `sha256=invalid` | 401 |

All 20 HTTP assertions passed. The server logged receipt of all 14 accepted
`issue_comment` deliveries and rejection of the five unauthorized IPs.
No unhandled errors occurred. SIGINT stopped the server gracefully; port 3600
was no longer listening afterward.

Additional checks: all 75 validator tests and 117 GitHub event transport tests
passed, along with repository build and typecheck. The six new allowed-boundary
tests failed before the allowlist change and passed afterward.

## Limits

Source addresses were simulated through forwarded headers on the local F1
server, not real GitHub network deliveries. This drive validates webhook
admission and signature enforcement; it does not exercise agent sessions,
activity rendering, production deployment, or native IPv6 support.
