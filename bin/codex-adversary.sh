#!/usr/bin/env bash
#
# codex-adversary.sh — run Codex (your configured model) as a READ-ONLY
# adversarial reviewer and print ONLY its findings to stdout.
#
# This is the primitive behind the `adversarial-review` skill. Claude calls it
# alongside its own review agents, then reconciles both — a second model from a
# different vendor catches errors a single reviewer's blind spots would miss.
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
# OPTIONS
#   --mode   prose|diff|advise  prose/diff = adversarial review; advise = counsel on a
#                            decision before acting. Default: prose.
#   --effort low|medium|high|xhigh
#                            Codex reasoning effort. Default: high.
#                            (Claude picks this per-pass; see the skill's rubric.)
#   --focus  "..."           Optional extra instruction / the specific question.
#   --file   PATH            (prose/advise) Read content from PATH instead of stdin.
#   --base   BRANCH          (diff) Review changes vs BRANCH instead of uncommitted.
#   --repo   DIR             (diff) repo to diff; (advise) codebase given to Codex as
#                            read-only context. Default: current directory.
#   --model  NAME            Override Codex model. Default: inherit ~/.codex config.
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
#   6  Codex CLI incompatible (no 'codex exec' or no --output-last-message) — see stderr.
#
set -uo pipefail

MODE="prose"
EFFORT="high"
FOCUS=""
FILE=""
BASE=""
REPO="$(pwd)"
REPO_EXPLICIT=0
MODEL=""
TIMEOUT="600"
DOCTOR=0

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
  echo "  => compatible. (Auth not checked here — run a real review to confirm 'codex login'.)"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)    need_val "$#" "$1"; MODE="$2"; shift 2 ;;
    --effort)  need_val "$#" "$1"; EFFORT="$2"; shift 2 ;;
    --focus)   need_val "$#" "$1"; FOCUS="$2"; shift 2 ;;
    --file)    need_val "$#" "$1"; FILE="$2"; shift 2 ;;
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

case "$MODE" in prose|diff|advise) ;; *) die_usage "--mode must be prose, diff, or advise" ;; esac
case "$EFFORT" in low|medium|high|xhigh) ;; *) die_usage "--effort must be low|medium|high|xhigh" ;; esac

command -v codex >/dev/null 2>&1 || { echo "codex-adversary.sh: codex CLI not found on PATH" >&2; exit 3; }

# Adapt to the installed Codex CLI: parse `codex exec --help` once so we can drop
# hardening flags this build lacks (graceful) and fail CLEARLY if the essential
# capture flag is gone — instead of an opaque "Codex failed" on version drift.
CODEX_HELP="$(codex exec --help 2>/dev/null || true)"
[ -n "$CODEX_HELP" ] || { echo "codex-adversary.sh: 'codex exec' is unavailable in your Codex CLI ('codex exec --help' failed). This wrapper needs the 'codex exec' subcommand — update Codex, or see MAINTENANCE.md." >&2; exit 6; }
codex_supports() { printf '%s' "$CODEX_HELP" | grep -q -- "$1"; }
codex_supports "--output-last-message" || { echo "codex-adversary.sh: your Codex CLI lacks 'codex exec --output-last-message', which this wrapper needs for clean capture. Update Codex, or add a --json fallback (see MAINTENANCE.md)." >&2; exit 6; }

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
  CODEX_CMD+=(-c model_reasoning_effort="$EFFORT" --output-last-message "$OUT_FILE")
  [ -n "$MODEL" ] && CODEX_CMD+=(-m "$MODEL")
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
  [ -n "${RAW//[$' \t\n\r']/}" ] || { echo "codex-adversary.sh: no $SCOPE to review in $REPO" >&2; exit 2; }
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
if [ -s "$OUT_FILE" ]; then
  cat "$OUT_FILE"
  exit 0
fi
echo "codex-adversary.sh: Codex returned success but wrote no findings file (mode=$MODE, effort=$EFFORT)." >&2
echo "--- codex session log (tail) ---" >&2; tail -n 15 "$LOG_FILE" >&2 2>/dev/null
exit 4
