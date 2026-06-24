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
*call* Anthropic's usage endpoint. Port Glancebar's exact approach. Either way this
work is owned by the out-of-band **service** (below), so any cost or network call
is off the agent's critical path — agents only ever poll the published JSON.

## Components

### 1. The budget service (daemon) + thin readers
Split into a **refresher** (the service) and **readers** (what hooks call), so an
agent never blocks on a live read or a Keychain prompt mid-turn. Agents *poll the
published state*; they never compute it.

**`ai-budget refresh` — the service.** Runs out-of-band on a schedule (a launchd
LaunchAgent on macOS — installed below). Reads all sources and **publishes** the
current state to `~/.claude/.cache/ai-budget.json` via an atomic write. Because
it's a single stable binary path, the macOS Keychain read is authorised **once**
("Always Allow") and never prompts again — the per-turn prompt problem disappears.
Cadence: cheap file sources (codex sessions, my transcripts) ~every 60s; the
Claude Keychain/OAuth window ~every 5 min (or the endpoint's sane floor). The
service is the *only* thing that touches the live sources.

**`ai-budget read` / `ai-budget if-below <pct>` — the readers (what hooks run).**
Read ONLY the published JSON. Instant, never compute, never block, never prompt.
`read` prints the compact snapshot; `if-below <pct>` prints only when a window is
below `<pct>` (+ the allocation hint), else nothing. Both stamp the snapshot's age
("as of 40s ago") and flag staleness if the service has fallen behind.

**Published state** — `~/.claude/.cache/ai-budget.json`, the contract between
service and readers:
```json
{ "generatedAt": "<iso>",
  "claude": { "fiveHourPct": 62, "weeklyPct": 18, "resetsAt": "<iso>",
              "spentTodayTokens": 4100000, "spent7dTokens": 22000000 },
  "codex":  { "fiveHourPct": 99, "weeklyPct": 81, "resetsAt": "<iso>",
              "spentTodayTokens": 0, "spent7dTokens": 2900000 },
  "errors": [] }
```
`null` for any window the service couldn't read (→ readers show `n/a`).

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
| `SessionStart` | `ai-budget read` | Full snapshot (from the published state) — where I stand when a session opens. |
| `UserPromptSubmit` | `ai-budget if-below 30` | Polls the published state each turn; injects **only** when a window < 30%. Catches the offhand-comment-near-limit case, silent when healthy. |
| `PreToolUse` matcher `Workflow\|Agent\|Task` | `ai-budget if-below 30` | A sharp "near the limit — consider Codex" right before a big fan-out. **Non-blocking** (soft policy). |

Every hook command is a pure **reader** of the published JSON — instant, no
compute, no Keychain, no network. They merge alongside the existing `SessionEnd`
config-backup hook; nothing is overwritten.

### 3. Guardrail policy skill — `skills/budget-aware-allocation/`
Feature 1's behavioural half (a `SKILL.md`, same layout as the existing
`adversarial-review` / `codex-advisor` skills). Triggers when a budget window is
low. Content: **be deliberate before big token spends when near the limit** —
flag/confirm before detonating a huge operation, prefer lower effort/batching, and
note that Codex has idle budget for heavy lifting. (The *mechanism* to actually
delegate execution to a Codex worker is Feature 2; Feature 1 makes Claude stop and
notice, and it can already route *review/advice* to Codex via the existing skills.)

### 4. `install.sh` enhancement — service + hooks, idempotent
Today `install.sh` copies `bin/`, `skills/`, `commands/` into `$DEST`
(`CLAUDE_HOME`, default `~/.claude`). Add:
- Copy `bin/ai-budget.sh` into `$DEST/bin/`.
- **Install the service:** a launchd LaunchAgent
  (`~/Library/LaunchAgents/com.codex-adversary.ai-budget.plist`) that runs
  `ai-budget refresh` on the cadence above + at login, `launchctl bootstrap`-ed
  (idempotent: reload if present). macOS-only; on other OSes skip the LaunchAgent
  and the readers fall back to an inline refresh on a longer cache (degraded but
  functional).
- **Merge the three hooks** into `$DEST/settings.json` (create if absent; preserve
  existing hooks incl. the SessionEnd backup; skip if already present). JSON-aware
  merge (node/jq), never a blind overwrite.
- First-run note: the user clicks "Always Allow" once on the Keychain prompt the
  service triggers; thereafter it is silent.

## Data flow
```
launchd timer → ai-budget refresh    (out-of-band; ~60s files / ~5min Keychain)
              → reads codex sessions + Claude Keychain + my transcripts
              → atomically publishes ~/.claude/.cache/ai-budget.json

hook fires    → ai-budget read | if-below 30    (just reads the JSON; instant)
              → snapshot string (+ hint / staleness)
              → injected into Claude's context (SessionStart / per-prompt / pre-fan-out)
```

## Error handling
- **Service down / state stale:** readers read whatever JSON exists; if
  `generatedAt` is older than a threshold (~15 min) they append "⚠ budget data
  stale — service may be down" so a number is never silently trusted as live. File
  missing entirely → reader prints nothing, exits 0.
- **Per-window failure:** Keychain prompts/denies or non-macOS → service writes
  Claude windows as `null` (readers show `n/a`, fall back to spend trend). No codex
  sessions / unparseable → Codex `null`. One dead source never blanks the others.
- A **reader** (the hook path) must NEVER block, prompt, or break a session — it
  only reads a local JSON file. All the fragile work lives in the service.

## Testing
Unit-test the three pure parsers against fixture files (the parse logic split out
from the I/O so it's testable headless):
1. Codex `rate_limits` extraction — picks the latest, drops reset-elapsed windows,
   computes remaining from `used_percent`.
2. Transcript per-day token sum — input/output/cache fields, day bucketing,
   cached-inclusive vs uncached.
3. Claude usage-window parse — tolerant of fraction-or-percent utilization and
   ISO-or-epoch `resets_at`.
Plus a **reader** test — given a fixture `ai-budget.json`, `read` / `if-below`
produce the right snapshot, threshold gating, and staleness flag — and a smoke
test that readers exit 0 and never prompt/block even when the published file is
missing or stale.

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
