# Changelog

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
