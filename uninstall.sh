#!/usr/bin/env bash
# Remove the codex-adversary install from ~/.claude.
# The skill is deleted only if it carries this project's ownership stamp;
# anything you authored yourself is left alone.
# Override the target with  CLAUDE_HOME=/path ./uninstall.sh
set -uo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
STAMP=".codex-adversary"
MARK_START="<!-- codex-adversary:directive START -->"
MARK_END="<!-- codex-adversary:directive END -->"

# skills: remove only dirs carrying our ownership stamp
for d in "$DEST"/skills/*/; do
  [ -d "$d" ] || continue
  name="$(basename "$d")"
  if [ -f "$d/$STAMP" ]; then
    rm -rf "$d"; echo "Removed skills/$name"
  elif [ "$name" = "adversarial-review" ] || [ "$name" = "codex-advisor" ]; then
    echo "Left skills/$name in place (no codex-adversary stamp — not ours)."
  fi
done

# wrapper + the commands this repo ships (matched by name)
[ -f "$DEST/bin/codex-adversary.sh" ] && { rm -f "$DEST/bin/codex-adversary.sh"; echo "Removed bin/codex-adversary.sh"; }
for c in "$SRC"/commands/*.md; do
  [ -f "$c" ] || continue
  name="$(basename "$c")"
  [ -f "$DEST/commands/$name" ] && { rm -f "$DEST/commands/$name"; echo "Removed commands/$name"; }
done

if [ -f "$DEST/CLAUDE.md" ] && grep -qF "$MARK_START" "$DEST/CLAUDE.md"; then
  tmp="$(mktemp "${TMPDIR:-/tmp}/claude-md.XXXXXX")"
  awk -v s="$MARK_START" -v e="$MARK_END" '
    $0==s {skip=1; next} skip && $0==e {skip=0; next} !skip {print}
  ' "$DEST/CLAUDE.md" > "$tmp" && mv "$tmp" "$DEST/CLAUDE.md"
  echo "Removed the directive block from CLAUDE.md"
fi

echo "Uninstalled."
