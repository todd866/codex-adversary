# Changelog

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
