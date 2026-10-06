# Custom-port managed tunnel diagnostic

Run: `/usr/local/bin/node apps/f1/tunnel-routing-drive.mjs` after `pnpm build`.
Node22.17.1 controlled run passed on2026-09-29. Evidence:
`/tmp/cyrus-tunnel-routing-f1-2CbvD9/summary.json`.

The drive uses production CloudflareTunnelClient, the installed cloudflared
ConfigHandler, AutomationRuntime and registered HTTP capability routes. Only the
cloudflared process/managed-config source is controlled. Two real loopback HTTP
servers represent unrelated and feature runtimes with distinct credentials.
No binary download, actual Cloudflare account mutation, model or provider call.

Assertions passed:

- Four connector connections leave origin routing unverified.
- A received origin targeting the unrelated listener reports mismatch, and that
  listener rejects the feature credential401 while feature-local health is200.
- Correcting the fixture origin matches the expected port; its authenticated
  capability response identifies the feature workspace.
- Model readiness remains unavailable despite matching routing.
- The unrelated runtime still responds to its own credential, logs contain no
  fixture credentials, and client shutdown stops its connector and clears status.

This catches the misleading readiness path observed when a local preview uses
50967 but managed ingress still targets3456. It does not reconcile or validate
the live feature tunnel. Hosted/coordinator must independently verify the selected
feature tunnel and authenticated runtime identity. Config delivery, contained
Codex, session persistence and live Linear acceptance remain separate gates.
