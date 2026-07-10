# Changelog

## v0.7.2 — 2026-07-10

**Retracts the budget-window selection rule in v0.7.1. There is no governing window, and no
arrangement of this telemetry predicts whether a call will be served.**

The measurement that settles it: while the general `codex`/`pro` 5h window read `used_percent
= 100`, Codex Desktop served **4,561 `gpt-5.6-sol` requests in 15 minutes** with zero
`rate_limit_reached_type` set — at the same moment a fresh `codex exec` on that same model was
refused with *"You've hit your usage limit."* **`used = 100` does not mean refused.**

Two further premises of v0.7.1 were false:
- **`plan_type` is not an account or an identity.** The same client emits both values,
  interleaved: over six hours Codex Desktop produced ~4.7k `pro` and ~4.8k `prolite` events,
  and `codex_exec` produced both. `prolite` was never "a retired plan". Filtering on the plan
  in the CLI's `id_token` discarded half the data on the basis of a claim in a token that had
  **expired three days earlier**. `codexPlanFromIdToken` is removed.
- **"The binding window blocks the call"** was fitted to a single observed refusal and then
  validated against that same refusal. Three selection rules have now been tried — newest-file,
  newest-event, binding-minimum — and all three were wrong. There is no fourth.

`pickGoverningRateLimits` → `summariseCodexRateLimits`, which reports the **range** across live
windows instead of inventing a winner, and the glance renders it as a spread (`5h 0-100% left`).
A range is uninformative by construction, which is the honest state of this data; a point
estimate reads as authoritative and is not. Nothing gates on the 5h figure.

As the project's own telemetry note said before any of this was built: *treat `rate_limits` as
advisory, not a budget oracle; the only reliable check that budget remains is to make a cheap
call — with the model you intend to run — and see whether it is served.*

## v0.7.1 — 2026-07-10

**Corrects two claims v0.7.0 got wrong, and makes `ultra` mean something.** Verified against
the `codex-rs` source at `rust-v0.144.1` and by live probe, not against prior notes.

- **`max` is a SERVER effort, not a CLI-side one.** `ReasoningEffort::as_str()` is documented
  "the exact value used on the wire" and emits `"max"`; nothing maps it down to `xhigh`. A
  live `-c model_reasoning_effort=max` call is served. **Only `ultra` is CLI-side:**
  `client.rs::reasoning_effort_for_request()` maps `Ultra => Max` before the request.
  (v0.7.0 claimed both were CLI-side and that the server enum stopped at `xhigh`.)
- **`ultra` was inert.** Its sole extra effect is `MultiAgentMode::Proactive`, which
  `effective_multi_agent_mode()` grants only when `multi_agent_version == V2` — i.e. only when
  the `multi_agent_v2` feature is enabled, and it ships **off**. With it off, `ultra` and `max`
  build **byte-identical requests**: every `prose`/`diff`/`advise` pass since v0.7.0 has in
  fact run at `max` with no delegation. This is the exact failure the Luna guard exists to
  prevent, on a gate the Luna guard never checked.
  - The wrapper now **enables `features.multi_agent_v2` for the invocation** when `ultra` is
    requested, and **exits 6 rather than silently downgrading** if it cannot.
  - `ultra` is now an **opt-in**. Per-mode defaults for `prose`/`diff`/`advise` are **`max`** —
    which is exactly what they were already sending. `Proactive` means the model is *permitted*
    to delegate, not that subagents ran; never report a fan-out you did not observe.
  - Read-only **is** inherited by spawned subagents (verified with a write canary), so `ultra`
    remains safe against the working tree.
- **`ai-budget` selects the governing window by limit identity, not by time.** Newest-by-
  timestamp was not a fix — `timestamp` records when a line was *written*, and a resumed session
  replays historical snapshots with fresh timestamps (observed 2026-07-10: five different window
  instances written within 5ms). The logs interleave genuinely different limits, and mixing them
  was the whole bug. `pickGoverningRateLimits()` now:
  - filters to `limit_id == "codex"` (per-model quotas like `codex_bengalfox` /
    *GPT-5.3-Codex-Spark* sit at ~0% used and would mask a drained general quota);
  - filters to the plan the CLI is **authenticated** as, read from the `id_token` claims
    (`codexPlanFromIdToken`). A stale `prolite` window at 100% used shares the directory with
    the live `pro` window at 80%; only the authenticated plan governs our calls. Selecting the
    minimum across plans reported **0% left while calls were being served**;
  - then takes the **binding** window: the highest `used_percent` among unexpired instances.
    Several windows are live at once for one plan — observed `codex`/`pro` carrying `used=29`
    and `used=100` simultaneously, each re-reported by the same 15 sessions. The question is
    not which window most sessions mention, it is which one **blocks the next call**. Any live
    window at 100% refuses it, however few snapshots name it.

  Within a fixed window `used_percent` only climbs and is never refunded — verified as **zero
  in-session decreases across 37 sessions**. (Apparent decreases when the logs are sorted
  globally are an artifact of interleaved writers, not evidence of a reservation-and-refund
  scheme.) So the maximum is simultaneously the latest reading and the conservative one.

  An intermediate version selected the window by *consensus* and then needed extra machinery to
  defend that choice — against vote ties, single-link bucket chaining, and unattributable
  votes. Codex found all three, running this wrapper against its own diff; all failed in the
  optimistic direction. The binding minimum makes the whole class unreachable: a spurious
  instance reporting a further-forward reset at 0% used is the most *generous* reading, so a
  minimum ignores it for free. The one thing the minimum genuinely needs is the attribution
  filter — without it, it latches onto the retired `prolite` plan's exhausted window.

  Residual, stated plainly: nothing attributes a window instance to a **model**, so when two
  live windows disagree we report the stricter. That errs toward caution and can under-report
  headroom for a cheaper model. `gpt-5.6-luna` was served while the general limit read 100%.

  Verified against behaviour: at `19% left` a Sol call is served; at `0% left` Sol is refused with
  *"You've hit your usage limit."* The figure tracks the general `codex` limit for the
  authenticated plan — the one that gates `gpt-5.6-sol`, the wrapper's model. **A cheap
  `gpt-5.6-luna` probe is NOT a proof of Sol capacity:** Luna was served while the general limit
  read 100% used. Probe with the model you intend to run. Still advisory.
- **`recentCodexSessionLines` no longer discards all Codex budget data** when a session file
  rotates mid-walk (`statSync` threw, the wrapping `catch` returned `[]`). It also pre-filters
  to rate-limit lines instead of reading whole transcripts into memory on a hot hook.
- **Luna guard is case-insensitive.** `gpt-5.6-LUNA:ultra` used to sail past it.
- `--doctor` reports whether `ultra` is actually available; `verify`'s default effort is listed.
- `test/run.sh` now runs the `ai-budget` node tests. It never did, so a green wrapper suite
  said nothing about the budget library.

## v0.7.0 — 2026-07-10

> **Superseded in part by v0.7.1.** The "both are CLI-side / the server enum stops at `xhigh`"
> claim below is **wrong** for `max`, and the `ultra` default described below sent exactly the
> same request as `max` because `multi_agent_v2` ships off. Retained as the record of what this
> release did; read it with v0.7.1's corrections.

**GPT-5.6 (Sol / Terra / Luna).** OpenAI broadly released GPT-5.6 on 2026-07-09; Codex CLI
`0.143.0` added the models plus two reasoning tiers above `xhigh`. Tested against `0.144.1`.

- `--effort` now accepts **`max`** and **`ultra`**. Both are **CLI-side** tiers: the server's
  `reasoning.effort` enum is still `none|minimal|low|medium|high|xhigh`, and an unknown value
  is forwarded straight to a 400 — so `VALID_EFFORTS` stays an explicit allowlist.
  `ultra` = maximum reasoning **plus automatic delegation to concurrent subagents**;
  `max` = maximum depth, single agent, no fan-out.
- **Per-mode default efforts** replace the flat `high`: `prose`/`diff`/`advise` → `ultra`,
  `judge` → `xhigh` (strict single JSON array over N items; fan-out multiplies per item and
  adds output variance where malformed JSON is fatal), `scout` → `low` (cheap targeting is
  the mode's entire purpose; Sol's own `default_reasoning_level` is `low`).
- **`-m` is now always passed**, defaulting to `gpt-5.6-sol`. `~/.codex/config.toml` is
  rewritten by other Codex clients (the ChatGPT.app Codex), so an inherited model made a
  review silently non-reproducible.
- **Luna + `ultra` is refused.** Luna advertises `low..max` and no `ultra`, but the CLI
  accepts `--effort ultra` on Luna *without erroring* — a silent downgrade indistinguishable
  from a real ultra run. Exit 2 with a message rather than a false sense of delegation.
- `--doctor` now reports the default model, the valid efforts, and each mode's default effort.
- **`ai-budget`: select the freshest rate-limit EVENT, not the newest session FILE.**
  Concurrent Codex sessions (ChatGPT.app + CLI) report different rolling-window instances
  with different `resets_at`; picking the newest file read whichever session flushed last.
  On 2026-07-10 that reported "17% left" against a window snapshot showing 100% used.
  `pickFreshestRateLimits()` orders by each line's own `timestamp`.
  *Caveat:* Codex rate-limit telemetry carries several concurrent window snapshots whose
  `used_percent` disagree wildly at the same instant. Treat it as advisory — the only
  reliable check that budget remains is whether a call is actually served.


## v0.6.0 — 2026-06-28

**`--mode judge`** — the structured-judging offload primitive. Every token-heavy
LLM-judge loop (factual audit, too-easy/augment, acronym-decode, premortem) can now
spend Codex's budget instead of Claude's: feed a worklist + rubric (`--focus`) +
output shape (`--schema`), Codex judges each item — reading `--repo` READ-ONLY to
verify claims against the real source — and returns ONE validated JSON array a
downstream record/apply step can consume directly.

- `JUDGE_FRAMING` demands strict per-item JSON (one object per input item, same
  order, carrying the id; uncertainty recorded, never dropped/reordered).
- Output is extracted + validated: strips a ```json fence / surrounding prose,
  slices the outermost JSON value, re-emits it COMPACT. Non-JSON ⇒ exit 4 with the
  raw response on stderr — a machine consumer never gets fed prose.
- `--schema PATH` embeds the required verdict shape; `--repo` gives read-only
  source context to verify against (default: no codebase context).
- +10 stubbed tests (prompt assembly, strict-fail→4, fenced/prose-wrapped JSON
  extraction, empty-worklist→2). 42/42 green.
- Exercised live on real Codex against 2 user-flagged md3 cards: it read the source
  read-only and independently caught a card flag that rested on a cow's-milk-protein
  vs lactose-intolerance conceptual conflation (ruled keep-as-is, high confidence).

## v0.5.1 — 2026-06-28

Budget-snapshot **disambiguation + actionable verdict** — after a reader (a model)
misread `week 9%` as 9%-*spent* when it meant 9%-*remaining*, because the bare
percentage sat next to the `spent …` token column.

- **Percentages now render as `N% left`** (both `5h` and `week`), and the consumed
  column is labelled `used …` — so remaining can't be confused with spent.
- **Inline `⚠`** on the *constraining* weekly window (`week 9% left ⚠`); the healthy
  provider gets none. 5h-low never gets it (use-it-or-lose-it, not a problem).
- **`formatSnapshot` (the once-per-session glance) now carries the verdict** that
  was previously only in the pre-big-op gate: *which* provider is the bottleneck,
  its remaining headroom, the trend, and *where to offload* — e.g. "Claude is the
  constraint — 9% week left, on track to run dry before reset. Codex has 91% left
  — route heavy/parallel work there." Don't make the reader infer the conclusion.
- **Refactor:** new shared `weeklyIsConstraining()` predicate + `routingAdvice()`
  sentence, used by *both* the glance and the gate so they never disagree.
- **Tests:** +7 (label/marker/verdict regression on the exact 9%/91% state,
  `routingAdvice`, `weeklyIsConstraining`). 47/47 green.

## v0.5.0 — 2026-06-27

- **`--mode scout`** on the wrapper: read-only reconnaissance that returns a *compressed target
  map* (relevant files + line-ranges, start order, load-bearing gotchas, what to skip) for a
  downstream agent — so codebase exploration spends Codex's budget instead of Claude's. Roots
  Codex in `--repo` (default: cwd); task on stdin or `--file`. Same read-only sandbox and
  version-drift hardening as the other modes. A third role alongside reviewer/advisor — about
  *who pays for exploration*, not diversity of thought.
- **diff-mode performance fix:** replace the bash `${RAW//[…]/}` whitespace strip (pathologically
  O(n²) on bash 3.2 — pins a CPU for minutes on large diffs) with a `grep` here-string emptiness
  check (and a note on why a pipe would false-negative under `pipefail`).
- **Tests:** add a stubbed `--mode scout` happy-path check (framing + task carried into the prompt).

## v0.4.0 — 2026-06-24

Adds **budget awareness** — live rate-limit visibility for both Codex and Claude
inside every Claude Code session.

- **`bin/ai-budget-lib.mjs`** — pure parsing and formatting library:
  `parseCodexRateLimits` (from Codex session `.jsonl`),
  `parseClaudeUsageWindows` (from the `/api/oauth/usage` response),
  `sumClaudeTranscriptTokens` (local transcript tally, today and 7 days),
  `formatSnapshot`, `formatIfBelow`, `lowestPct`, `readState`.
- **`bin/ai-budget.mjs`** — CLI with three sub-commands:
  `refresh` (read all sources, atomic-write `~/.claude/.cache/ai-budget.json`),
  `read` (print both providers + age), `if-below <pct>` (conditional warning
  with routing hint). Silent on a missing state file; never throws into a session.
- **launchd LaunchAgent** (`com.codex-adversary.ai-budget.plist.template`) —
  refreshes the state file every 60 seconds so hooks always see current data.
- **Three hooks** in `~/.claude/settings.json` — `SessionStart` (refresh),
  `UserPromptSubmit` and `PreToolUse` (if-below 30%) — installed by `install.sh`.
- **`skills/budget-aware-allocation/SKILL.md`** — the behavioural half: how
  Claude routes work when the budget hooks fire (prefer Codex when Claude is
  constrained, stay lean before a big spend, flag when both are low).
- **Tests** — 11 unit checks covering every parser, formatter, and `readState`
  (including missing-file and garbage-JSON paths).

## v0.3.1 — 2026-06-24

- Add **AGENTS.md**: an orientation + maintenance brief written for the *agent* working on a
  fork — how to check compatibility, tune the framing/synthesis, dogfood changes with the tool
  itself, and keep tests honest — plus the project's agent-first, self-maintaining-forks
  philosophy.

## v0.3.0 — 2026-06-24

Resilience to Codex CLI version drift, instead of silently breaking when a flag changes.

- Preflight parses `codex exec --help`: hardening flags the installed build lacks
  (`--ephemeral`, `--ignore-rules`, `--skip-git-repo-check`) are dropped with a note; a
  missing `codex exec` or `--output-last-message` fails with a clear **exit 6** pointing at
  MAINTENANCE.md, not an opaque "Codex failed".
- New **`--doctor`**: reports Codex version, `codex exec` availability, and per-flag
  compatibility.
- New **MAINTENANCE.md** mapping every Codex-surface dependency, its failure mode, and the
  fix (including a `--json` capture fallback to implement if `--output-last-message` is ever
  removed).
- Tests cover version-drift adaptation and `--doctor` (28 checks total).

## v0.2.1 — 2026-06-24

Sharper review prompts so Codex pushes back on **logic/correctness**, not style. The
framing now explicitly forbids style / formatting / naming / lint / "consider…" nits,
orders findings by severity, prefers one deep bug over ten shallow ones, and answers
"nothing substantive" in one line instead of padding. Addresses the common complaint that
a second model returns superficial nitpicking rather than real pushback. The synthesis
contract gains a "triage hard for substance" rule.

## v0.2.0 — 2026-06-24

Adds the **advisor** role — a prospective second opinion, alongside the retrospective review.

- **`--mode advise`** on the wrapper: pipe a decision + context, get options / tradeoffs /
  missed risks / a recommendation; `--repo .` gives Codex read-only codebase context.
- **`codex-advisor` skill + `/codex-advisor` command**: consult Codex *before* acting at a
  consequential, genuinely-uncertain fork, then weigh the advice and decide (Claude has lead;
  high trigger bar; Codex is a different model, not a bigger one).
- `install.sh` / `uninstall.sh` now install/remove all skills and commands (not just one).

## v0.1.0 — 2026-06-24

First release: recruit Codex as a read-only adversarial reviewer inside Claude Code.

- **`bin/codex-adversary.sh`** — prose and diff modes; clean capture via
  `--output-last-message`; per-pass `--effort`; hardening flags (`--ephemeral`,
  `--ignore-rules`, `--skip-git-repo-check`); process-group timeout kill so Codex's
  child processes are not orphaned; untracked-file inclusion in diff mode;
  large-artifact (~400 KB) warning.
- **`adversarial-review` skill** — Claude-has-lead synthesis contract with a one-round
  rebuttal, an asymmetric-veto guard for Claude's own blind spots, and honest
  correlated-reviewer / single-sample / context-window limitations.
- **`/adversarial-review`** command.
- **`install.sh` / `uninstall.sh`** — ownership-stamped skill (won't clobber a foreign
  one), atomic swap, paired-marker directive that upgrades in place and removes cleanly.
- **Tests + CI** — a stubbed-`codex` suite (`test/run.sh`) plus `bash -n` and shellcheck.
