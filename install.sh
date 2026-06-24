#!/usr/bin/env bash
# Install the Codex adversarial-review setup into ~/.claude.
#   - copies the wrapper, skill (stamped as ours), and slash command
#   - appends/UPGRADES the auto-trigger directive in ~/.claude/CLAUDE.md (paired markers)
# Override the target with  CLAUDE_HOME=/path ./install.sh
# Set  FORCE=1  to overwrite a pre-existing adversarial-review skill that isn't ours.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"
STAMP=".codex-adversary"                       # ownership marker inside the skill dir
MARK_START="<!-- codex-adversary:directive START -->"
MARK_END="<!-- codex-adversary:directive END -->"

# Show the real target — it may be a symlink (e.g. a dotfiles repo).
RESOLVED="$DEST"
command -v realpath >/dev/null 2>&1 && RESOLVED="$(realpath "$DEST" 2>/dev/null || echo "$DEST")"
[ "$RESOLVED" = "$DEST" ] && echo "Installing into: $DEST" || echo "Installing into: $DEST (resolves to $RESOLVED)"

CODEX_OK=1
if ! command -v codex >/dev/null 2>&1; then
  CODEX_OK=0
  echo "WARNING: the 'codex' CLI is not on your PATH — install it and run 'codex login':"
  echo "  https://github.com/openai/codex"
  echo
fi

mkdir -p "$DEST/bin" "$DEST/skills" "$DEST/commands"

cp "$SRC/bin/codex-adversary.sh" "$DEST/bin/"
chmod +x "$DEST/bin/codex-adversary.sh"

# --- ai-budget: reader/service ---
cp "$SRC/bin/ai-budget.mjs" "$SRC/bin/ai-budget-lib.mjs" "$DEST/bin/"
if [ "$(uname)" = "Darwin" ] && command -v node >/dev/null 2>&1; then
  LA="$HOME/Library/LaunchAgents/com.codex-adversary.ai-budget.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  sed "s#__BIN__#$DEST/bin/ai-budget.mjs#g" "$SRC/bin/com.codex-adversary.ai-budget.plist.template" > "$LA"
  launchctl bootout "gui/$(id -u)/com.codex-adversary.ai-budget" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA" 2>/dev/null \
    && echo "ai-budget service installed (first refresh may prompt for Keychain access — click Always Allow)." \
    || echo "ai-budget: launchctl bootstrap failed; run 'node $DEST/bin/ai-budget.mjs refresh' manually."
else
  echo "ai-budget: non-macOS or no node — service not installed; readers will show what they can."
fi

# --- skills: never silently clobber a foreign same-named skill -------------------
for src_skill in "$SRC"/skills/*/; do
  name="$(basename "$src_skill")"
  dst="$DEST/skills/$name"
  if [ -d "$dst" ] && [ ! -f "$dst/$STAMP" ]; then
    if [ "${FORCE:-0}" = "1" ]; then
      echo "Note: overwriting a pre-existing (non-ours) '$name' skill (FORCE=1)."
    else
      bak="$dst.bak-$(date +%Y%m%d%H%M%S)"
      mv "$dst" "$bak"
      echo "Note: found a '$name' skill without our stamp — moved it to $bak"
    fi
  fi
  # Stage fully, then swap — a mid-copy failure can't leave the skill half-removed
  # (the destructive rm runs only after a successful copy).
  stage="$DEST/skills/.$name.stage.$$"
  rm -rf "$stage"
  cp -R "${src_skill%/}" "$stage"
  date -u +"installed by codex-adversary install.sh on %Y-%m-%dT%H:%M:%SZ" > "$stage/$STAMP"
  rm -rf "$dst"
  mv "$stage" "$dst"
done

cp "$SRC"/commands/*.md "$DEST/commands/"
echo "Installed: bin/codex-adversary.sh, skills/* (stamped), commands/*.md → $DEST"

# --- directive: paired markers, upgrade-in-place ---------------------------------
touch "$DEST/CLAUDE.md"
if grep -qF "$MARK_START" "$DEST/CLAUDE.md"; then
  tmp="$(mktemp "${TMPDIR:-/tmp}/claude-md.XXXXXX")"
  awk -v s="$MARK_START" -v e="$MARK_END" '
    $0==s {skip=1; next} skip && $0==e {skip=0; next} !skip {print}
  ' "$DEST/CLAUDE.md" > "$tmp" && mv "$tmp" "$DEST/CLAUDE.md"
  echo "Upgraded the auto-trigger directive in $DEST/CLAUDE.md"
else
  echo "Added the auto-trigger directive to $DEST/CLAUDE.md"
fi
{ printf '\n%s\n' "$MARK_START"; cat "$SRC/CLAUDE-directive.md"; printf '%s\n' "$MARK_END"; } >> "$DEST/CLAUDE.md"

echo
if [ "$CODEX_OK" = "1" ]; then
  echo "Done. Start a new Claude Code session to pick up the skill."
  echo "Quick test:  echo 'Claims X because Y.' | $DEST/bin/codex-adversary.sh --mode prose"
else
  echo "Done — but install and 'codex login' before use (see the warning above)."
fi
