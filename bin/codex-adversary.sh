#!/usr/bin/env bash
#
# codex-adversary.sh — run Codex (your configured model) as a READ-ONLY
# adversarial reviewer and print ONLY its findings to stdout.
#
# This is the primitive behind the `adversarial-review` skill. Claude calls it
# alongside its own review agents, then synthesizes both for diversity of thought.
#
# Codex runs with --sandbox read-only: it can read files and (in diff mode) the
# repo, but it CANNOT modify anything. Safe to run in any repo, any time,
# including commit-gated or multi-agent shared trees.
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
# OPTIONS
#   --mode   prose|diff      What to review. Default: prose.
#   --effort low|medium|high|xhigh
#                            Codex reasoning effort. Default: high.
#                            (Claude picks this per-pass; see the skill's rubric.)
#   --focus  "..."           Optional extra instruction to steer the critique.
#   --file   PATH            (prose) Read content from PATH instead of stdin.
#   --base   BRANCH          (diff) Review changes vs BRANCH instead of uncommitted.
#   --repo   DIR             (diff) Repo working dir. Default: current directory.
#   --model  NAME            Override Codex model. Default: inherit ~/.codex config.
#   --timeout SECS           Hard cap on the Codex call. Default: 600.
#   -h|--help                Show this help.
#
# EXIT CODES
#   0  Codex ran and produced a response (printed to stdout).
#   2  Usage error.
#   3  Codex CLI not found.
#   4  Codex failed / produced no output (auth, crash, empty) — see stderr.
#   5  Codex timed out before producing output — see stderr.
#
set -uo pipefail

MODE="prose"
EFFORT="high"
FOCUS=""
FILE=""
BASE=""
REPO="$(pwd)"
MODEL=""
TIMEOUT="600"

die_usage() { echo "codex-adversary.sh: $1" >&2; echo "Run with --help for usage." >&2; exit 2; }
# need_val CURRENT_ARGC FLAG — guard a `shift 2` so a value-less flag (e.g. a
# trailing `--mode`) errors instead of looping forever (no `set -e` here).
need_val() { [ "$1" -ge 2 ] || die_usage "$2 requires a value"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --mode)    need_val "$#" "$1"; MODE="$2"; shift 2 ;;
    --effort)  need_val "$#" "$1"; EFFORT="$2"; shift 2 ;;
    --focus)   need_val "$#" "$1"; FOCUS="$2"; shift 2 ;;
    --file)    need_val "$#" "$1"; FILE="$2"; shift 2 ;;
    --base)    need_val "$#" "$1"; BASE="$2"; shift 2 ;;
    --repo)    need_val "$#" "$1"; REPO="$2"; shift 2 ;;
    --model)   need_val "$#" "$1"; MODEL="$2"; shift 2 ;;
    --timeout) need_val "$#" "$1"; TIMEOUT="$2"; shift 2 ;;
    -h|--help) awk 'NR==1{next} /^#/{sub(/^# ?/,""); print; next} {exit}' "$0"; exit 0 ;;
    *) die_usage "unknown option: $1" ;;
  esac
done

case "$TIMEOUT" in (*[!0-9]*|'') die_usage "--timeout must be a positive integer (seconds): $TIMEOUT" ;; esac

case "$MODE" in prose|diff) ;; *) die_usage "--mode must be prose or diff" ;; esac
case "$EFFORT" in low|medium|high|xhigh) ;; *) die_usage "--effort must be low|medium|high|xhigh" ;; esac

command -v codex >/dev/null 2>&1 || { echo "codex-adversary.sh: codex CLI not found on PATH" >&2; exit 3; }

# --- portable timeout (macOS has no `timeout`) ----------------------------------
# Args: SECS INFILE -- cmd...   INFILE is fed to the command as stdin via an
# EXPLICIT redirect (bash sends an async command's stdin to /dev/null otherwise).
# Returns 124 on timeout (matching GNU `timeout`), else the command's own status.
run_with_timeout() {
  local secs="$1" infile="$2"; shift 2
  if command -v timeout  >/dev/null 2>&1; then timeout  "$secs" "$@" < "$infile"; return $?; fi
  if command -v gtimeout >/dev/null 2>&1; then gtimeout "$secs" "$@" < "$infile"; return $?; fi
  # Pure-bash fallback. The explicit stdin redirect matters: bash sends an
  # async command's stdin to /dev/null unless a redirect is present.
  local marker="$TMPDIR_RUN/timed_out"; rm -f "$marker"
  "$@" < "$infile" & local cmd_pid=$!
  (
    sleep "$secs"
    : > "$marker"
    kill -TERM "$cmd_pid" 2>/dev/null
    sleep 5
    kill -KILL "$cmd_pid" 2>/dev/null   # escalate if SIGTERM was ignored
  ) & local watch_pid=$!
  wait "$cmd_pid" 2>/dev/null; local rc=$?
  # Tear down the watchdog AND its sleep child so no orphan lingers to wake later.
  local kid; kid="$(pgrep -P "$watch_pid" 2>/dev/null)"
  kill "$watch_pid" 2>/dev/null
  [ -n "$kid" ] && kill $kid 2>/dev/null
  wait "$watch_pid" 2>/dev/null
  [ -f "$marker" ] && rc=124
  return $rc
}

TMPDIR_RUN="$(mktemp -d "${TMPDIR:-/tmp}/codex-adversary.XXXXXX")"
PROMPT_FILE="$TMPDIR_RUN/prompt.txt"
OUT_FILE="$TMPDIR_RUN/findings.txt"
LOG_FILE="$TMPDIR_RUN/session.log"
cleanup() { rm -rf "$TMPDIR_RUN"; }
trap cleanup EXIT

PROSE_FRAMING='You are an adversarial referee — a skeptical, independent second set of eyes, held to a journal-referee / senior-engineer standard. Critically review the content below. Hunt for: factual errors, unsupported or overstated claims, logical gaps, weak or circular arguments, missing counterarguments, internal contradictions, mis-stated numbers/units/denominators, and anything that would not survive peer review. For each issue: locate it (quote or section), state the problem, say why it matters, and give a concrete fix. Be specific and skeptical. Do NOT praise, summarize, or comment on things that are fine. If you genuinely find nothing substantive, say so plainly rather than inventing nitpicks.'

CODE_FRAMING='You are an adversarial code reviewer — a skeptical senior engineer. Review the change below for substantive problems only: correctness bugs, security issues, broken or unhandled edge cases, regressions, race conditions, resource leaks, and violated invariants. You have read-only access to the repository for context — read surrounding files as needed. For each issue: file:line, what is wrong, why it matters, and a concrete fix. Be concrete and skeptical; do NOT praise or restate the diff. If you find nothing substantive, say so plainly rather than inventing nitpicks.'

build_codex_cmd() {
  # shellcheck disable=SC2206
  CODEX_CMD=(codex exec --sandbox read-only -c model_reasoning_effort="$EFFORT" -o "$OUT_FILE")
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

else  # diff mode
  git -C "$REPO" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die_usage "--repo is not a git repo: $REPO"
  if [ -n "$BASE" ]; then
    git -C "$REPO" rev-parse --verify --quiet "${BASE}^{commit}" >/dev/null \
      || die_usage "--base is not a valid git ref in $REPO: $BASE"
    RAW="$(git -C "$REPO" diff "$BASE"...HEAD 2>/dev/null)"
    DIFF_TEXT="$RAW"
    SCOPE="changes on this branch vs base '$BASE'"
  else
    UNSTAGED="$(git -C "$REPO" diff 2>/dev/null)"
    STAGED="$(git -C "$REPO" diff --staged 2>/dev/null)"
    RAW="$UNSTAGED$STAGED"
    DIFF_TEXT="$(printf '===== UNSTAGED CHANGES (working tree vs index) =====\n%s\n\n===== STAGED CHANGES (index vs HEAD) =====\n%s\n' "$UNSTAGED" "$STAGED")"
    SCOPE="uncommitted changes (unstaged + staged)"
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
