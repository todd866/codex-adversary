---
name: budget-aware-allocation
description: Use when a token-budget snapshot shows a rate-limit window getting low (the SessionStart / UserPromptSubmit / PreToolUse budget hook fired), or before kicking off a large token spend (a big Workflow, a wide Agent fan-out, reading a huge corpus) — to decide whether to proceed lean, defer, or push the heavy work to Codex.
---

# Budget-Aware Allocation

## Overview
Claude and Codex have separate token rate-limit budgets. The `ai-budget` hook injects a snapshot when a window is low. The two windows (5-hour and weekly) have fundamentally different characters — treat them differently.

## The weekly window is the real scarce budget
The **weekly window** is the one that matters for conservation. Running it dry strands you for days. When it is low AND far from its reset:

1. **Be deliberate before big spends.** If the next action is large (a Workflow, a wide Agent fan-out, ingesting a big corpus), flag the intended scope in your reasoning (or to the user if one is present). When no human is in the loop, proceed with the smallest sufficient scope rather than blocking.
2. **Offload to the provider with headroom.** If Claude is the constraint and Codex has weekly budget, route heavy/parallel *execution* and *review* to Codex (you orchestrate; Codex spends its own banked tokens). Codex review/advice is available now via `adversarial-review` / `codex-advisor`; heavy parallel execution offload is not yet wired.
3. **Trim.** Lower effort, batch, and avoid re-reading large context when near the edge.

## A low window that resets soon is use-it-or-lose-it — spend it freely
When any window (weekly or 5-hour) is about to reset, the remaining budget **cannot be saved** — it simply disappears at reset. Do not conserve a soon-resetting low window; spend it freely and work at full scope.

## The 5-hour window is a fast-cycling throttle, not a bankable budget
The **5-hour window** cycles every 5 hours and cannot be banked. A low 5h reading is a short-term throttle signal only:
- It **never** justifies conserving or offloading — at most it means you may hit a brief rate-limit and have to wait a few minutes.
- When the hook emits a neutral 5h note ("spend freely, it doesn't bank"), act on that: work at normal scope; a short throttle wait is cheaper than conservative scope that under-delivers.
- Never treat a 5h-low reading as a signal to reduce effort or route work elsewhere.

## When healthy
The hook is silent. Work normally.

## Never
- Don't trust a snapshot flagged "⚠ stale" as live — re-check or proceed conservatively.
- Don't hard-block on budget; this is judgment, not a gate.
- If Codex is also constrained or unavailable, proceed with the smallest scoped action and note the constraint — don't stall.
- Don't confuse a soon-resetting window (use-it-or-lose-it) with a genuinely depleted window (conserve). The hook distinguishes them.
