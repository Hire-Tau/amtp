#!/usr/bin/env bash
# Install the Claude Code skills bundled with AMTP into ~/.claude/skills so any
# Claude session on this machine can use AMTP federation effectively. Idempotent:
# re-running overwrites with the repo's current version.
#
# Usage:
#   bash contrib/claude-skills/install.sh            # from an amtp checkout
#   curl -fsSL https://raw.githubusercontent.com/Hire-Tau/amtp/main/contrib/claude-skills/install.sh | bash
set -euo pipefail

DEST="${CLAUDE_SKILLS_DIR:-${HOME}/.claude/skills}"
BASE_URL="https://raw.githubusercontent.com/Hire-Tau/amtp/main/contrib/claude-skills"
SKILLS=(amtp)

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]:-/dev/null}")" 2>/dev/null && pwd || true)

for skill in "${SKILLS[@]}"; do
  mkdir -p "${DEST}/${skill}"
  if [[ -n "${script_dir}" && -f "${script_dir}/${skill}/SKILL.md" ]]; then
    cp "${script_dir}/${skill}/SKILL.md" "${DEST}/${skill}/SKILL.md"
  else
    curl -fsSL "${BASE_URL}/${skill}/SKILL.md" -o "${DEST}/${skill}/SKILL.md"
  fi
  echo "installed ${DEST}/${skill}/SKILL.md"
done
