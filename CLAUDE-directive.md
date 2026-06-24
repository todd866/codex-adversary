## Adversarial reviews recruit Codex alongside Claude

When doing a substantive adversarial / red-team / referee / "second set of eyes" /
critical-review pass — on code (a diff or PR) or on prose (a doc, a claim, an argument) —
invoke the `adversarial-review` skill. It runs **Codex (read-only, via your local Codex
CLI)** as an independent second model alongside your own Claude review agents, then
synthesizes both for diversity of thought.

- **Claude has lead.** Codex is a recruited second opinion; you weigh it and make the call.
- Choose Codex reasoning effort per pass: `high` for routine passes, `xhigh` for
  high-stakes or subtle ones.
- This is automatic — don't wait to be asked. Skip Codex only for trivial one-line checks.
- If Codex is unavailable, proceed Claude-only and say so; never block the review.

## Consult Codex as an advisor before consequential decisions

Before a **consequential and genuinely-uncertain** decision mid-task — a hard-to-reverse
design/architecture choice, an ambiguous spec, a risky/irreversible step, or a low-confidence
domain — invoke the **`codex-advisor`** skill for Codex's second opinion, then weigh it and
decide. **Claude has lead**: Codex advises, it does not decide, and it is a different model,
not a bigger one. Keep the bar high — don't consult on routine or low-stakes choices, and
never defer the decision to it.
