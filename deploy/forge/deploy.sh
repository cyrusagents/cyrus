#!/usr/bin/env bash
#
# nyrus: deploy script for a Laravel Forge server.
#
# In Forge, set the site's deploy script to:
#
#     cd /home/forge/nyrus.on-forge.com
#     git pull origin $FORGE_SITE_BRANCH
#     bash deploy/forge/deploy.sh
#
# Forge pulls the code; this script does not. That way a changed deploy.sh is
# already on disk before bash starts running it (bash reads a script while it
# runs, so pulling a new version of it mid-run could break the deploy).
#
# Steps:
#   1. Show which commit is being deployed
#   2. Install dependencies (pnpm through corepack, version from package.json)
#   3. Build all packages and smoke-test the CLI
#   4. Wait until nyrus is idle (GET /status), so running agent sessions finish
#   5. Restart: SIGTERM to the running process; the Forge daemon (Supervisor)
#      starts it again with the new build
#   6. Check that the new process answers on /version
#
# Settings (environment variables, all optional):
#   NYRUS_PORT            Port nyrus listens on                 (default: CYRUS_SERVER_PORT or 3456)
#   NYRUS_IDLE_TIMEOUT    Seconds to wait for idle              (default: 1800)
#   NYRUS_IDLE_POLL       Seconds between /status checks        (default: 15)
#   NYRUS_FORCE_RESTART   1 = restart even if still busy        (default: 0)
#   NYRUS_START_TIMEOUT   Seconds to wait for the new process   (default: 90)
#   NYRUS_SKIP_BUILD      1 = only restart (skip install and build) (default: 0)
#   NYRUS_DAEMON_GRACE    Seconds to wait for a first start when nyrus was not running (default: 15)
#
# The Forge daemon must start nyrus with the absolute path of the entry file,
# e.g. `node /home/forge/nyrus.on-forge.com/apps/cli/dist/src/app.js`, so this
# script finds exactly this process. See deploy/forge/README.md.

set -euo pipefail

SITE_PATH="${FORGE_SITE_PATH:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
PORT="${NYRUS_PORT:-${CYRUS_SERVER_PORT:-3456}}"
IDLE_TIMEOUT="${NYRUS_IDLE_TIMEOUT:-1800}"
IDLE_POLL="${NYRUS_IDLE_POLL:-15}"
FORCE_RESTART="${NYRUS_FORCE_RESTART:-0}"
START_TIMEOUT="${NYRUS_START_TIMEOUT:-90}"
SKIP_BUILD="${NYRUS_SKIP_BUILD:-0}"

ENTRY="$SITE_PATH/apps/cli/dist/src/app.js"
BASE_URL="http://127.0.0.1:$PORT"

log() { printf '[nyrus-deploy] %s\n' "$*"; }
fail() { printf '[nyrus-deploy] ERROR: %s\n' "$*" >&2; exit 1; }

# Prints "idle", "busy" or "down" (process not reachable).
nyrus_status() {
	local body
	if ! body="$(curl -fsS --max-time 5 "$BASE_URL/status" 2>/dev/null)"; then
		echo "down"
		return
	fi
	case "$body" in
		*'"idle"'*) echo "idle" ;;
		*'"busy"'*) echo "busy" ;;
		*) echo "busy" ;; # unknown answer: be careful, do not restart blindly
	esac
}

# PIDs of the nyrus process started from this site's build.
nyrus_pids() {
	pgrep -f -- "node .*$ENTRY" || true
}

# Make every `pnpm` call use the version from package.json ("packageManager"),
# including the nested ones in package scripts (`pnpm build` runs `pnpm -r ...`).
# Without this, a globally installed pnpm of another major version is picked up
# for the nested calls and refuses to run. A small shim directory in front of
# PATH forwards `pnpm` to that exact version through corepack (or npx).
pin_pnpm() {
	local version shim_dir
	version="$(node -p "((require('./package.json').packageManager || '').match(/^pnpm@([^+]+)/) || [])[1] || ''")"
	[ -n "$version" ] || fail "package.json has no \"packageManager\": \"pnpm@x.y.z\" field"

	shim_dir="$(mktemp -d)"
	# shellcheck disable=SC2064
	trap "rm -rf '$shim_dir'" EXIT
	if command -v corepack >/dev/null 2>&1; then
		printf '#!/usr/bin/env bash\nexec corepack pnpm@%s "$@"\n' "$version" > "$shim_dir/pnpm"
	elif command -v npx >/dev/null 2>&1; then
		printf '#!/usr/bin/env bash\nexec npx --yes pnpm@%s "$@"\n' "$version" > "$shim_dir/pnpm"
	else
		fail "Neither corepack nor npx found. Node.js ships both; install Node first."
	fi
	chmod +x "$shim_dir/pnpm"
	export PATH="$shim_dir:$PATH"

	local actual
	actual="$(pnpm --version)" || fail "Could not run pnpm $version"
	[ "$actual" = "$version" ] || fail "pnpm is $actual, expected $version"
	log "pnpm $actual (from package.json)"
}

cd "$SITE_PATH"
log "Site: $SITE_PATH (Port $PORT)"

# --- 1. Code (pulled by Forge before this script runs) ---------------------
command -v node >/dev/null 2>&1 || fail "node not found"
command -v curl >/dev/null 2>&1 || fail "curl not found"
log "Node $(node --version)"
if git rev-parse --git-dir >/dev/null 2>&1; then
	log "Deploying $(git rev-parse --abbrev-ref HEAD)@$(git rev-parse --short HEAD): $(git log -1 --pretty=%s)"
fi

if [ "$SKIP_BUILD" = "1" ]; then
	log "NYRUS_SKIP_BUILD=1: skipping install and build"
else
	# --- 2. Dependencies ---------------------------------------------------
	export CI=true          # non-interactive pnpm
	export HUSKY=0          # no git hooks on the server
	export COREPACK_ENABLE_DOWNLOAD_PROMPT=0
	pin_pnpm

	log "Installing dependencies ..."
	pnpm install --frozen-lockfile

	# --- 3. Build ----------------------------------------------------------
	log "Building ..."
	pnpm build
fi

[ -f "$ENTRY" ] || fail "$ENTRY is missing (build failed or not built yet)"
NEW_VERSION="$(node "$ENTRY" --version)" || fail "Smoke test failed: node $ENTRY --version"
log "Build OK (CLI version $NEW_VERSION)"

# --- 4. Wait until idle ----------------------------------------------------
waited=0
status="$(nyrus_status)"
while [ "$status" = "busy" ]; do
	if [ "$waited" -ge "$IDLE_TIMEOUT" ]; then
		if [ "$FORCE_RESTART" = "1" ]; then
			log "Still busy after ${IDLE_TIMEOUT}s; restarting anyway (NYRUS_FORCE_RESTART=1)"
			break
		fi
		fail "nyrus is still busy after ${IDLE_TIMEOUT}s. The new build is in place but not running yet. Deploy again later, or set NYRUS_FORCE_RESTART=1 to stop running sessions."
	fi
	log "nyrus is busy (agent sessions running), waiting ${IDLE_POLL}s ... (${waited}/${IDLE_TIMEOUT}s)"
	sleep "$IDLE_POLL"
	waited=$((waited + IDLE_POLL))
	status="$(nyrus_status)"
done

# --- 5. Restart -------------------------------------------------------------
pids="$(nyrus_pids)"
if [ -z "$pids" ]; then
	log "No running nyrus process found for $ENTRY."
	log "If the Forge daemon is set up, Supervisor starts it on its own; otherwise create it (see deploy/forge/README.md)."
else
	log "Stopping nyrus (PID $(echo "$pids" | paste -sd ' ' -)) with SIGTERM; Supervisor starts the new build ..."
	# shellcheck disable=SC2086
	kill -TERM $pids
	for _ in $(seq 1 30); do
		still=""
		for pid in $pids; do
			if kill -0 "$pid" 2>/dev/null; then still="$still $pid"; fi
		done
		[ -z "$still" ] && break
		sleep 1
	done
	if [ -n "${still:-}" ]; then
		log "Process did not stop within 30s, sending SIGKILL to$still"
		# shellcheck disable=SC2086
		kill -KILL $still 2>/dev/null || true
	fi
fi

# --- 6. Check ---------------------------------------------------------------
# If nyrus wasn't running before and no process shows up within DAEMON_GRACE
# seconds, there is no Forge daemon yet (first deploy): the build is ready, so
# the deploy succeeds with a warning. If a process was running or shows up,
# the new one must answer, or the deploy fails.
DAEMON_GRACE="${NYRUS_DAEMON_GRACE:-15}"
log "Waiting for the new process on $BASE_URL ..."
seen_process=""
for i in $(seq 1 "$START_TIMEOUT"); do
	if version_json="$(curl -fsS --max-time 3 "$BASE_URL/version" 2>/dev/null)"; then
		new_pids="$(nyrus_pids | paste -sd ' ' -)"
		log "nyrus is running (PID ${new_pids:-?}): $version_json"
		log "Deploy finished."
		exit 0
	fi
	[ -n "$(nyrus_pids)" ] && seen_process=1
	if [ -z "$pids" ] && [ -z "$seen_process" ] && [ "$i" -ge "$DAEMON_GRACE" ]; then
		log "WARNING: nyrus is not running and nothing started it within ${DAEMON_GRACE}s."
		log "The build is ready. Create the Forge daemon (deploy/forge/README.md, section 5); it starts this build."
		log "If the daemon exists, check its log in Forge: it may fail on start (e.g. missing ~/.cyrus/.env)."
		log "Deploy finished (without a running nyrus)."
		exit 0
	fi
	sleep 1
done

fail "nyrus did not answer on $BASE_URL/version within ${START_TIMEOUT}s. Check the daemon log in Forge."
