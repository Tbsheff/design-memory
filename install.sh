#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "$0")" && pwd -P)"
core="$HOME/.agents/skills/design-memory"

if ! command -v bun >/dev/null 2>&1; then
  echo 'Bun is required: https://bun.com/docs/installation' >&2
  exit 1
fi

mkdir -p "$core" "$HOME/.agents/skills" "$HOME/.claude/skills"
if [[ "$src" != "$(cd "$core" && pwd -P)" ]]; then
  cp -R "$src/README.md" "$src/install.sh" "$src/LICENSE" \
    "$src/package.json" "$src/scripts" "$src/src" "$src/references" "$src/desktop" "$core/"
fi

legacy="$core/SKILL.md"
if [[ -f "$legacy" ]] && grep -q '^name: design-memory$' "$legacy"; then
  if [[ ! -e "$core/SKILL.md.legacy" ]]; then
    mv "$legacy" "$core/SKILL.md.legacy"
  else
    mv "$legacy" "$core/SKILL.md.legacy.$(date +%s)"
  fi
  echo 'Previous combined skill archived (runtime and data retained).'
elif [[ -f "$legacy" ]]; then
  echo "A custom combined skill still exists at $legacy; review it for duplicate triggers."
fi

mkdir -p "$core/skill-definitions"
for name in taste-add taste-use; do
  if [[ -f "$src/skills/$name/SKILL.md" ]]; then
    cp "$src/skills/$name/SKILL.md" "$core/skill-definitions/$name.md"
  fi
  skill_source="$core/skill-definitions/$name.md"
  if [[ ! -f "$skill_source" ]]; then
    echo "Missing skill definition: $name" >&2
    exit 1
  fi
  destination="$HOME/.agents/skills/$name"
  mkdir -p "$destination/scripts"
  cp "$skill_source" "$destination/SKILL.md"
  printf '%s\n' '#!/bin/sh' 'exec "$HOME/.agents/skills/design-memory/scripts/taste" "$@"' > "$destination/scripts/taste"
  chmod +x "$destination/scripts/taste"
  if [[ ! -e "$destination/references" && ! -L "$destination/references" ]]; then
    ln -s "$core/references" "$destination/references"
  fi

  claude="$HOME/.claude/skills/$name"
  if [[ ! -e "$claude" && ! -L "$claude" ]]; then
    ln -s "$destination" "$claude"
  else
    echo "Claude Code: existing path preserved ($claude)"
  fi
  echo "Installed: $name -> $destination"
done

mkdir -p "$HOME/.local/bin"
short_wrapper="$HOME/.local/bin/taste"
if [[ -L "$short_wrapper" && "$(readlink "$short_wrapper")" == "$core/scripts/taste" ]]; then
  rm "$short_wrapper"
fi
if [[ ! -e "$short_wrapper" && ! -L "$short_wrapper" ]]; then
  printf '%s\n' '#!/bin/sh' 'exec "$HOME/.agents/skills/design-memory/scripts/taste" "$@"' > "$short_wrapper"
  chmod +x "$short_wrapper"
fi

service_plist="$HOME/Library/LaunchAgents/dev.taste.workspace.plist"
if [[ "$(uname)" == "Darwin" && -f "$service_plist" ]]; then
  if launchctl kickstart -k "gui/$(id -u)/dev.taste.workspace" >/dev/null 2>&1; then
    echo 'Background service restarted with the new code.'
  fi
fi

if [[ "$(uname)" == "Darwin" ]] && xcrun --find swiftc >/dev/null 2>&1; then
  bash "$core/desktop/build.sh" || echo 'Desktop app build failed; the CLI and workspace still work.' >&2
fi

echo "Data: ${DESIGN_MEMORY_HOME:-$HOME/.design-memory} (unchanged)"
echo "Open your visual library: $core/scripts/taste open"
echo "Short command (if ~/.local/bin is on PATH): taste open"
