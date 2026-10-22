#!/usr/bin/env bash
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd -P)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/home/.agents/skills/design-memory" "$tmp/home/.design-memory"
printf '#!/bin/sh\ntest -f "$1" || exit 41\n' > "$tmp/bin/bun"
chmod +x "$tmp/bin/bun"
printf '%s\n' '---' 'name: design-memory' '---' > "$tmp/home/.agents/skills/design-memory/SKILL.md"
echo protected > "$tmp/home/.design-memory/keep.txt"
export HOME="$tmp/home" PATH="$tmp/bin:$PATH"
bash "$src/install.sh"
for name in taste-add taste-define taste-use; do
  test -f "$HOME/.agents/skills/$name/SKILL.md"
  test -f "$HOME/.claude/skills/$name/SKILL.md"
  "$HOME/.agents/skills/$name/scripts/taste" --help
  test -f "$HOME/.agents/skills/$name/references/aspects.md"
done
test "$(find "$HOME/.agents/skills" -name SKILL.md | wc -l | tr -d ' ')" -eq 3
test -f "$HOME/.agents/skills/design-memory/SKILL.md.legacy"
test ! -e "$HOME/.agents/skills/design-memory/SKILL.md"
test "$(cat "$HOME/.design-memory/keep.txt")" = protected
test -x "$HOME/.local/bin/taste" && test ! -L "$HOME/.local/bin/taste"
"$HOME/.local/bin/taste" --help
test -f "$HOME/.agents/skills/design-memory/src/app.ts"
bash "$HOME/.agents/skills/design-memory/install.sh"
test "$(find "$HOME/.agents/skills" -name SKILL.md | wc -l | tr -d ' ')" -eq 3
"$HOME/.agents/skills/taste-use/scripts/taste" --help
echo "Two-skill installation and migration: PASS"
