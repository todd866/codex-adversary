---
name: adversarial-review
description: Use when doing any substantive adversarial / red-team / referee / "second set of eyes" / critical-review pass — on code (a diff or PR) OR on prose (a manuscript, a research claim, an argument, a milestone doc). Runs Codex as an independent second model alongside Claude's own review agents, then synthesizes both for diversity of thought. Do NOT use for trivial one-line checks.
---

# Adversarial review with Codex + Claude

An adversarial pass is not "one model's opinion." Run **two models from different
vendors** — your own Claude review agent(s) **and** Codex (via your local Codex CLI) —
then **synthesize** them. They catch different failure modes; agreement raises confidence,
disagreement is where the lead (Claude) decides. (Both are transformer LLMs trained on
overlapping data, so their errors are *correlated*: agreement reduces stochastic misses but
does NOT clear shared blind spots — for anything safety/correctness-critical, add a non-LLM
check.)

## The pattern

1. **Identify the artifact** — a git diff, a file, a manuscript section, a claim,
   an argument. Decide `--mode diff` (code/changes) vs `--mode prose` (everything else).
2. **Run Claude's own adversarial review** as you normally would (dispatch lens
   agents, or review directly for small artifacts). Don't skip this — Codex
   *adds* diversity, it doesn't replace your own critique.
3. **In parallel, run Codex** via the wrapper:
   ```bash
   # prose / argument / claim:
   cat draft.md | ~/.claude/bin/codex-adversary.sh --mode prose \
       --focus "<optional steer, e.g. 'scrutinise the AUC claim and its denominator'>"
   # (defaults to gpt-5.6-sol at --effort max; add --effort ultra to opt into fan-out)

   # code / changes (Codex reads the repo + diff itself, read-only):
   ~/.claude/bin/codex-adversary.sh --mode diff --repo "$(pwd)"
   ~/.claude/bin/codex-adversary.sh --mode diff --base main           # vs a base branch
   ```
   Codex is **read-only** — it cannot modify files, so it is safe against any working
   tree. But the reviewed content is **sent to your Codex/model provider**: do not point
   it at secrets, patient/regulated data, or embargoed material.
4. **Synthesize** (below). Never just paste Codex's output — reconcile it.

Prefer running step 2 and step 3 concurrently (a Claude agent + a Bash call to
the wrapper) so the pass doesn't serialize. A clean way is one Workflow with the
Claude lenses as `agent()` stages and one stage that runs the wrapper via Bash.

Large artifacts: the wrapper warns above ~400 KB but does not chunk. For a big diff or
manuscript, split it (by file, by section) and run the pass per chunk — otherwise Codex
may review it only partially, with no error.

## Model and effort (GPT-5.6 era)

Codex runs **`gpt-5.6-sol`** — the frontier agentic-coding model — and the wrapper always
passes it explicitly (`-m`). Never rely on `~/.codex/config.toml`: other Codex clients (the
ChatGPT.app Codex) rewrite it, so an inherited model makes a review non-reproducible.

Two effort names sit **above** `xhigh`, and they are not the same kind of thing:

- **`max` is a real server effort.** It goes on the wire verbatim (`ReasoningEffort::as_str()`
  is documented "the exact value used on the wire"). It is the deepest reasoning Codex offers.
- **`ultra` is CLI-side only.** `client.rs` maps `Ultra => Max` before the request, so the
  wire sees `max` either way. The *only* thing `ultra` adds is `MultiAgentMode::Proactive`,
  which permits the model to delegate to concurrent subagents — and that mode is granted
  **only when the `multi_agent_v2` feature is enabled**, which ships off.

With that feature off, `ultra` and `max` build **byte-identical requests**. So the wrapper
enables `multi_agent_v2` for the invocation whenever you ask for `ultra`, and **refuses with
exit 6 if it cannot** — `ultra` never silently means `max`.

| Effort | What it is | Use when |
|---|---|---|
| **`max`** | The deepest **server** reasoning; single agent, no fan-out | **The default** for `prose` / `diff` / `advise`. This is what every pass was already getting. |
| **`ultra`** | `max` on the wire, **plus permission to fan out to subagents** | An explicit opt-in for a hard, *divisible* target where you want breadth: a large diff across many files, a long manuscript. Costs more; see below. |
| **`xhigh`** | Extra-high depth | **The default for `judge`.** Batch judging must emit one strict JSON array; extra depth adds output variance exactly where malformed JSON is fatal. |
| **`high`** | Solid depth | **The default for `verify`.** Source-fidelity checking is retrieval, not reasoning — a deeper tier does not make `grep` more accurate. |
| **`medium`** | Everyday depth | Deliberate downgrade under budget pressure, or a large batch where `xhigh` is overkill. |
| **`low`** | Fast, light reasoning | **The default for `scout`.** Recon exists to spend little and hand a downstream agent a target map. (Sol's own `default_reasoning_level` is `low`.) |

**`ultra` is an opt-in, not a standing preference.** Reach for it when the target genuinely
decomposes and breadth is what you lack. Three cautions, all real:

- **`Proactive` means the model is *permitted* to delegate, not that subagents ran.** Never
  report an `ultra` pass as "N agents reviewed it" unless you saw them.
- **Fan-out multiplies tokens** and engages an orchestration layer Codex still marks *under
  development*. More findings is not the same as more true findings.
- **The subagents are the same model**, so their errors correlate. A fan-out that "agrees
  with itself" is weak evidence, not consensus. (Read-only *is* inherited by subagents —
  verified with a write canary — so `ultra` remains safe against your working tree.)

**Luna (`gpt-5.6-luna`) does not support `ultra`.** The CLI accepts `--effort ultra` on Luna
*without erroring*, so a silent downgrade is indistinguishable from a real ultra run — the
wrapper therefore **refuses** the combination rather than let you believe you got delegation
you never got. Use `--effort max` on Luna, or switch to Sol.

## Synthesis contract (the actual value)

Reconcile the two reviews — do not concatenate. **Claude has lead:** you recruited Codex
for diversity of thought, but you are the senior reviewer and you make the call. Codex's
findings are inputs you weigh — never capitulate to them, never rubber-stamp them.

- **Tag each finding by source** — which Claude lens raised it, or Codex.
- **Agreements (both models) → high-confidence.** Surface these first.
- **Codex-only findings → adjudicate with your own assessment**: agree / disagree /
  uncertain, with a one-line reason. Never rubber-stamp Codex; never silently drop it.
- **Triage hard for substance.** Codex (like most LLMs in review mode) tends to over-produce
  minor, defensive nits to look thorough. The wrapper's framing suppresses style/lint/cosmetic
  comments — drop any that still slip through, and weight one deep correctness/logic finding
  over a long list of shallow ones. A wall of nitpicks with no real issue means "nothing
  substantive found", not "lots of problems".
- **Factual disagreement on a material point → run ONE rebuttal round (adjudication,
  not persuasion).** Give the other model the specific counter-evidence — paste the repo
  lines that back a claim it called "unverifiable", or your reasoning for dismissing a
  finding — and ask it to **withdraw** (if the evidence genuinely refutes it) or **hold
  and sharpen its reason**. Run at `--effort max`. Evidence flows both ways, but the
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
- **Asymmetric veto — guard your own blind spots.** If a Codex finding would, *if true*,
  indicate an error in your OWN prior reasoning or output, do NOT dismiss it on your own
  authority; that is precisely the case you are least equipped to judge. Verify it with a
  non-LLM check (run it, grep it, recompute) or put it to the human — regardless of your
  confidence. Never retire a substantive correctness finding by reclassifying it as "taste."
- **Weigh the sampling asymmetry.** You run several lenses; Codex runs one pass. So "Codex
  didn't raise it" is weak evidence, and "both agree" partly reflects a single low-variance
  sample — don't over-read one Codex pass as a full second opinion.
- **Beware false consensus.** LLMs capitulate when told the other model disagrees, so the
  rebuttal prompt must say plainly: *do not concede merely to agree; withdraw only if the
  new evidence actually refutes the point.* Weight "held-and-sharpened" over
  "withdrew-immediately".
- Hold to a journal-referee / senior-engineer bar — the point is to catch what one
  model alone would miss, not to manufacture consensus.

## Graceful degradation

If the wrapper exits non-zero (Codex missing, unauthed, timeout, empty), **proceed
with the Claude-only review and state plainly that Codex was unavailable** — never
block or fail the pass. Exit codes: `2` = usage error, `3` = Codex not installed,
`4` = Codex failed / empty output, `5` = timed out.
