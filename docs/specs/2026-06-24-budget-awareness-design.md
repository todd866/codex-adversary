# Budget Awareness & Guardrail — Design (Feature 1 of 2)

**Status:** Active
**Date:** 2026-06-24
**Repo:** codex-adversary (installs into `~/.claude`)

## Problem

Claude Code has no native awareness of how close it is to the account rate limit
(the 5-hour / weekly token windows). The failure mode, lived 2026-06-23: a user
sitting near their weekly limit makes an offhand request, Claude does something
that detonates ~10M tokens, and the limit is blown — no warning, no chance to be
deliberate.

The bigger opportunity: the user banks a large **Codex** budget they never spend
(Codex is a poor orchestrator, so they don't drive work through it) while
exhausting their **Claude** budget. But Claude *is* a strong orchestrator — it can
drive Codex *worker* agents for heavy/parallel jobs, spending Codex's idle budget
to spare Claude's scarce one. That requires Claude to **see both budgets**.

This spec is **Feature 1 — the awareness + guardrail foundation**: make Claude
aware of its own and Codex's token budgets, and frugal near the limit. **Feature 2**
(separate spec) adds the Codex *offloading* mechanism and the proactive
"punt this to Codex" behaviour.

## Data sources (ported method, NO Glancebar dependency)

Glancebar already computes these from local files; we read the same files
ourselves. No dependency on the app.

| Signal | Source | Method |
|--------|--------|--------|
| **Codex 5h + weekly %** | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` (+ `archived_sessions/`) | Latest event carrying a `rate_limits` dict: `primary`=5-hour, `secondary`=weekly, each with `used_percent` + `resets_at` (epoch). `remaining = 1 − used_percent/100`. Skip windows whose `resets_at` is already past. |
| **Claude 5h + weekly %** | `Claude Code-credentials` Keychain item (macOS `login.keychain`) | Read the credential → Anthropic OAuth usage windows (`five_hour` / `seven_day`, tolerant of fraction-or-percent `utilization` + ISO-or-epoch `resets_at`). **Best-effort, macOS-only.** |
| **Claude token spend (today / 7d)** | `~/.claude/projects/**/*.jsonl` (my own transcripts) | Assistant messages carry `usage` = `input_tokens` + `output_tokens` + `cache_creation_input_tokens` + `cache_read_input_tokens` + a timestamp. Sum per day; report uncached and cached-inclusive separately. Portable, no auth. |

**Open feasibility item (resolve in the plan, not now):** whether the Keychain
credential *embeds* the usage windows or whether the OAuth token must be used to
*call* Anthropic's usage endpoint. Port Glancebar's exact approach. Either way the
~3-minute cache (below) bounds the cost to a couple of reads per session.

## Components

### 1. `bin/ai-budget.sh` — the single reader
One script, the source of truth. Pure file/Keychain reads; no network unless the
Keychain path demands it.

- **`ai-budget`** → prints a compact snapshot (see format below).
- **`ai-budget --if-below <pct>`** → prints **only** when some window is below
  `<pct>` remaining; otherwise prints nothing and exits 0 (silent when healthy).
  When it does print, it appends the allocation hint (below).
- **Caching:** writes `~/.claude/.cache/ai-budget.json` with a timestamp; reuses
  it for ~180s so per-prompt hook calls are cheap. `--no-cache` forces a refresh.
- **Degrade, never block:** any source that errors (Keychain prompt/deny on
  macOS, missing codex sessions, non-macOS) renders that signal as `n/a` and the
  script still exits 0 with whatever it has.

**Snapshot format** (compact, one line per provider; goes into Claude's context):
```
Claude  5h 62% · week 18% ⚠ (resets Thu 13:30) · spent 4.1M today / 22M 7d
Codex   5h 99% · week 81%  (resets Wed 13:30) · spent 0 today / 2.9M 7d
```
**Allocation hint** (appended by `--if-below` when a Claude window is the low one
and Codex is materially higher):
```
⚠ Claude weekly low (18%); Codex healthy (81%). Prefer routing heavy/parallel
  work to Codex and stay lean. Be deliberate before any big token spend.
```

### 2. Hooks (installed GLOBALLY into `~/.claude/settings.json`)
Budget is spent in every project, so the hooks are user-level, not per-project.

| Event | Command | Effect |
|-------|---------|--------|
| `SessionStart` | `ai-budget` | Full snapshot — where I stand when a session opens. |
| `UserPromptSubmit` | `ai-budget --if-below 30` | Re-checks (cached) each turn; injects **only** when a window < 30%. Catches the offhand-comment-near-limit case without noise when healthy. |
| `PreToolUse` matcher `Workflow\|Agent\|Task` | `ai-budget --if-below 30` | A sharp "near the limit — consider Codex" right before a big fan-out. **Non-blocking** (soft policy). |

These merge alongside the existing `SessionEnd` config-backup hook; nothing is
overwritten.

### 3. Guardrail policy skill — `skills/budget-aware-allocation/`
Feature 1's behavioural half (a `SKILL.md`, same layout as the existing
`adversarial-review` / `codex-advisor` skills). Triggers when a budget window is
low. Content: **be deliberate before big token spends when near the limit** —
flag/confirm before detonating a huge operation, prefer lower effort/batching, and
note that Codex has idle budget for heavy lifting. (The *mechanism* to actually
delegate execution to a Codex worker is Feature 2; Feature 1 makes Claude stop and
notice, and it can already route *review/advice* to Codex via the existing skills.)

### 4. `install.sh` enhancement — wire the hooks idempotently
Today `install.sh` copies `bin/`, `skills/`, `commands/` into `$DEST`
(`CLAUDE_HOME`, default `~/.claude`). Add: copy `bin/ai-budget.sh`, and **merge**
the three hooks into `$DEST/settings.json` (create it if absent; preserve any
existing hooks; skip if already present — idempotent). Use a JSON-aware merge
(node/jq), never a blind overwrite.

## Data flow
```
hook fires → ai-budget.sh (cached ≤180s)
           → reads codex sessions + Claude Keychain + my transcripts
           → snapshot string (+ hint, if --if-below tripped)
           → injected into Claude's context (SessionStart / per-prompt / pre-fan-out)
```

## Error handling
- Keychain read prompts/denies or non-macOS → Claude `%` = `n/a`; fall back to the
  spend trend. Never block.
- No codex sessions yet / unparseable → Codex `n/a`.
- Cache read/write failure → compute fresh; if compute fails entirely, print
  nothing and exit 0. A budget reader must never break a session.

## Testing
Unit-test the three pure parsers against fixture files (the parse logic split out
from the I/O so it's testable headless):
1. Codex `rate_limits` extraction — picks the latest, drops reset-elapsed windows,
   computes remaining from `used_percent`.
2. Transcript per-day token sum — input/output/cache fields, day bucketing,
   cached-inclusive vs uncached.
3. Claude usage-window parse — tolerant of fraction-or-percent utilization and
   ISO-or-epoch `resets_at`.
Plus a smoke test: `ai-budget` exits 0 and prints *something* (or nothing for
`--if-below` when healthy) on a machine with no codex/keychain data.

## Out of scope (→ Feature 2)
- The Codex **worker/executor** mechanism (today `codex-adversary.sh` is read-only
  review; delegating *execution* of a heavy job is a new, sandboxed capability).
- The proactive **offload action** ("I'm low on Claude / high on Codex → punt this
  job to Codex"). Feature 1 surfaces the imbalance + suggestion; Feature 2 makes
  acting on it one clean step.
- Any change to the Claude account's actual limits, or financial/$ cost tracking
  (this is **token** budget — the rate-limit windows — not spend in dollars).

## Cross-platform note
Codex quota + Claude token-spend are portable (plain file reads). The Claude
**%-remaining** depends on the macOS Keychain; on non-macOS it degrades to `n/a`
and the spend trend carries the Claude side. The feature is useful everywhere;
richest on macOS.
