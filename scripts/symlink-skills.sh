#!/usr/bin/env bash
set -euo pipefail

# Create harness-specific skill symlinks from canonical repo skills/.
# Current harness targets:
# - .claude/skills
# - .codex/skills
# - .opencode/skills

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CANONICAL_SKILLS_DIR="${ROOT_DIR}/skills"

HARNESS_SKILL_DIRS=(
  ".claude/skills"
  ".codex/skills"
  ".opencode/skills"
)

if [[ ! -d "${CANONICAL_SKILLS_DIR}" ]]; then
  echo "No canonical skills directory found at ${CANONICAL_SKILLS_DIR}"
  exit 0
fi

for harness_dir in "${HARNESS_SKILL_DIRS[@]}"; do
  target_dir="${ROOT_DIR}/${harness_dir}"
  mkdir -p "${target_dir}"

  for skill_path in "${CANONICAL_SKILLS_DIR}"/*; do
    [[ -d "${skill_path}" ]] || continue
    skill_name="$(basename "${skill_path}")"
    link_path="${target_dir}/${skill_name}"
    desired_target="../../skills/${skill_name}"

    if [[ -L "${link_path}" ]]; then
      existing_target="$(readlink "${link_path}")"
      if [[ "${existing_target}" == "${desired_target}" ]]; then
        continue
      fi
      rm "${link_path}"
    elif [[ -e "${link_path}" ]]; then
      echo "Skipping ${link_path} (exists and is not a symlink)"
      continue
    fi

    ln -s "${desired_target}" "${link_path}"
    echo "Linked ${link_path} -> ${desired_target}"
  done
done
