#!/usr/bin/env bash
# Test skill installation without requiring Bun. CLI path resolution is checked
# by a fake bun executable that asserts the source file actually exists.
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
for name in taste-add taste-use; do
  test -f "$HOME/.agents/skills/$name/SKILL.md"
  test -f "$HOME/.claude/skills/$name/SKILL.md"
  "$HOME/.agents/skills/$name/scripts/taste" --help
  test -f "$HOME/.agents/skills/$name/references/analysis.md"
done
test "$(find "$HOME/.agents/skills" -name SKILL.md | wc -l | tr -d ' ')" -eq 2
test -f "$HOME/.agents/skills/design-memory/SKILL.md.legacy"
test ! -e "$HOME/.agents/skills/design-memory/SKILL.md"
test "$(cat "$HOME/.design-memory/keep.txt")" = protected
test -L "$HOME/.local/bin/taste"
test -f "$HOME/.agents/skills/design-memory/src/app.ts"
# Re-run using the installed runtime; the original extraction is not needed.
bash "$HOME/.agents/skills/design-memory/install.sh"
test "$(find "$HOME/.agents/skills" -name SKILL.md | wc -l | tr -d ' ')" -eq 2
"$HOME/.agents/skills/taste-use/scripts/taste" --help
echo "Two-skill installation and migration: PASS"
