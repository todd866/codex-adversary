#!/usr/bin/env bash
# Install the Codex adversarial-review setup into ~/.claude.
#   - copies the wrapper, skill, and slash command
#   - appends the auto-trigger directive to ~/.claude/CLAUDE.md (idempotent)
# Override the target with CLAUDE_HOME=/path ./install.sh
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="${CLAUDE_HOME:-$HOME/.claude}"

if ! command -v codex >/dev/null 2>&1; then
  echo "WARNING: the 'codex' CLI is not on your PATH."
  echo "  Install it and run 'codex login' first:  https://github.com/openai/codex"
  echo
fi

mkdir -p "$DEST/bin" "$DEST/skills" "$DEST/commands"
cp "$SRC/bin/codex-adversary.sh" "$DEST/bin/"
chmod +x "$DEST/bin/codex-adversary.sh"
rm -rf "$DEST/skills/adversarial-review"
cp -R "$SRC/skills/adversarial-review" "$DEST/skills/"
cp "$SRC/commands/adversarial-review.md" "$DEST/commands/"
echo "Installed: bin/codex-adversary.sh, skills/adversarial-review, commands/adversarial-review.md → $DEST"

MARK="<!-- codex-adversary:directive -->"
touch "$DEST/CLAUDE.md"
if grep -qF "$MARK" "$DEST/CLAUDE.md"; then
  echo "Auto-trigger directive already present in $DEST/CLAUDE.md (skipped)."
else
  { printf '\n%s\n' "$MARK"; cat "$SRC/CLAUDE-directive.md"; } >> "$DEST/CLAUDE.md"
  echo "Added auto-trigger directive to $DEST/CLAUDE.md"
fi

echo
echo "Done. Start a new Claude Code session to pick up the skill."
echo "Quick test:  echo 'Claims X because Y.' | $DEST/bin/codex-adversary.sh --mode prose"
