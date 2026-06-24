---
name: budget-aware-allocation
description: Use when a token-budget snapshot shows a rate-limit window getting critically low (the SessionStart / PreToolUse budget hook fired), or before kicking off a large token spend (a big Workflow, a wide Agent fan-out, reading a huge corpus) — to decide whether to proceed lean, defer, or push the heavy work to Codex.
---

# Budget-Aware Allocation

## Overview

Claude and Codex have separate token rate-limit budgets. The `ai-budget` tool injects snapshots at two
points in a session:

- **SessionStart** (`read`): a once-per-session glance at both providers — 5h window, weekly window,
  age. Informational only; includes a neutral 5h note if the 5h window is low and a trend note if the
  weekly is projected to run dry before its reset. No action required unless critical.
- **PreToolUse** on `Workflow|Agent|Task` (`if-below 30`): the critical safety net, fires only when the
  weekly window is approaching a ~10% floor OR is trending to run dry before its reset. Silent otherwise.

There is **no per-turn (UserPromptSubmit) hook** — the tool is quiet by default.

## The weekly window is the real scarce budget

The **weekly window** is the one that matters for conservation. Running it dry strands you for days.

The critical warn fires when all of these are true:
- Weekly is NOT resetting soon (>90 min away or unknown reset).
- `weeklyPct` is not null.
- `weeklyPct < 12` (approaching 10% floor) **OR** (`weeklyPct < 30` AND the weekly is trending to run
  dry before its reset).

When the critical warn fires and Codex has weekly budget (≥50%):
1. **Route heavy/parallel work to Codex.** You orchestrate; Codex spends its own banked tokens.
   Codex review/advice is available now via `adversarial-review` / `codex-advisor`; heavy parallel
   execution offload is not yet wired.
2. **Trim scope.** Lower effort, batch, and avoid re-reading large context when near the edge.

**Conserve-vs-spend is the USER's call.** The tool informs, not enforces. The right choice depends on
the week — how many big tasks remain, how close the reset is, whether Codex has headroom. Present the
data; don't hard-block.

## A low window that resets soon is use-it-or-lose-it — spend it freely

When a weekly window is resetting within 90 minutes, remaining budget **cannot be saved** — it
disappears at reset. The critical warn is suppressed in this case. Spend freely.

## The 5-hour window is a fast-cycling throttle, not a bankable budget

The **5-hour window** cycles every 5 hours and cannot be banked.

- When the SessionStart glance shows a neutral 5h note ("doesn't bank, spend freely"), act on that:
  work at normal scope; a brief throttle wait is cheaper than conservative scope that under-delivers.
- The 5h window **never** triggers the critical warn and never justifies conserving or offloading.

## Trend awareness

The tool tracks a rolling 3-hour history of the weekly percentage. If the slope projects the weekly
reaching 0 before its reset, `willRunDryBeforeReset` is set on the state and:
- The SessionStart glance includes an informational trend note.
- The critical warn fires if the weekly is also below 30% (even if above the 10% floor).

A flat or rising slope (e.g. just after a reset) suppresses the projection entirely.

## When healthy

The hook is silent. Work normally.

## Never

- Don't trust a snapshot flagged "⚠ stale" as live — re-check or proceed conservatively.
- Don't hard-block on budget; this is judgment, not a gate.
- If Codex is also constrained or unavailable, proceed with the smallest scoped action and note the
  constraint — don't stall.
- Don't confuse a soon-resetting window (use-it-or-lose-it) with a genuinely depleted window
  (conserve). The hook distinguishes them.
