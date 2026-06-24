---
name: adversarial-review
description: Use when doing any substantive adversarial / red-team / referee / "second set of eyes" / critical-review pass — on code (a diff or PR) OR on prose (a manuscript, a research claim, an argument, a milestone doc). Runs Codex as an independent second model alongside Claude's own review agents, then synthesizes both for diversity of thought. Do NOT use for trivial one-line checks.
---

# Adversarial review with Codex + Claude

An adversarial pass is not "one model's opinion." Run **two independent models** —
your own Claude review agent(s) **and** Codex (via your local Codex CLI) — then
**synthesize** them. Two architectures catch different failure modes; agreement is
signal, disagreement is where the lead (Claude) decides.

## The pattern

1. **Identify the artifact** — a git diff, a file, a manuscript section, a claim,
   an argument. Decide `--mode diff` (code/changes) vs `--mode prose` (everything else).
2. **Run Claude's own adversarial review** as you normally would (dispatch lens
   agents, or review directly for small artifacts). Don't skip this — Codex
   *adds* diversity, it doesn't replace your own critique.
3. **In parallel, run Codex** via the wrapper:
   ```bash
   # prose / argument / claim:
   cat draft.md | ~/.claude/bin/codex-adversary.sh --mode prose --effort <high|xhigh> \
       --focus "<optional steer, e.g. 'scrutinise the AUC claim and its denominator'>"

   # code / changes (Codex reads the repo + diff itself, read-only):
   ~/.claude/bin/codex-adversary.sh --mode diff --effort <high|xhigh> --repo "$(pwd)"
   ~/.claude/bin/codex-adversary.sh --mode diff --base main           # vs a base branch
   ```
   Codex is **read-only** — it cannot modify files. Safe in any repo, including
   commit-gated (md3) or shared multi-agent trees.
4. **Synthesize** (below). Never just paste Codex's output — reconcile it.

Prefer running step 2 and step 3 concurrently (a Claude agent + a Bash call to
the wrapper) so the pass doesn't serialize. A clean way is one Workflow with the
Claude lenses as `agent()` stages and one stage that runs the wrapper via Bash.

## Choosing Codex effort per-pass (you decide; pass via `--effort`)

The script defaults to `high`. Override per-artifact on **stakes × subtlety × length**:

- **`xhigh`** — high stakes or subtle reasoning. Pre-submission / pre-merge final
  passes; statistical or methodological claims; ethics / regulatory / HREC wording;
  security-sensitive diffs; arguments where being wrong is costly; anything you'd
  want a careful journal referee on. **When torn between high and xhigh on something
  you will submit or ship, choose xhigh.**
- **`high`** (default) — routine review passes: moderate diffs, prose polish,
  day-to-day critique, sanity-checking a section.
- **`medium` / `low`** — rarely worth it for an adversarial pass; only for a quick
  mechanical check where extra reasoning adds nothing.

`xhigh` is slower (a few minutes on a large artifact). That's the right trade for a
final referee pass; not for a quick gut-check.

## Synthesis contract (the actual value)

Reconcile the two reviews — do not concatenate. **Claude has lead:** you recruited Codex
for diversity of thought, but you are the senior reviewer and you make the call. Codex's
findings are inputs you weigh — never capitulate to them, never rubber-stamp them.

- **Tag each finding by source** — which Claude lens raised it, or Codex.
- **Agreements (both models) → high-confidence.** Surface these first.
- **Codex-only findings → adjudicate with your own assessment**: agree / disagree /
  uncertain, with a one-line reason. Never rubber-stamp Codex; never silently drop it.
- **Factual disagreement on a material point → run ONE rebuttal round (adjudication,
  not persuasion).** Give the other model the specific counter-evidence — paste the repo
  lines that back a claim it called "unverifiable", or your reasoning for dismissing a
  finding — and ask it to **withdraw** (if the evidence genuinely refutes it) or **hold
  and sharpen its reason**. Run at `--effort xhigh`. Evidence flows both ways, but the
  decision is yours. Cap at one round (two for high-stakes). Outcomes:
  - **Withdraws** → resolved; drop it, noting it was triangulated.
  - **Holds and sharpens** → often the real finding (e.g. "the backing exists in the repo,
    but the shipped page doesn't show it" → a transparency gap, not a missing
    justification). Act on it; or if it's material and you genuinely can't adjudicate it,
    put it to the human.
  - **Holds but only repeats** → weak; note the residual and move on.
- **Matters of taste → your call.** Tone, framing, styling, severity, and judgment calls
  where reasonable reviewers differ belong to the lead. Record Codex's dissent in a line,
  decide, move on — don't escalate taste to the human and don't loop on it.
- **Take something to the human only when** it is material AND you genuinely cannot
  adjudicate it yourself — not merely because the two models disagree.
- **Beware false consensus.** LLMs capitulate when told the other model disagrees, so the
  rebuttal prompt must say plainly: *do not concede merely to agree; withdraw only if the
  new evidence actually refutes the point.* Weight "held-and-sharpened" over
  "withdrew-immediately".
- Hold to a journal-referee / senior-engineer bar — the point is to catch what one
  model alone would miss, not to manufacture consensus.

## Graceful degradation

If the wrapper exits non-zero (Codex missing, unauthed, timeout, empty), **proceed
with the Claude-only review and state plainly that Codex was unavailable** — never
block or fail the pass. Exit codes: `3` = codex not installed, `4` = no output
(auth/timeout), `2` = usage error.
