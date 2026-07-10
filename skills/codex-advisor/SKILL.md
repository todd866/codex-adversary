---
name: codex-advisor
description: Use BEFORE acting, when you hit a consequential AND genuinely-uncertain fork mid-task — a hard-to-reverse design/architecture choice, an ambiguous spec where guessing wrong wastes real work, a risky/irreversible step (migration, destructive op, release), or a low-confidence domain. Consults Codex (a second model) for a second opinion on the decision, which you then weigh and decide. Do NOT use for routine or low-stakes choices.
---

# Consult Codex as an advisor (a second opinion before acting)

This is the *prospective* counterpart to `adversarial-review`: that skill critiques finished
work; this one gets a second model's perspective on a decision you are **about to make**.

**Codex advises; you decide — Claude has lead.** Codex is a second model from a different
vendor: a different *perspective*, not a smarter or "bigger" oracle (both are correlated
LLMs). Use it to surface options and risks you might miss — never to outsource the call.

## When to consult (keep the bar high)

Consult before a decision that is **consequential AND genuinely uncertain**:

- a design / architecture choice that is hard to reverse later;
- an ambiguous spec or requirement where guessing wrong wastes significant work;
- a risky or irreversible step — a data migration, a destructive operation, a public
  release, a schema change;
- a domain where your confidence is low and a wrong approach is costly;
- a real "A vs B" where the stakes justify a second opinion.

Do **not** consult for routine coding, choices you're confident about, trivia, or as a way to
avoid deciding. Over-consulting adds latency and noise and encourages deferral.

## How

Put the decision **and the relevant context** on stdin; add `--repo .` to give Codex
read-only access to the codebase; `--focus` the precise question:

```bash
printf '%s' "$DECISION_AND_CONTEXT" | ~/.claude/bin/codex-adversary.sh --mode advise \
    --repo . --focus "Which approach, and what am I missing?"
```

Give it enough to be useful: what you're trying to do, the options you see, the constraints,
and your current leaning. `advise` defaults to **`gpt-5.6-sol` at `--effort max`** — the
deepest reasoning the server offers, and the right tier for a consequential fork. Drop to
`high` under budget pressure. `--effort ultra` additionally lets Codex fan out to subagents;
it is an opt-in, worth it only when the decision genuinely decomposes into parts that can be
weighed independently. Codex returns: the decision restated, the main options, tradeoffs, the
risks you're likely missing, and a recommendation.

## Using the advice (Claude has lead)

- **Weigh, don't defer.** You decide. State briefly what you took from the advice and what you
  set aside, and why.
- **Don't blindly follow it** — it's a correlated second model, not ground truth. If it flags
  a risk you can check, check it (run it, read the code) rather than trusting the claim.
- **If it surfaces something that would make your plan a mistake, that's the win** — fold it in
  before you act.
- **If Codex is unavailable** (the wrapper exits non-zero), proceed on your own judgment and
  note that the second opinion wasn't available. Never block on it.

Same content caveat as the review side: the decision and context are **sent to your Codex/model
provider** — don't include secrets or regulated/embargoed material.
