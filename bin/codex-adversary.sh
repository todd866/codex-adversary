#!/usr/bin/env bash
#
# codex-adversary.sh — run Codex (your configured model) READ-ONLY as a second
# model — adversarial reviewer, advisor, scout, or batch judge — and print ONLY
# its output to stdout.
#
# This is the primitive behind the `adversarial-review` skill (review/advise) and
# the budget-offload path (scout/judge): a second model from a different vendor
# catches errors a single reviewer's blind spots would miss, AND — for judge mode —
# lets a token-heavy judging pass spend Codex's budget instead of Claude's.
#
# SAFETY: --sandbox read-only means Codex cannot WRITE your files. It can still
# READ them, and the content you review is SENT to your configured Codex/model
# provider. Do NOT review secrets, patient/regulated data, or embargoed material
# you cannot share with that provider. The wrapper also passes --ephemeral (don't
# persist the prompt) and --ignore-rules (don't load an untrusted repo's rule
# files), but it cannot stop a determined prompt-injection in the reviewed
# content — treat Codex's output as advice, not ground truth.
#
# USAGE
#   # Prose / argument / claim (content on stdin or via --file):
#   echo "<draft text>" | codex-adversary.sh --mode prose --effort xhigh \
#       --focus "Is the stats claim in para 3 defensible?"
#   codex-adversary.sh --mode prose --file draft.md
#
#   # Code / diff (Codex reads the repo + the diff itself):
#   codex-adversary.sh --mode diff --effort high              # uncommitted changes
#   codex-adversary.sh --mode diff --base main --repo /path/to/repo
#
#   # Advise — a second opinion on a decision, BEFORE acting (--repo adds context):
#   echo "<the decision + context>" | codex-adversary.sh --mode advise --repo . \
#       --focus "Which migration strategy, and what am I missing?"
#
#   # Scout — read-only recon of a codebase that returns a COMPRESSED target map
#   # for a downstream agent (cheap targeting instead of expensive exploration):
#   echo "where is rate-limit handling, and what calls it?" | \
#       codex-adversary.sh --mode scout --repo .
#
#   # Judge — OFFLOAD a batch LLM-judge loop to Codex: feed a worklist + rubric +
#   # output shape, Codex judges each item (reading --repo read-only to verify) and
#   # returns ONE validated JSON array for a downstream record/apply step. This is
#   # how a token-heavy judging pass spends Codex's budget instead of Claude's.
#   codex-adversary.sh --mode judge --file worklist.json --schema shape.json \
#       --repo . --focus "Is each cloze too easy for a Year-3 student?" > verdicts.json
#
# OPTIONS
#   --mode   prose|diff|advise|scout|judge|verify  prose/diff = adversarial review;
#                            advise = counsel on a decision before acting; scout =
#                            read-only recon returning a compressed target map; judge =
#                            structured batch judging that returns validated JSON;
#                            verify = SOURCE-FIDELITY ONLY — check every quotation,
#                            attribution, DOI and number against the primary sources on
#                            disk, and nothing else. Default: prose.
#   --effort low|medium|high|xhigh|max|ultra
#                            Codex reasoning effort. `max` is a real SERVER effort (it
#                            goes on the wire verbatim). `ultra` is the only CLI-side
#                            tier: the CLI maps it to `max` on the wire and, IF the
#                            `multi_agent_v2` feature is on, additionally sets
#                            MultiAgentMode::Proactive so the model may delegate to
#                            concurrent subagents. This wrapper turns that feature on
#                            for the invocation, and REFUSES if it cannot — `ultra`
#                            never silently means `max`.
#                            Default is PER-MODE: prose/diff/advise=max, judge=xhigh,
#                            verify=high, scout=low. (Claude picks this per-pass; see
#                            the skill rubric.) Luna has no `ultra` and is REFUSED
#                            rather than silently downgraded.
#   --focus  "..."           Optional extra instruction / the specific question / the
#                            (judge) rubric for the pass.
#   --file   PATH            (prose/advise/scout/judge) Read content/worklist from PATH
#                            instead of stdin.
#   --schema PATH            (judge) Read the required JSON output shape from PATH and
#                            instruct Codex to conform every verdict object to it.
#   --base   BRANCH          (diff) Review changes vs BRANCH instead of uncommitted.
#   --repo   DIR             (diff) repo to diff; (advise/scout/judge) codebase given to
#                            Codex as read-only context. Default: current directory.
#   --model  NAME            Override Codex model. Default: gpt-5.6-sol, ALWAYS passed
#                            explicitly — ~/.codex/config.toml is mutated by other Codex
#                            clients, so inheriting it makes a review non-reproducible.
#   --timeout SECS           Hard cap on the Codex call. Default: 600.
#   --doctor                 Check Codex availability + flag compatibility, then exit.
#   -h|--help                Show this help.
#
# EXIT CODES
#   0  Codex ran and produced a response (printed to stdout).
#   2  Usage error.
#   3  Codex CLI not found.
#   4  Codex failed / produced no output (auth, crash, empty) — see stderr.
#   5  Codex timed out before producing output — see stderr.
#   6  Codex CLI incompatible (no 'codex exec', no --output-last-message, or --effort
#      ultra requested on a build that will not enable multi_agent_v2) — see stderr.
#
set -uo pipefail

MODE="prose"
EFFORT=""            # empty => resolve a per-mode default after parsing
EFFORT_SET=0
FOCUS=""
FILE=""
SCHEMA=""
BASE=""
REPO="$(pwd)"
REPO_EXPLICIT=0
MODEL=""
TIMEOUT="600"
DOCTOR=0

# GPT-5.6 era. Sol is the frontier agentic-coding model; Terra is the balanced
# everyday model; Luna is the fast/cheap one.
#
# EFFORT, precisely (codex-rs @ 0.144.1 — verified in source and by live probe):
#   * `max` is a SERVER effort. `ReasoningEffort::as_str()` is documented "the exact
#     value used on the wire" and emits "max"; nothing maps Max down to xhigh. A live
#     `-c model_reasoning_effort=max` call is served. (An UNKNOWN value is forwarded
#     verbatim and 400s — which is why VALID_EFFORTS stays an explicit allowlist.)
#   * `ultra` is the ONLY CLI-side tier. `client.rs::reasoning_effort_for_request()`
#     maps `Ultra => Max` before the request, so the wire sees "max" either way. The
#     sole thing `ultra` adds is `MultiAgentMode::Proactive` — and
#     `multi_agents.rs::effective_multi_agent_mode()` returns None unless
#     `multi_agent_version == V2`, which `config/mod.rs` grants only when the
#     `multi_agent_v2` feature is enabled. That feature ships OFF ("under development").
#
# Consequence: with `multi_agent_v2` off, `--effort ultra` and `--effort max` build
# BYTE-IDENTICAL requests. `ultra` would be a lie. So this wrapper enables the feature
# for the invocation (see ultra_v2_available) and REFUSES if it cannot — the same
# fail-closed principle as the Luna guard, applied to the gate the Luna guard missed.
# Proactive means the model is PERMITTED to delegate, not that subagents definitely ran.
DEFAULT_MODEL="gpt-5.6-sol"
VALID_EFFORTS="low medium high xhigh max ultra"

# Per-mode default effort. `max` is the default depth: it is the deepest SERVER effort,
# and it is what every prose/diff/advise pass has actually been running at. Proactive
# fan-out (`ultra`) is an explicit opt-in, not a silent default — it multiplies tokens,
# it engages an under-development orchestration layer, and same-model subagents produce
# correlated errors, so a fan-out's extra findings are not automatically better ones.
#   scout  — the mode exists to spend little and hand a downstream agent a target map.
#            Running a deep reasoning tier to do recon defeats its entire purpose.
#            (Sol's own default_reasoning_level is `low`.)
#   judge  — must emit ONE strict JSON array over N items. Depth beyond xhigh adds
#            output variance exactly where malformed JSON is fatal, and a fan-out would
#            multiply per item across the batch.
#   verify — the work is RETRIEVAL, not reasoning: grep the source, compare the string.
#            Reasoning tiers do not make `grep` more accurate, and a fan-out that splits
#            the quote list across subagents loses the cross-checking that catches a
#            quote lifted from the wrong paper. Depth here is a single careful reader
#            with a shell. Cheap on purpose: this mode is meant to run on every pass.
default_effort_for_mode() {
  case "$1" in
    scout)  echo "low" ;;
    judge)  echo "xhigh" ;;
    verify) echo "high" ;;
    *)      echo "max" ;;   # prose, diff, advise
  esac
}

die_usage() { echo "codex-adversary.sh: $1" >&2; echo "Run with --help for usage." >&2; exit 2; }
# need_val CURRENT_ARGC FLAG — guard a `shift 2` so a value-less flag (e.g. a
# trailing `--mode`) errors instead of looping forever (no `set -e` here).
need_val() { [ "$1" -ge 2 ] || die_usage "$2 requires a value"; }

# --doctor: report Codex availability + which flags this wrapper needs are present.
doctor() {
  echo "codex-adversary doctor:"
  if command -v codex >/dev/null 2>&1; then
    echo "  codex:      $(codex --version 2>/dev/null | head -1)  ($(command -v codex))"
  else
    echo "  codex:      NOT FOUND on PATH — install: https://github.com/openai/codex"; return 3
  fi
  local help; help="$(codex exec --help 2>/dev/null || true)"
  [ -n "$help" ] || { echo "  codex exec: UNAVAILABLE ('codex exec --help' failed)"; return 6; }
  echo "  codex exec: ok"
  local f miss=0
  for f in --output-last-message --sandbox --ephemeral --ignore-rules --skip-git-repo-check -c; do
    if printf '%s' "$help" | grep -q -- "$f"; then echo "  flag $f: present"
    else echo "  flag $f: MISSING"; [ "$f" = "--output-last-message" ] && miss=1; fi
  done
  [ "$miss" = "0" ] || { echo "  => INCOMPATIBLE: --output-last-message is required (see MAINTENANCE.md)"; return 6; }
  echo "  default model:  $DEFAULT_MODEL"
  echo "  valid efforts:  $VALID_EFFORTS  (max is a server effort; only ultra is CLI-side)"
  local m
  for m in prose diff advise scout judge verify; do
    printf '  default effort: %-7s %s\n' "$m" "$(default_effort_for_mode "$m")"
  done
  # `ultra` is inert unless multi_agent_v2 can be turned on; report whether it can, so
  # the operator learns it here rather than by being refused mid-review.
  if codex features list -c features.multi_agent_v2=true 2>/dev/null \
       | awk '$1 == "multi_agent_v2" { print $NF }' | grep -qx 'true'; then
    echo "  ultra (multi_agent_v2): available — proactive delegation can be enabled per-invocation"
  else
    echo "  ultra (multi_agent_v2): UNAVAILABLE — --effort ultra will be refused (it would equal max)"
  fi
  echo "  => compatible. (Auth not checked here — run a real review to confirm 'codex login'.)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)    need_val "$#" "$1"; MODE="$2"; shift 2 ;;
    --effort)  need_val "$#" "$1"; EFFORT="$2"; EFFORT_SET=1; shift 2 ;;
    --focus)   need_val "$#" "$1"; FOCUS="$2"; shift 2 ;;
    --file)    need_val "$#" "$1"; FILE="$2"; shift 2 ;;
    --schema)  need_val "$#" "$1"; SCHEMA="$2"; shift 2 ;;
    --base)    need_val "$#" "$1"; BASE="$2"; shift 2 ;;
    --repo)    need_val "$#" "$1"; REPO="$2"; REPO_EXPLICIT=1; shift 2 ;;
    --model)   need_val "$#" "$1"; MODEL="$2"; shift 2 ;;
    --timeout) need_val "$#" "$1"; TIMEOUT="$2"; shift 2 ;;
    --doctor)  DOCTOR=1; shift ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) die_usage "unknown option: $1" ;;
  esac
done

[ "$DOCTOR" = "1" ] && { doctor; exit $?; }

case "$TIMEOUT" in (*[!0-9]*|'') die_usage "--timeout must be a positive integer (seconds): $TIMEOUT" ;; esac
[ "$TIMEOUT" -ge 1 ] || die_usage "--timeout must be at least 1 second: $TIMEOUT"

case "$MODE" in prose|diff|advise|scout|judge|verify) ;; *) die_usage "--mode must be prose, diff, advise, scout, judge, or verify" ;; esac

[ "$EFFORT_SET" = "1" ] || EFFORT="$(default_effort_for_mode "$MODE")"
case "$EFFORT" in low|medium|high|xhigh|max|ultra) ;; *) die_usage "--effort must be one of: $VALID_EFFORTS" ;; esac

# Always send an explicit model. ~/.codex/config.toml is mutated by other Codex
# clients (the ChatGPT.app Codex writes it), so inheriting the configured model makes
# a review silently non-reproducible — you cannot tell from the output which model ran.
[ -n "$MODEL" ] || MODEL="$DEFAULT_MODEL"

# Luna advertises low..max and no `ultra`, but the CLI accepts `--effort ultra` on Luna
# WITHOUT error — so a silent downgrade is indistinguishable from a real ultra run.
# Refuse rather than let a caller believe they got delegation they never got.
# Lowercased for the test: `case` is case-sensitive, and a `gpt-5.6-LUNA` slug would
# otherwise sail past the very guard that exists to prevent a silent downgrade.
MODEL_LC="$(printf '%s' "$MODEL" | tr '[:upper:]' '[:lower:]')"
case "$MODEL_LC:$EFFORT" in
  *luna*:ultra) die_usage "model '$MODEL' does not support --effort ultra (Luna supports up to 'max'); Codex accepts it silently, so this is refused rather than downgraded. Use --effort max, or --model $DEFAULT_MODEL." ;;
esac

command -v codex >/dev/null 2>&1 || { echo "codex-adversary.sh: codex CLI not found on PATH" >&2; exit 3; }

# Adapt to the installed Codex CLI: parse `codex exec --help` once so we can drop
# hardening flags this build lacks (graceful) and fail CLEARLY if the essential
# capture flag is gone — instead of an opaque "Codex failed" on version drift.
CODEX_HELP="$(codex exec --help 2>/dev/null || true)"
[ -n "$CODEX_HELP" ] || { echo "codex-adversary.sh: 'codex exec' is unavailable in your Codex CLI ('codex exec --help' failed). This wrapper needs the 'codex exec' subcommand — update Codex, or see MAINTENANCE.md." >&2; exit 6; }
codex_supports() { printf '%s' "$CODEX_HELP" | grep -q -- "$1"; }
codex_supports "--output-last-message" || { echo "codex-adversary.sh: your Codex CLI lacks 'codex exec --output-last-message', which this wrapper needs for clean capture. Update Codex, or add a --json fallback (see MAINTENANCE.md)." >&2; exit 6; }

# --- the ultra gate: make `ultra` mean what it claims, or refuse -----------------
# Per the EFFORT note above, `ultra` differs from `max` ONLY when the `multi_agent_v2`
# feature is on; otherwise both build byte-identical requests. Enable it for THIS
# invocation only — never by mutating ~/.codex/config.toml, which the ChatGPT.app Codex
# rewrites underneath us. Confirm the override actually takes in THIS build (cheap: no
# model call, no tokens) and fail closed if it does not, so a caller can never believe
# they got delegation they never got.
ULTRA_V2_FLAG=0
ultra_v2_available() {
  codex features list -c features.multi_agent_v2=true 2>/dev/null \
    | awk '$1 == "multi_agent_v2" { print $NF }' | grep -qx 'true'
}
if [ "$EFFORT" = "ultra" ]; then
  if ultra_v2_available; then
    ULTRA_V2_FLAG=1
  else
    echo "codex-adversary.sh: --effort ultra needs the Codex 'multi_agent_v2' feature, and this build will not enable it (probed with 'codex features list -c features.multi_agent_v2=true')." >&2
    echo "codex-adversary.sh: without that feature 'ultra' sends exactly the same request as 'max' and delegates nothing — refusing rather than silently downgrading. Use --effort max." >&2
    exit 6
  fi
fi

# --- portable timeout -----------------------------------------------------------
# Args: SECS INFILE -- cmd...   INFILE is fed as stdin via an EXPLICIT redirect
# (bash sends an async command's stdin to /dev/null otherwise).
# Returns 124 on timeout (matching GNU `timeout`), else the command's own status.
# `codex exec` is a Node process that spawns native children, so on timeout we
# must signal the whole PROCESS GROUP or grandchildren leak. Stock macOS ships
# neither `timeout` nor `gtimeout`, so the pure-bash group-kill IS the live path.
run_with_timeout() {
  local secs="$1" infile="$2"; shift 2
  if command -v timeout  >/dev/null 2>&1; then timeout  -k 5 "$secs" "$@" < "$infile"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout -k 5 "$secs" "$@" < "$infile"; return $?; fi

  local marker="$TMPDIR_RUN/timed_out"; rm -f "$marker"
  # Run the child in its own process group so we can kill the whole tree (codex
  # spawns children). Job control may be unavailable in constrained shells, so
  # detect whether monitor mode actually engaged and fall back to single-PID.
  local monitor_was_on=0; case $- in *m*) monitor_was_on=1 ;; esac
  set -m 2>/dev/null
  local use_pgrp=0; case $- in *m*) use_pgrp=1 ;; esac
  "$@" < "$infile" &
  local cmd_pid=$!
  local ctarget="$cmd_pid"; [ "$use_pgrp" -eq 1 ] && ctarget="-$cmd_pid"
  (
    sleep "$secs"
    : > "$marker"
    kill -TERM "$ctarget" 2>/dev/null
    sleep 5
    kill -KILL "$ctarget" 2>/dev/null   # escalate if SIGTERM was ignored
  ) &
  local watch_pid=$!
  wait "$cmd_pid" 2>/dev/null; local rc=$?
  if [ "$monitor_was_on" -eq 1 ]; then set -m; else set +m; fi   # restore caller's state
  # Tear down the watchdog (its sleep child included) so nothing lingers.
  local wtarget="$watch_pid"; [ "$use_pgrp" -eq 1 ] && wtarget="-$watch_pid"
  kill -TERM "$wtarget" 2>/dev/null
  wait "$watch_pid" 2>/dev/null
  [ -f "$marker" ] && rc=124
  return $rc
}

TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/codex-adversary.XXXXXX")" || { echo "codex-adversary.sh: failed to create temp dir" >&2; exit 4; }
[ -n "$TMPDIR_RUN" ] || { echo "codex-adversary.sh: failed to create temp dir" >&2; exit 4; }
PROMPT_FILE="$TMPDIR_RUN/prompt.txt"
OUT_FILE="$TMPDIR_RUN/findings.txt"
LOG_FILE="$TMPDIR_RUN/session.log"
cleanup() { rm -rf "$TMPDIR_RUN"; }
trap cleanup EXIT

PROSE_FRAMING='You are an adversarial referee at a journal-referee bar. Report ONLY substantive problems: factual errors, false or unsupported claims, logical gaps, circular or invalid arguments, missing counterarguments, internal contradictions, and mis-stated numbers/units/denominators. Attack whether the content is WRONG, not how it reads — do NOT comment on wording, tone, structure, or style unless it changes the meaning; those are noise here. Prefer ONE decisive, real objection over many minor ones. Order findings by severity, most serious first; for each: locate it, state the problem, why it matters, and a fix. If nothing is substantively wrong, say exactly that in one sentence — padding with nitpicks is a failure, not thoroughness.'

CODE_FRAMING='You are an adversarial code reviewer — a skeptical senior engineer. Report ONLY substantive problems: correctness/logic bugs, security holes, broken or unhandled edge cases, race conditions, resource leaks, data loss, and materially wrong design. Do NOT report style, formatting, naming, import order, lint, or "consider/you might want to" preferences — those are noise here and listing them is a failure. Trace the actual logic and data flow; prefer ONE real, deep bug over ten shallow remarks. You have read-only access to the repo — read surrounding files for context. Order findings by severity, most serious first; for each: file:line, what breaks and the concrete input/case that triggers it, why it matters, and a fix. If there is no substantive problem, say exactly that in one sentence.'

ADVISE_FRAMING='You are a senior technical advisor giving a SECOND OPINION on a decision someone faces mid-task, BEFORE they act. They — not you — will decide and act; you cannot make changes. From the situation and any context below: (1) restate the decision as you understand it, in one line; (2) lay out the main viable options; (3) the key tradeoffs and the risks or edge-cases they are most likely missing; (4) a concrete recommended approach, with your reasoning; (5) call out anything that would make their apparent current plan a mistake. Be specific and decisive — surface considerations a single perspective would miss rather than hedging everything. Focus on what could make the plan wrong or costly; ignore cosmetic preferences. If the situation is underspecified, state the assumption your advice depends on instead of refusing to answer.'

JUDGE_FRAMING='You are a careful, skeptical JUDGE adjudicating a BATCH of items against a rubric, so a downstream automated pipeline can act on your verdicts. If a codebase was provided you have READ-ONLY access to it — USE it to VERIFY each claim against the actual source/data before ruling; do not rule from memory when the source can be checked. For EACH item in the worklist, apply the rubric and produce exactly one verdict object. Output ONLY a single JSON array and NOTHING else — no preamble, no prose, no markdown code fences, no trailing commentary. The array MUST contain exactly one object per input item, in the SAME order, and each object MUST carry the item identifier so verdicts can be matched back. Conform every object to the OUTPUT SHAPE given below. If you are uncertain about an item, still emit its object and record the uncertainty in its fields (a confidence/flag/note) — never drop, merge, invent, or reorder items. When the rubric specifies a default (e.g. default-reject, default-uncertain), apply it. Correctness over leniency; your output is parsed by a machine, so malformed JSON or extra prose is a failure.'

SCOUT_FRAMING='You are a fast reconnaissance scout for another AI agent that will do the actual work. You have READ-ONLY access to a codebase; USE it — grep, read files, trace structure — to LOCATE what the downstream agent needs, then hand back a compressed targeting map, NOT an analysis, fix, or solution. Your output is consumed by another agent and spends its budget, so be terse and decision-ready: no preamble, no restating the task, no essays, no pasting large code blocks. Report ONLY: (1) the specific files with line-ranges/symbols that are relevant, each with a one-line why; (2) where to START and in what order; (3) load-bearing facts the agent must know before touching it (invariants, gotchas, the real entry point vs decoys); (4) what looks relevant but is NOT, so the agent can skip it. If you cannot locate something, say so in one line rather than guessing. Aim for under ~400 words; a tight annotated list beats prose. Map the territory; do not conquer it.'

VERIFY_FRAMING='You are a SOURCE-FIDELITY AUDITOR. You have READ-ONLY access to the primary sources on disk. Your ONLY job is to check whether the document says what its sources say. Do NOT evaluate the argument. Do NOT comment on style, structure, or significance. Do NOT suggest improvements to the reasoning. Source fidelity, and nothing else.

METHOD. Extract from the document every (a) quoted string, (b) claim attributed to a named author or work, (c) named theorem or result and what it is used for, (d) specific number, date, unit, or denominator. For each, locate the source on disk and check it. Never rule from memory when a file can be read.

TWO TRAPS THAT HAVE ALREADY CAUSED FALSE CLEARANCES HERE:
  1. Extracted-text files may contain NUL bytes. Plain `grep` then treats them as binary and `grep -o` silently prints NOTHING — which reads exactly like "quote absent". ALWAYS use `grep -a`. Never report a quote as missing until you have tried `grep -a`, a case-insensitive search, and a search for a distinctive INTERIOR fragment of the quote.
  2. PDF text layers render ligatures oddly: "fi", "ff", "ffi" may be single glyphs, so "specific" may not match. Search around them.

CLASSES OF ERROR TO HUNT, in order of how often they occur:
  * PARAPHRASE IN QUOTATION MARKS — the sense is right, the words are not. Quotation marks assert verbatim text.
  * SLOGAN DRIFT — the document cites the version everyone repeats rather than the version the author wrote.
  * ABSTRACT vs THEOREM — a paper abstract claims more than the paper proves. If a claim leans on an abstract, title, or summary, go and read what the body actually establishes, and report the gap.
  * MISATTRIBUTION — a conclusion put in an author'\''s mouth that the author does not draw, or that their own position contradicts.
  * THEOREM OVERREACH — a result used for more than its hypotheses license, or used with its direction/quantifiers reversed.
  * SOURCE REBUTS THE USE — the cited work explicitly argues against the purpose it is cited for. Read enough of the source to notice.
  * ARITHMETIC — recompute every number. Check units and denominators.

YOU HAVE NO NETWORK. Do not attempt to resolve DOIs online. Check each bibliography entry against the local full text where one exists (title, authors, year, venue in the file header), and explicitly LIST any reference you could not check so a human can.

OUTPUT. A ranked list, most severe first. For each finding: the document'\''s claim, the VERDICT (VERBATIM / PARAPHRASE-IN-QUOTES / NOT FOUND / MISATTRIBUTED / OVERREACH / SOURCE-REBUTS-USE / ARITHMETIC-ERROR), the evidence as file:line with the source'\''s actual words, and the minimal correction. Then a short list of claims you verified as sound, so the reader knows what was checked. Then the unverifiable list. If every quotation and attribution checks out, say exactly that in one sentence — do not pad with nitpicks, and do not drift into reviewing the argument.'

build_codex_cmd() {
  # Essential (preflighted): read-only sandbox + clean capture via --output-last-message.
  CODEX_CMD=(codex exec --sandbox read-only)
  # Hardening flags — include only those THIS Codex build advertises, dropping any it
  # lacks (with a note) so a renamed/removed flag degrades gracefully instead of erroring:
  #   --ephemeral           don't persist the prompt to ~/.codex session logs
  #   --ignore-rules        don't load an untrusted repo's rule files (AGENTS.md etc.)
  #   --skip-git-repo-check let prose run outside a git repo (rooted in a temp dir)
  local f
  for f in --ephemeral --ignore-rules --skip-git-repo-check; do
    if codex_supports "$f"; then CODEX_CMD+=("$f")
    else echo "codex-adversary.sh: note — this Codex build lacks $f; proceeding without it." >&2; fi
  done
  # `ultra` is inert without this; the gate above already refused if it cannot be set.
  [ "$ULTRA_V2_FLAG" = "1" ] && CODEX_CMD+=(-c features.multi_agent_v2=true)
  CODEX_CMD+=(-c model_reasoning_effort="$EFFORT" --output-last-message "$OUT_FILE")
  CODEX_CMD+=(-m "$MODEL")   # always explicit — never inherit a config another client mutates
}

if [ "$MODE" = "prose" ]; then
  CONTENT_FILE="$TMPDIR_RUN/content.txt"
  if [ -n "$FILE" ]; then
    [ -f "$FILE" ] || die_usage "--file not found: $FILE"
    cat "$FILE" > "$CONTENT_FILE" || die_usage "could not read --file: $FILE"
  else
    cat > "$CONTENT_FILE"   # stdin, streamed straight to disk (no shell-var round-trip)
  fi
  LC_ALL=C grep -q '[^[:space:]]' "$CONTENT_FILE" || { echo "codex-adversary.sh: no content provided on stdin/--file" >&2; exit 2; }
  {
    printf '%s\n' "$PROSE_FRAMING"
    [ -n "$FOCUS" ] && printf '\nReviewer focus for this pass: %s\n' "$FOCUS"
    printf '\n--- CONTENT TO REVIEW ---\n\n'
    cat "$CONTENT_FILE"
    printf '\n'
  } > "$PROMPT_FILE"
  build_codex_cmd
  CODEX_CMD+=(-C "$TMPDIR_RUN")   # prose reads nothing from disk; root Codex in an empty trusted dir

elif [ "$MODE" = "advise" ]; then
  CONTENT_FILE="$TMPDIR_RUN/content.txt"
  if [ -n "$FILE" ]; then
    [ -f "$FILE" ] || die_usage "--file not found: $FILE"
    cat "$FILE" > "$CONTENT_FILE" || die_usage "could not read --file: $FILE"
  else
    cat > "$CONTENT_FILE"   # the decision + context, on stdin
  fi
  LC_ALL=C grep -q '[^[:space:]]' "$CONTENT_FILE" || { echo "codex-adversary.sh: no decision/context provided on stdin/--file" >&2; exit 2; }
  {
    printf '%s\n' "$ADVISE_FRAMING"
    [ -n "$FOCUS" ] && printf '\nThe specific question to weigh in on: %s\n' "$FOCUS"
    printf '\n--- SITUATION / DECISION / CONTEXT ---\n\n'
    cat "$CONTENT_FILE"
    printf '\n'
  } > "$PROMPT_FILE"
  build_codex_cmd
  if [ "$REPO_EXPLICIT" = "1" ]; then
    [ -d "$REPO" ] || die_usage "--repo is not a directory: $REPO"
    CODEX_CMD+=(-C "$REPO")        # give Codex the codebase as read-only context
  else
    CODEX_CMD+=(-C "$TMPDIR_RUN")  # no codebase context requested
  fi

elif [ "$MODE" = "scout" ]; then
  CONTENT_FILE="$TMPDIR_RUN/content.txt"
  if [ -n "$FILE" ]; then
    [ -f "$FILE" ] || die_usage "--file not found: $FILE"
    cat "$FILE" > "$CONTENT_FILE" || die_usage "could not read --file: $FILE"
  else
    cat > "$CONTENT_FILE"   # the scouting task, on stdin
  fi
  LC_ALL=C grep -q '[^[:space:]]' "$CONTENT_FILE" || { echo "codex-adversary.sh: no scouting task provided on stdin/--file" >&2; exit 2; }
  [ -d "$REPO" ] || die_usage "--repo is not a directory: $REPO"
  {
    printf '%s\n' "$SCOUT_FRAMING"
    [ -n "$FOCUS" ] && printf '\nNarrow the scout to: %s\n' "$FOCUS"
    printf '\nCodebase to scout (read-only): %s\n' "$REPO"
    printf '\n--- WHAT TO SCOUT FOR ---\n\n'
    cat "$CONTENT_FILE"
    printf '\n'
  } > "$PROMPT_FILE"
  build_codex_cmd
  CODEX_CMD+=(-C "$REPO")

elif [ "$MODE" = "verify" ]; then
  # Source-fidelity audit. Orthogonal to `prose`: prose asks whether the argument is
  # WRONG; verify asks whether the document says what its sources say. Cheap, mechanical,
  # and the highest-yield pass available — most citation failures are string mismatches,
  # not reasoning errors, and no amount of reasoning effort finds them without the source.
  # Unlike prose (rooted in an empty temp dir), verify NEEDS the sources on disk.
  CONTENT_FILE="$TMPDIR_RUN/content.txt"
  if [ -n "$FILE" ]; then
    [ -f "$FILE" ] || die_usage "--file not found: $FILE"
    cat "$FILE" > "$CONTENT_FILE" || die_usage "could not read --file: $FILE"
  else
    cat > "$CONTENT_FILE"   # the document whose citations are being audited, on stdin
  fi
  LC_ALL=C grep -q '[^[:space:]]' "$CONTENT_FILE" || { echo "codex-adversary.sh: no document provided on stdin/--file" >&2; exit 2; }
  [ -d "$REPO" ] || die_usage "--repo is not a directory: $REPO"
  {
    printf '%s\n' "$VERIFY_FRAMING"
    [ -n "$FOCUS" ] && printf '\nAdditional context for this audit (source locations, known traps, what to prioritise): %s\n' "$FOCUS"
    printf '\nPrimary sources, read-only, rooted here: %s\n' "$REPO"
    printf '(Absolute paths outside this root are also readable. Use the shell.)\n'
    printf '\n--- DOCUMENT TO AUDIT ---\n\n'
    cat "$CONTENT_FILE"
    printf '\n'
  } > "$PROMPT_FILE"
  build_codex_cmd
  CODEX_CMD+=(-C "$REPO")

elif [ "$MODE" = "judge" ]; then
  # Structured batch judging — the offload primitive for LLM-judge loops that feed
  # an automated record/apply step. Codex judges each worklist item against a
  # rubric (optionally reading the repo read-only to verify) and returns JSON.
  CONTENT_FILE="$TMPDIR_RUN/content.txt"
  if [ -n "$FILE" ]; then
    [ -f "$FILE" ] || die_usage "--file not found: $FILE"
    cat "$FILE" > "$CONTENT_FILE" || die_usage "could not read --file: $FILE"
  else
    cat > "$CONTENT_FILE"   # the worklist (items to judge), on stdin
  fi
  LC_ALL=C grep -q '[^[:space:]]' "$CONTENT_FILE" || { echo "codex-adversary.sh: no worklist provided on stdin/--file" >&2; exit 2; }
  if [ -n "$SCHEMA" ]; then
    [ -f "$SCHEMA" ] || die_usage "--schema not found: $SCHEMA"
  fi
  {
    printf '%s\n' "$JUDGE_FRAMING"
    [ -n "$FOCUS" ] && printf '\nRubric for this pass: %s\n' "$FOCUS"
    if [ -n "$SCHEMA" ]; then
      printf '\n--- OUTPUT SHAPE (emit exactly this JSON structure, one object per item) ---\n\n'
      cat "$SCHEMA"
      printf '\n'
    fi
    [ "$REPO_EXPLICIT" = "1" ] && printf '\nCodebase available read-only at %s — verify claims against it before ruling.\n' "$REPO"
    printf '\n--- WORKLIST TO JUDGE (one verdict object per item, same order) ---\n\n'
    cat "$CONTENT_FILE"
    printf '\n'
  } > "$PROMPT_FILE"
  build_codex_cmd
  if [ "$REPO_EXPLICIT" = "1" ]; then
    [ -d "$REPO" ] || die_usage "--repo is not a directory: $REPO"
    CODEX_CMD+=(-C "$REPO")        # give Codex the codebase as read-only context to verify against
  else
    CODEX_CMD+=(-C "$TMPDIR_RUN")  # judge the worklist as given, no codebase context
  fi

else  # diff mode
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die_usage "--repo is not a git repo: $REPO"
  # --no-ext-diff / --no-textconv: never run repo-configured external diff or
  # textconv programs (a hostile local git config could otherwise execute on host).
  GD=(git -C "$REPO" diff --no-ext-diff --no-textconv)
  if [ -n "$BASE" ]; then
    git -C "$REPO" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null \
      || die_usage "--base is not a valid git ref in $REPO: $BASE"
    if ! { git -C "$REPO" diff --quiet 2>/dev/null && git -C "$REPO" diff --staged --quiet 2>/dev/null; }; then
      echo "codex-adversary.sh: note — worktree has uncommitted changes; Codex sees the live files, which may differ from the reviewed ${BASE}...HEAD diff." >&2
    fi
    RAW="$("${GD[@]}" "$BASE"...HEAD 2>/dev/null)"
    DIFF_TEXT="$RAW"
    SCOPE="changes on this branch vs base '$BASE'"
  else
    UNSTAGED="$("${GD[@]}" 2>/dev/null)"
    STAGED="$("${GD[@]}" --staged 2>/dev/null)"
    # Untracked (new) files are in neither diff; include them as additions so a
    # review of "uncommitted changes" doesn't silently skip brand-new files.
    UNTRACKED=""
    while IFS= read -r -d '' uf; do
      [ -n "$uf" ] || continue
      UNTRACKED="$UNTRACKED
$(git -C "$REPO" diff --no-index --no-color --no-ext-diff --no-textconv -- /dev/null "$uf" 2>/dev/null)"
    done < <(git -C "$REPO" ls-files -z --others --exclude-standard 2>/dev/null)
    RAW="$UNSTAGED$STAGED$UNTRACKED"
    DIFF_TEXT="$(printf '===== UNSTAGED CHANGES (working tree vs index) =====\n%s\n\n===== STAGED CHANGES (index vs HEAD) =====\n%s\n\n===== UNTRACKED (new) FILES =====\n%s\n' "$UNSTAGED" "$STAGED" "$UNTRACKED")"
    SCOPE="uncommitted changes (unstaged + staged + untracked)"
  fi
  # NB: do NOT use ${RAW//[ws]/} here — bash 3.2's global pattern substitution is
  # pathologically slow (~O(n^2)) on large diffs and pins a CPU for minutes. Use grep
  # via a here-string (NOT a pipe: with `set -o pipefail`, grep -q's early exit would
  # SIGPIPE the writer and report a false "no changes").
  LC_ALL=C grep -q '[^[:space:]]' <<<"$RAW" || { echo "codex-adversary.sh: no $SCOPE to review in $REPO" >&2; exit 2; }
  {
    printf '%s\n' "$CODE_FRAMING"
    printf '\nScope: %s. Working directory: %s\n' "$SCOPE" "$REPO"
    [ -n "$FOCUS" ] && printf 'Reviewer focus for this pass: %s\n' "$FOCUS"
    printf '\n--- DIFF ---\n\n%s\n' "$DIFF_TEXT"
  } > "$PROMPT_FILE"
  build_codex_cmd
  CODEX_CMD+=(-C "$REPO")
fi

# --- common: guard the assembled prompt, then run Codex -------------------------
[ -s "$PROMPT_FILE" ] || { echo "codex-adversary.sh: failed to assemble prompt (empty prompt file)" >&2; exit 4; }
PROMPT_BYTES=$(wc -c < "$PROMPT_FILE" 2>/dev/null || echo 0)
if [ "${PROMPT_BYTES:-0}" -gt 400000 ]; then
  echo "codex-adversary.sh: warning — prompt is ${PROMPT_BYTES} bytes (~$((PROMPT_BYTES/4)) tokens) and may exceed Codex's context window; the review could be partial. Consider splitting (a manuscript by section, a diff by file)." >&2
fi
run_with_timeout "$TIMEOUT" "$PROMPT_FILE" "${CODEX_CMD[@]}" - > "$LOG_FILE" 2>&1
RC=$?

# --- evaluate result. A non-empty OUT_FILE alone is NOT success: a non-zero or
#     timed-out run can leave partial output, so check RC first. ----------------
if [ "$RC" -eq 124 ]; then
  echo "codex-adversary.sh: Codex timed out after ${TIMEOUT}s (mode=$MODE, effort=$EFFORT)." >&2
  echo "--- codex session log (tail) ---" >&2; tail -n 15 "$LOG_FILE" >&2 2>/dev/null
  exit 5
fi
if [ "$RC" -ne 0 ]; then
  echo "codex-adversary.sh: Codex exited non-zero (exit=$RC, mode=$MODE, effort=$EFFORT)." >&2
  echo "--- codex session log (tail) ---" >&2; tail -n 15 "$LOG_FILE" >&2 2>/dev/null
  [ -s "$OUT_FILE" ] && { echo "--- partial findings (treated as failure) ---" >&2; cat "$OUT_FILE" >&2; }
  exit 4
fi
# judge mode: Codex was told to emit a JSON array. Real responses sometimes wrap it
# in prose or a ```json fence, so extract the outermost JSON value, validate it
# parses, and emit it COMPACT for the downstream record step. On any failure, dump
# the raw response to stderr and exit 4 — never feed prose to a machine consumer.
emit_judge_json() {
  local raw_file="$1" cleaned
  if ! command -v node >/dev/null 2>&1; then
    echo "codex-adversary.sh: judge mode needs 'node' to validate JSON; emitting raw response unvalidated." >&2
    cat "$raw_file"; return 0
  fi
  if cleaned="$(node -e '
    const fs=require("fs");
    let s=fs.readFileSync(process.argv[1],"utf8").trim();
    s=s.replace(/^```(?:json)?\s*/i,"").replace(/```\s*$/,"").trim();
    const cands=[s.indexOf("["),s.indexOf("{")].filter(i=>i>=0);
    if(!cands.length) process.exit(3);
    const start=Math.min(...cands), close=s[start]==="[" ? "]" : "}", end=s.lastIndexOf(close);
    if(end<start) process.exit(3);
    try { process.stdout.write(JSON.stringify(JSON.parse(s.slice(start,end+1)))); }
    catch(e){ process.exit(3); }
  ' "$raw_file" 2>/dev/null)"; then
    printf '%s\n' "$cleaned"; return 0
  fi
  echo "codex-adversary.sh: judge mode — Codex did not return parseable JSON (effort=$EFFORT). Raw response follows on stderr." >&2
  echo "--- raw codex response ---" >&2; cat "$raw_file" >&2
  return 4
}

if [ -s "$OUT_FILE" ]; then
  if [ "$MODE" = "judge" ]; then emit_judge_json "$OUT_FILE"; exit $?; fi
  cat "$OUT_FILE"
  exit 0
fi
echo "codex-adversary.sh: Codex returned success but wrote no findings file (mode=$MODE, effort=$EFFORT)." >&2
echo "--- codex session log (tail) ---" >&2; tail -n 15 "$LOG_FILE" >&2 2>/dev/null
exit 4
