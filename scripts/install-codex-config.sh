#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
SOURCE_CONFIG="${REPO_ROOT}/config/codex-config.toml"
TARGET_CONFIG="/root/.codex/config.toml"

DRY_RUN=0
UNINSTALL=0

print_usage() {
  cat <<USAGE
Usage: $(basename "$0") [--dry-run] [--uninstall]

Options:
  --dry-run    Validate and print actions without modifying files.
  --uninstall  Restore the most recent backup of /root/.codex/config.toml.
  -h, --help   Show this help text.
USAGE
}

log() {
  printf '[install-codex-config] %s\n' "$*" >&2
}

die() {
  printf '[install-codex-config] ERROR: %s\n' "$*" >&2
  exit 1
}

sha_of() {
  sha256sum "$1" | awk '{print $1}'
}

verify_with_config_show() {
  local output
  if ! output="$(codex --config-show 2>/dev/null)"; then
    return 1
  fi

  [[ "${output}" == *"tool_timeout_sec"* ]] || return 1
  [[ "${output}" == *"startup_timeout_sec"* ]] || return 1
  return 0
}

verify_with_mcp_get() {
  local server output
  for server in linear cyrus-tools cyrus-docs; do
    output="$(codex mcp get "${server}" --json 2>&1 || true)"

    echo "${output}" | grep -q '"name":' || {
      die "codex mcp get ${server} did not return JSON output. Output was: ${output}"
    }

    echo "${output}" | grep -Eq '"tool_timeout_sec":\s*120(\.0)?' || {
      die "tool_timeout_sec=120 not observed for ${server}. Output was: ${output}"
    }

    echo "${output}" | grep -Eq '"startup_timeout_sec":\s*30(\.0)?' || {
      die "startup_timeout_sec=30 not observed for ${server}. Output was: ${output}"
    }
  done
}

verify_installed_config() {
  if verify_with_config_show; then
    log "Verified config via codex --config-show"
    return 0
  fi

  log "codex --config-show unavailable; verifying via codex mcp get --json"
  verify_with_mcp_get
  log "Verified per-MCP timeout values via codex mcp get"
}

restore_latest_backup() {
  local latest_backup
  latest_backup="$(ls -1t "${TARGET_CONFIG}.bak."* 2>/dev/null | head -n 1 || true)"

  if [[ -z "${latest_backup}" ]]; then
    die "No backup found for ${TARGET_CONFIG}."
  fi

  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "[dry-run] would restore ${latest_backup} -> ${TARGET_CONFIG}"
    return 0
  fi

  mkdir -p "$(dirname "${TARGET_CONFIG}")"
  cp -p "${latest_backup}" "${TARGET_CONFIG}"
  log "Restored ${TARGET_CONFIG} from ${latest_backup}"

  verify_installed_config
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --uninstall)
      UNINSTALL=1
      ;;
    -h|--help)
      print_usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
  shift
done

[[ -f "${SOURCE_CONFIG}" ]] || die "Source config not found: ${SOURCE_CONFIG}"

if [[ ${UNINSTALL} -eq 1 ]]; then
  restore_latest_backup
  exit 0
fi

mkdir -p "$(dirname "${TARGET_CONFIG}")"

SOURCE_SHA="$(sha_of "${SOURCE_CONFIG}")"
CURRENT_SHA=""
if [[ -f "${TARGET_CONFIG}" ]]; then
  CURRENT_SHA="$(sha_of "${TARGET_CONFIG}")"
fi

log "Source config SHA256: ${SOURCE_SHA}"
if [[ -n "${CURRENT_SHA}" ]]; then
  log "Existing target SHA256: ${CURRENT_SHA}"
else
  log "Target config does not exist yet."
fi

if [[ -n "${CURRENT_SHA}" && "${CURRENT_SHA}" == "${SOURCE_SHA}" ]]; then
  log "Target config already matches source; no copy required."
  verify_installed_config
  exit 0
fi

if [[ ${DRY_RUN} -eq 1 ]]; then
  if [[ -n "${CURRENT_SHA}" ]]; then
    timestamp="$(date -u +%Y%m%d-%H%M%S)"
    log "[dry-run] would backup ${TARGET_CONFIG} -> ${TARGET_CONFIG}.bak.${timestamp}"
  fi
  log "[dry-run] would copy ${SOURCE_CONFIG} -> ${TARGET_CONFIG}"
  log "[dry-run] would verify via codex mcp get --json fallback"
  exit 0
fi

if [[ -f "${TARGET_CONFIG}" ]]; then
  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  backup_path="${TARGET_CONFIG}.bak.${timestamp}"
  cp -p "${TARGET_CONFIG}" "${backup_path}"
  log "Backup created: ${backup_path}"
fi

cp -p "${SOURCE_CONFIG}" "${TARGET_CONFIG}"
log "Installed ${TARGET_CONFIG}"

verify_installed_config
log "Install complete."
log "Rollback: $(basename "$0") --uninstall"
