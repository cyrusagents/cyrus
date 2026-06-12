---
name: cyrus-ecosystem-context
description: Use when a Cyrus session needs source-defensible context for the Cyrus/Ceedar ecosystem before choosing an investigation path across repos, services, integrations, runtimes, or internal operations.
---

# Cyrus Ecosystem Context

Use this skill before planning work that may touch more than one Cyrus/Ceedar repo, service, runtime, integration, deploy surface, billing path, or internal operations workflow. Keep answers grounded in repository/docs/config evidence; narrow or remove any claim you cannot defend from the checked-out sources.

## How To Use

1. Identify the requested change or question.
2. Read the entries below and note adjacent systems that may be involved.
3. Inspect the listed source anchors before making implementation claims.
4. If evidence conflicts with this skill, trust the current source and update this skill.

## Relationship Cues

- `cyrus-hosted` <-> `cyrus`: inspect both when changing generated config, skills, allowed tools, MCP config, model/provider defaults, repository routing, webhook forwarding, runtime health, or any payload sent to a cloud droplet or self-host tunnel.
- Cloud runtime supply chain: inspect `cyrus-hosted`, `cyrus-images`, `cyrus-update-server`, `droplet-config`, DigitalOcean Spaces, nginx, and systemd when changing managed droplets, package versions, bootstrap behavior, privileged updates, or cloud runtime startup.
- Linear/Sentry triage: inspect `cyrus-hosted` error capture plus the Linear/Cyrus runtime surface when production errors, failure modes, agent sessions, or customer-visible agent behavior are involved.
- GitHub/GitLab PR/MR flows: inspect `cyrus` event transports/runners and `cyrus-hosted` OAuth/App install, token, repo, webhook, and routing code when changing code-hosting behavior.
- Stripe/Supabase billing state: inspect Stripe webhook/actions, Supabase migrations/types/repositories, plan limits, runtime provisioning, and any droplet resize/deletion side effects.
- Vercel/AppMinter previews: inspect Vercel workflows/logs and AppMinter when preview credentials, deterministic preview environments, Supabase projects, or deploy-preview failures are involved.

## Entries

| Entry | Ground-truth role | Investigation cues |
| --- | --- | --- |
| `cyrus` | `cyrus-ai` npm runtime and local/cloud agent process. It monitors Linear/GitHub/GitLab/Slack inputs, creates isolated git worktrees, runs Claude/Codex/Cursor/Gemini sessions, and replies to the source surface. | Start here for runner behavior, worktrees, prompt assembly, event transports, CLI/runtime config, session lifecycle, PR/MR replies, and built-in skills. |
| `cyrus-hosted` | Vercel-hosted Next.js/Supabase control plane for teams, integrations, billing, repositories, routing, MCP/env/skill config, webhook forwarding, cloud provisioning, and runtime updates. | Start here for dashboard behavior, onboarding, OAuth/App installs, Stripe state, Supabase schema, config generation, webhook ingress, droplet/tunnel updates, and production Vercel/Sentry issues. |
| `cyrus-images` | Packer image repo for managed DigitalOcean base images consumed by `cyrus-hosted`. The image setup installs system packages, `cyrus-ai`, `cyrus-update-server`, nginx, systemd units/timers, GitHub token refresh, and bootstrap scripts. | Inspect with `cyrus-hosted` provisioning and `cyrus-update-server` when changing managed droplet startup, baked package versions, systemd services, nginx routing, or base image capabilities. |
| `cyrus-update-server` | Root-running Go management daemon on cloud droplets. It serves Bearer-authenticated `/api/update/*` endpoints for privileged updates such as GitHub credentials/App details, env vars, worktrees, Codex auth, skills, and apt/npm packages; it also applies package versions from a manifest. | Inspect with `cyrus-hosted` update callers, nginx route forwarding, `cyrus-images` systemd setup, and `droplet-config` when changing privileged machine operations or package update behavior. |
| `droplet-config` | Managed-droplet package manifest source that pins package manager/version data and publishes `manifest.json` for droplet package updates. | Inspect when changing cloud-installed Codex/Cyrus-related packages, manifest publishing, or update cadence. Confirm current repo availability because it may live outside the main Cyrus worktree set. |
| Vercel | Hosting, deploy, preview, and immediate log surface for `cyrus-hosted`, `cyrus-website`, and AppMinter-created previews. | Inspect for Next.js route/runtime limits, deploy-preview failures, environment variables, serverless background work, and production logs. |
| Supabase | Persistent state and realtime backbone for `cyrus-hosted`: auth, teams, integrations, billing sync, repositories, sessions, provisioning state, packages, broadcasts, and dashboard data. | Inspect migrations, generated types, repository helpers, RLS, realtime/session tables, and local Supabase setup before changing data contracts. |
| `appminter` | Standalone web+CLI environment minter for deterministic app development resources: provider credentials, environment variables, CLI tokens, evidence capture, one-way credential ejection, and optional Vercel env sync. | Inspect for preview environment provisioning, Vercel/Supabase credential generation, preview init/deploy workflows, and deterministic resource reuse by branch/repo/user. |
| Slack | Conversational surface for internal coordination and agent use. `cyrus-hosted` installs/routes signed Slack events; `cyrus` turns mentions/thread replies into contextual sessions. | Inspect hosted Slack OAuth/webhook routes, signing verification, team config pushes, and runtime Slack event transport/thread context together. |
| Linear | Product, project-management, dev, and triage surface. Customer issues can trigger `cyrus`; agent activity streams back; internal Cyrus/Ceedar work and failure modes are managed there. | Inspect both hosted Linear OAuth/webhooks/team selection and runtime Linear transport/activity sinks for issue assignment, updates, comments, labels, and session status. |
| GitHub | Code-hosting and PR surface. `cyrus-hosted` manages OAuth/App installs, repo access, webhooks, tokens, and PR tracking; `cyrus` handles GitHub events, PR mentions/review triggers, and replies. | Inspect hosted GitHub OAuth/App/repo/webhook actions plus runtime GitHub event transport and git/PR tooling. |
| GitLab | Code-hosting/MR surface with runtime support for GitLab MR notes, worktrees, replies, and `glab`-based workflows. | Inspect `cyrus` GitLab docs/event transport and setup skill first; inspect `cyrus-hosted` only for any dashboard integration work that is explicitly present. |
| GitHub Actions | Repo automation layer for CI, releases, preview deployments, changelogs, update-server binaries, image/package manifests, and AppMinter preview workflows. | Inspect workflow files when changes affect packaging, deploy previews, release artifacts, or CI-only behavior. |
| Sentry | Durable error/failure visibility and triage source. `cyrus-hosted` captures production errors, and agent failure modes flow through hosted infrastructure into internal Linear tracking. | Inspect Sentry instrumentation/capture paths, hosted logs, and Linear failure-mode records when diagnosing production failures or noisy recurring agent issues. |
| Stripe | Billing source of truth for checkout, trials, subscriptions, plan upgrades, valid-customer status, and plan/limit sync into `cyrus-hosted`. | Inspect Stripe actions/webhooks, Supabase team billing fields, plan limits, and droplet resize/deletion/provisioning side effects together. |
| Mixpanel | Product analytics and experiment surface for onboarding, activation, usage, feature flags, retention analysis, and internal-user filtering. | Inspect analytics package/helpers and feature-flag code when changing onboarding funnels, experiments, event names, or usage reporting. |
| Vanta | Compliance/GRC surface for SOC/security evidence. Managed DigitalOcean droplets are tagged for user-data scoping. | Inspect droplet provisioning tags and security/compliance docs before changing managed infrastructure tagging or evidence assumptions. |
| DigitalOcean | Cloud infrastructure substrate for managed Cyrus runtime. `cyrus-hosted` provisions tagged droplets from `cyrus-images`, stores update artifacts/manifests in Spaces, and runs `cyrus` plus root `cyrus-update-server` on droplets. | Inspect provisioning service, image IDs, Spaces artifact URLs, firewall/DNS/tags, droplet API key handling, and cloud runtime health before changing managed runtime behavior. |
| `documentation` | Public customer/operator docs repo covering setup, runtimes, integrations, tools, routing, providers, security, and troubleshooting. | Inspect when behavior changes affect customer setup, configuration, security posture, integration docs, or troubleshooting guidance. |
| `cyrus-website` | Public Next.js marketing/acquisition site for Cyrus, including product pages, media, testimonials, pricing CTAs, lead capture, and changelog/content. | Inspect for public claims, pricing CTAs, acquisition flows, embedded demos/media, and any website-facing version of product messaging. |

## Source Anchors

- `cyrus/README.md`, `cyrus/CLAUDE.md`, `cyrus/packages/edge-worker/src`, `cyrus/packages/*-event-transport`, `cyrus/packages/*-runner`, `cyrus/docs/GIT_GITHUB.md`, `cyrus/docs/GIT_GITLAB.md`
- `cyrus-hosted/README.md`, `cyrus-hosted/CLAUDE.md`, `cyrus-hosted/apps/api/supabase/migrations`, `cyrus-hosted/apps/app/src/lib/cyrus-config`, `cyrus-hosted/apps/app/src/lib/infrastructure-update`, `cyrus-hosted/apps/app/src/lib/droplet-provisioning`, `cyrus-hosted/apps/app/src/app/api/*/webhook`
- `cyrus-images/packer/cyrus-base.pkr.hcl`, `cyrus-images/scripts/base-setup.sh`, `cyrus-images/.github/workflows`
- `cyrus-update-server/README.md`, `cyrus-update-server/CLAUDE.md`, `cyrus-update-server/main.go`, `cyrus-update-server/handlers`, `cyrus-update-server/updater`, `cyrus-update-server/.github/workflows`
- `appminter/README.md`, `appminter/packages/core`, `appminter/packages/cli`, `appminter/apps/web`, `appminter/.github/workflows`
- `documentation/README.md`, `documentation/SUMMARY.md`
- `cyrus-website/README.md`, `cyrus-website/app`, `cyrus-website/public/changelog.md`
- `droplet-config/manifest.json` when that repo is checked out or available remotely.
