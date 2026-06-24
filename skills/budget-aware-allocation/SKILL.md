---
name: budget-aware-allocation
description: Use when a token-budget snapshot shows a rate-limit window getting low (the SessionStart / UserPromptSubmit / PreToolUse budget hook fired), or before kicking off a large token spend (a big Workflow, a wide Agent fan-out, reading a huge corpus) — to decide whether to proceed lean, defer, or push the heavy work to Codex.
---

# Budget-Aware Allocation

## Overview
Claude and Codex have separate token rate-limit budgets. The `ai-budget` hook injects a snapshot when a window is low. Near a limit, an offhand request can detonate millions of tokens — be deliberate, and use the idle budget on the *other* provider.

## When the budget hook says a window is low
1. **Be deliberate before big spends.** If the next action is large (a Workflow, a wide Agent fan-out, ingesting a big corpus), say so and confirm scope before firing — don't let an offhand request blow the limit.
2. **Offload to the provider with headroom.** If Claude is the constraint and Codex has budget, route heavy/parallel *execution* and *review* to Codex (you orchestrate; Codex spends its own banked tokens). Codex review/advice is available now via `adversarial-review` / `codex-advisor`; heavy execution offload is Feature 2.
3. **Trim.** Lower effort, batch, and avoid re-reading large context when near the edge.

## When healthy
The hook is silent. Work normally.

## Never
- Don't trust a snapshot flagged "⚠ stale" as live — re-check or proceed conservatively.
- Don't hard-block on budget; this is judgment, not a gate.
