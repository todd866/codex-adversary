# codex-adversary

Recruit **Codex (GPT)** as an automatic adversarial reviewer inside **Claude Code**.

When Claude runs a review or red-team pass, it usually reviews with itself. This setup
makes Claude also recruit Codex as an independent second model on the same artifact, then
reconcile the two. Two different model architectures catch different failure modes:
agreement is a confidence signal, and disagreement is where the lead looks harder. You get
diversity of thought instead of one model's blind spots.

It works on **code** (a diff or PR) and on **prose** (a manuscript, a research claim, an
argument, a design doc).

## Claude has lead

Codex is a *recruited second opinion*, not a co-equal judge. Claude orchestrates the pass,
weighs Codex's findings, and makes the final call. It never rubber-stamps Codex and never
capitulates to it. Matters of taste (tone, framing, severity) are Claude's to decide. A
disagreement only goes to you, the human, when it is material and Claude genuinely cannot
adjudicate it — not just because the two models differ.

## How it works

Three small pieces, plus an installer:

| Piece | Role |
|-------|------|
| `bin/codex-adversary.sh` | Runs Codex **read-only** as a reviewer and prints only its findings (clean capture via `codex exec --output-last-message`). Modes: `--mode prose` (content on stdin/`--file`) and `--mode diff` (Codex reads the repo + diff itself). |
| `skills/adversarial-review/SKILL.md` | The pattern Claude follows: run its own review **and** Codex, then synthesize. Auto-activates on review/red-team/second-eyes passes. |
| `commands/adversarial-review.md` | A `/adversarial-review [target]` slash command for explicit one-shot use. |
| `CLAUDE-directive.md` | A short directive (installed into `~/.claude/CLAUDE.md`) that makes the skill fire automatically. |

### The synthesis contract

Claude reconciles the two reviews rather than concatenating them:

- **Both models agree** → high-confidence, surfaced first.
- **Codex-only finding** → Claude adjudicates it with its own assessment (agree / disagree / uncertain).
- **Factual disagreement** → one **rebuttal round**: the other model is handed the specific counter-evidence and asked to *withdraw* or *hold and sharpen* (explicitly told not to concede just to agree, since LLMs tend to capitulate). A finding that survives, or sharpens under, evidence exchange is often the real one.
- **Matters of taste** → the lead's call.

### Per-pass reasoning effort

Claude chooses Codex's effort by stakes: `high` for routine passes, `xhigh` for high-stakes
or subtle artifacts (final pre-merge / pre-submission passes, statistical or security-
sensitive material).

## Requirements

- [Claude Code](https://claude.com/claude-code)
- [Codex CLI](https://github.com/openai/codex), installed and authenticated (`codex login`).
  It runs on whatever account/model your Codex CLI is configured with.

## Install

```bash
git clone https://github.com/todd866/codex-adversary
cd codex-adversary
./install.sh
```

The installer copies the wrapper, skill, and command into `~/.claude/`, and appends the
auto-trigger directive to `~/.claude/CLAUDE.md` (idempotently). Start a new Claude Code
session to pick up the skill.

To install into a non-default location: `CLAUDE_HOME=/path/to/.claude ./install.sh`.

## Usage

- **Automatic:** when Claude runs a substantive review/red-team pass, it recruits Codex and synthesizes. Nothing to type.
- **Explicit:** `/adversarial-review <file, diff, or claim>`.
- **Standalone (any shell):**
  ```bash
  # prose
  cat draft.md | ~/.claude/bin/codex-adversary.sh --mode prose --effort xhigh \
      --focus "scrutinise the statistical claims"
  # code (uncommitted changes, or vs a base branch)
  ~/.claude/bin/codex-adversary.sh --mode diff
  ~/.claude/bin/codex-adversary.sh --mode diff --base main
  ```

## Safety

- Codex always runs with `--sandbox read-only`. It can read files (and, in diff mode, the
  repo) but cannot modify anything. Safe to run in any repository, including commit-gated
  or shared working trees.
- If Codex is missing, unauthenticated, or times out, the wrapper exits non-zero and Claude
  proceeds with its own review, noting that Codex was unavailable. The pass is never blocked.

## License

MIT © Ian Todd. Built with Claude Code.
