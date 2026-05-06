#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
PATCH_FILE="${REPO_ROOT}/patches/cyrus-edge-worker-promptbuilder-no-linear-writes.patch"

EXPECTED_PRE_SHA="7fcb39024a4d81d09d5ae1d22c990e6297e57fcbd5b21894f0ac2e38221a8cb6"
EXPECTED_POST_SHA="043ee6198bd4d82c3224d5fb6a2eb79d44c551b1e32d407e95b560eb1a3ad4da"

DRY_RUN=0
UNINSTALL=0

print_usage() {
  cat <<USAGE
Usage: $(basename "$0") [--dry-run] [--uninstall]

Tier A prompt fix for codex completion gap (BRI-1518). Injects a
<linear_write_constraints> block into cyrus-edge-worker's PromptBuilder so
runners are told NOT to call mcp__linear__save_issue / save_comment. Codex
hangs indefinitely on those write mutations (BRI-1490 diagnosis); this patch
keeps the watchdog (BRI-1439) as a safety net but lets sessions complete
cleanly without tripping it.

Options:
  --dry-run    Validate and print actions without modifying files or restarting pm2.
  --uninstall  Restore the most recent backup and restart pm2.
  -h, --help   Show this help text.
USAGE
}

log() {
  printf '[install-edge-worker-prompt-patch] %s\n' "$*" >&2
}

die() {
  printf '[install-edge-worker-prompt-patch] ERROR: %s\n' "$*" >&2
  exit 1
}

sha_of() {
  sha256sum "$1" | awk '{print $1}'
}

find_target_file() {
  local npm_root
  npm_root="$(npm root -g)"
  local candidate="${npm_root}/cyrus-ai/node_modules/cyrus-edge-worker/dist/PromptBuilder.js"

  log "npm root -g resolved to: ${npm_root}"

  if [[ -f "${candidate}" ]]; then
    printf '%s\n' "${candidate}"
    return 0
  fi

  local discovered
  discovered="$(find /usr/lib/node_modules /usr/local/lib/node_modules \
    -path '*/cyrus-ai/node_modules/cyrus-edge-worker/dist/PromptBuilder.js' \
    -type f 2>/dev/null | head -n 1 || true)"

  if [[ -n "${discovered}" ]]; then
    log "Falling back to discovered install path: ${discovered}"
    printf '%s\n' "${discovered}"
    return 0
  fi

  return 1
}

restart_pm2() {
  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "[dry-run] would run: pm2 restart cyrus-agent"
    return 0
  fi

  pm2 restart cyrus-agent
}

restore_latest_backup() {
  local target_file="$1"
  local latest_backup

  latest_backup="$(ls -1t "${target_file}.bak."* 2>/dev/null | head -n 1 || true)"
  if [[ -z "${latest_backup}" ]]; then
    die "No backup found next to ${target_file}."
  fi

  local backup_sha
  backup_sha="$(sha_of "${latest_backup}")"
  log "Latest backup: ${latest_backup}"
  log "Latest backup SHA256: ${backup_sha}"

  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "[dry-run] would restore ${latest_backup} -> ${target_file}"
    log "[dry-run] would verify restored SHA equals ${EXPECTED_PRE_SHA}"
    return 0
  fi

  cp -p "${latest_backup}" "${target_file}"

  local restored_sha
  restored_sha="$(sha_of "${target_file}")"
  if [[ "${restored_sha}" != "${EXPECTED_PRE_SHA}" ]]; then
    die "Restored SHA mismatch (${restored_sha}); expected ${EXPECTED_PRE_SHA}."
  fi

  restart_pm2
  log "Uninstall complete. PromptBuilder restored to pre-patch SHA ${EXPECTED_PRE_SHA}."
}

apply_patch_safely() {
  local target_file="$1"
  local timestamp backup_file temp_dir patched_sha

  timestamp="$(date -u +%Y%m%d-%H%M%S)"
  backup_file="${target_file}.bak.${timestamp}"

  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "[dry-run] would create backup: ${backup_file}"
    log "[dry-run] would apply patch: ${PATCH_FILE}"
    log "[dry-run] would verify post-patch SHA: ${EXPECTED_POST_SHA}"
    return 0
  fi

  cp -p "${target_file}" "${backup_file}"
  log "Backup created: ${backup_file}"

  temp_dir="$(mktemp -d)"

  cp -p "${target_file}" "${temp_dir}/PromptBuilder.js"
  (cd "${temp_dir}" && patch -p0 -i "${PATCH_FILE}")

  patched_sha="$(sha_of "${temp_dir}/PromptBuilder.js")"
  if [[ "${patched_sha}" != "${EXPECTED_POST_SHA}" ]]; then
    die "Patched file SHA mismatch (${patched_sha}); expected ${EXPECTED_POST_SHA}."
  fi

  cp -p "${temp_dir}/PromptBuilder.js" "${target_file}"

  rm -rf "${temp_dir}"

  local final_sha
  final_sha="$(sha_of "${target_file}")"
  if [[ "${final_sha}" != "${EXPECTED_POST_SHA}" ]]; then
    die "Post-patch target SHA mismatch (${final_sha}); expected ${EXPECTED_POST_SHA}."
  fi

  restart_pm2
  log "Install complete. PromptBuilder now at post-patch SHA ${EXPECTED_POST_SHA}."
  log "Rollback: $(basename "$0") --uninstall"
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

[[ -f "${PATCH_FILE}" ]] || die "Patch file not found: ${PATCH_FILE}"

TARGET_FILE="$(find_target_file || true)"
[[ -n "${TARGET_FILE}" ]] || die "Could not find cyrus-edge-worker PromptBuilder.js"
[[ -f "${TARGET_FILE}" ]] || die "Target file does not exist: ${TARGET_FILE}"

CURRENT_SHA="$(sha_of "${TARGET_FILE}")"
log "Target file: ${TARGET_FILE}"
log "Current SHA256: ${CURRENT_SHA}"

if [[ ${UNINSTALL} -eq 1 ]]; then
  restore_latest_backup "${TARGET_FILE}"
  exit 0
fi

if [[ "${CURRENT_SHA}" == "${EXPECTED_POST_SHA}" ]]; then
  log "Patch already installed; no changes required."
  if [[ ${DRY_RUN} -eq 1 ]]; then
    log "[dry-run] nothing to do"
  fi
  exit 0
fi

if [[ "${CURRENT_SHA}" != "${EXPECTED_PRE_SHA}" ]]; then
  die "Unexpected pre-patch SHA (${CURRENT_SHA}). Expected ${EXPECTED_PRE_SHA} before patching."
fi

apply_patch_safely "${TARGET_FILE}"
