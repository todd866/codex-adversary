---
description: Adversarial review of a target (diff, file, or argument) using Claude agents + Codex, synthesized
---

Run an adversarial review of: **$ARGUMENTS**

Invoke the `adversarial-review` skill and follow it exactly:

1. Decide `--mode diff` (code/changes) or `--mode prose` (a file, claim, or argument)
   for the target above. If no target is given, default to the current git diff
   (uncommitted changes) in `--mode diff`.
2. Run your own Claude adversarial review **and** Codex via
   `~/.claude/bin/codex-adversary.sh`, choosing `--effort high` vs `xhigh` per the
   skill's rubric (stakes × subtlety × length).
3. Synthesize per the skill's synthesis contract: agreements first (high-confidence),
   Codex-only findings with your own assessment, material disagreements escalated to
   Codex `xhigh` to adjudicate. Attribute every finding to its source.
