#!/usr/bin/env bash
#
# deploy-local.sh — Update the locally-running Cyrus systemd service to the tip
# of a branch (default: main) and restart it.
#
# Invoked by .github/workflows/deploy.yml on a self-hosted runner (push to main)
# so that every merge redeploys the live "troppc" agent. Also runnable by hand
# for a manual redeploy or first-time bootstrap.
#
# Design notes:
#   * Operates on a DEDICATED deploy clone ($CYRUS_DEPLOY_DIR), never your dev
#     working copy — so uncommitted local work is never touched by a hard reset.
#   * The systemd user unit `cyrus.service` is repointed (via an idempotent
#     drop-in) to run this clone's built entrypoint. Repointing + the restart
#     only happen on an actual deploy; a build-only dry run leaves the live
#     service untouched (set CYRUS_DEPLOY_SKIP_RESTART=1).
#
# Env overrides:
#   CYRUS_DEPLOY_DIR          deploy clone location      (default: $HOME/cyrus-deploy)
#   CYRUS_REPO_URL            git remote to clone/fetch  (default: git@github.com:TropicalDog17/cyrus.git)
#   CYRUS_DEPLOY_BRANCH       branch to deploy           (default: main)
#   CYRUS_DEPLOY_SKIP_RESTART if "1", build only; do not repoint/restart service
#   CYRUS_NODE_BIN            node binary for the service ExecStart
#                             (default: $HOME/.nvm/versions/node/v22.23.0/bin/node)

set -euo pipefail

DEPLOY_DIR="${CYRUS_DEPLOY_DIR:-$HOME/cyrus-deploy}"
REPO_URL="${CYRUS_REPO_URL:-git@github.com:TropicalDog17/cyrus.git}"
BRANCH="${CYRUS_DEPLOY_BRANCH:-main}"
SERVICE="cyrus.service"
NODE_BIN="${CYRUS_NODE_BIN:-$HOME/.nvm/versions/node/v22.23.0/bin/node}"
ENTRYPOINT="$DEPLOY_DIR/apps/cli/dist/src/app.js"

# Make node/pnpm resolvable in a headless (runner/systemd) PATH, and let
# `systemctl --user` reach the user bus from a non-login context. Lingering
# must be enabled for the user (`loginctl enable-linger $USER`) so the user
# manager and $XDG_RUNTIME_DIR persist without an active login session.
export PATH="$(dirname "$NODE_BIN"):$HOME/.local/share/pnpm:$PATH"
export XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
export DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$XDG_RUNTIME_DIR/bus}"

log() { printf '\n\033[1;34m[deploy]\033[0m %s\n' "$*"; }

# 1. Sync the deploy clone to the branch tip.
if [ ! -d "$DEPLOY_DIR/.git" ]; then
	log "Cloning $REPO_URL -> $DEPLOY_DIR (branch $BRANCH)"
	git clone --branch "$BRANCH" "$REPO_URL" "$DEPLOY_DIR"
fi
cd "$DEPLOY_DIR"
log "Fetching origin/$BRANCH"
git fetch --prune origin "$BRANCH"
git reset --hard "origin/$BRANCH"
COMMIT="$(git rev-parse HEAD)"
SHORT="$(git rev-parse --short HEAD)"
# Product semver (the published `cyrus-ai` package). Threaded to the running
# service as CYRUS_VERSION so Langfuse traces are tagged `<semver>+<commit>`
# and can be compared across deploys. Falls back to "unknown" if unreadable.
VERSION="$(node -p "require('$DEPLOY_DIR/apps/cli/package.json').version" 2>/dev/null || echo unknown)"

# 2. Install + build the whole monorepo (apps/cli is built recursively).
log "pnpm install --frozen-lockfile"
pnpm install --frozen-lockfile
log "pnpm build"
pnpm build

if [ ! -f "$ENTRYPOINT" ]; then
	echo "[deploy] ERROR: expected entrypoint not found after build: $ENTRYPOINT" >&2
	exit 1
fi

# 3. Stamp the build (mirrors the existing BUILD_INFO.txt convention).
cat >"$DEPLOY_DIR/BUILD_INFO.txt" <<EOF
cyrus deploy build
commit: $COMMIT
branch: $BRANCH
built: $(date -u +%Y-%m-%dT%H:%M:%SZ)
host: $(hostname)
EOF

if [ "${CYRUS_DEPLOY_SKIP_RESTART:-0}" = "1" ]; then
	log "Built commit $SHORT (skip-restart set) — live service left untouched"
	exit 0
fi

# 4. Ensure the live service points at this clone's entrypoint, then restart.
DROPIN_DIR="$HOME/.config/systemd/user/$SERVICE.d"
DROPIN="$DROPIN_DIR/deploy.conf"
mkdir -p "$DROPIN_DIR"
cat >"$DROPIN" <<EOF
# Managed by scripts/deploy-local.sh — points cyrus.service at the deploy clone.
[Service]
ExecStart=
ExecStart=$NODE_BIN $ENTRYPOINT
# Build identity for Langfuse trace versioning (<semver>+<commit>).
Environment=CYRUS_VERSION=$VERSION
Environment=CYRUS_BUILD_COMMIT=$SHORT
EOF

log "Restarting $SERVICE (version $VERSION+$SHORT)"
systemctl --user daemon-reload
systemctl --user restart "$SERVICE"
sleep 2
if systemctl --user is-active --quiet "$SERVICE"; then
	log "Deployed $SHORT — $SERVICE is active"
else
	echo "[deploy] ERROR: $SERVICE is not active after restart" >&2
	systemctl --user status "$SERVICE" --no-pager -l | tail -30 >&2 || true
	exit 1
fi
