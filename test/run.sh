#!/usr/bin/env bash
# Test suite for codex-adversary.sh using a STUBBED `codex` — no network, no real
# model. Verifies arg handling, exit codes, prompt assembly, and diff scope.
# Run: ./test/run.sh        Exits non-zero if any check fails.
set -uo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WRAP="$ROOT/bin/codex-adversary.sh"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/codex-adv-test.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

PASS=0; FAIL=0
ok()  { PASS=$((PASS + 1)); printf '  ok   - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf '  FAIL - %s\n' "$1"; }
expect_exit() { if [ "$2" = "$3" ]; then ok "$1 (exit $3)"; else bad "$1 (expected $2, got $3)"; fi; }
contains()    { if printf '%s' "$1" | grep -qF -- "$2"; then ok "$3"; else bad "$3 (missing: $2)"; fi; }
not_contains(){ if printf '%s' "$1" | grep -qF -- "$2"; then bad "$3 (unexpectedly present: $2)"; else ok "$3"; fi; }

# --- stub `codex`: captures the prompt it's handed; mode set via $STUB_MODE -------
STUBDIR="$WORK/stubbin"; mkdir -p "$STUBDIR"
cat > "$STUBDIR/codex" <<'STUB'
#!/usr/bin/env bash
# fake codex. STUB_FLAGS = flags to advertise in `codex exec --help` (default: all the
# wrapper wants); set it to fewer to simulate an older/newer Codex. STUB_MODE = ok|fail|empty|hang.
case " $* " in
  *" --version "*) echo "codex-stub 0.0.0"; exit 0 ;;
  # `codex features list -c features.multi_agent_v2=true` — the wrapper's ultra gate.
  # STUB_V2 = true (default) | false | missing, to simulate a build that will enable
  # multi_agent_v2, one that refuses to, and one that has dropped the feature entirely.
  *" features "*)
    echo "multi_agent                          stable             true"
    case "${STUB_V2:-true}" in
      true)  echo "multi_agent_v2                       under development  true" ;;
      false) echo "multi_agent_v2                       under development  false" ;;
      missing) : ;;
    esac
    exit 0 ;;
  *" --help "*)
    echo "Usage: codex exec [OPTIONS]"
    for f in ${STUB_FLAGS:---output-last-message --sandbox --ephemeral --ignore-rules --skip-git-repo-check -c -m -C}; do
      echo "  $f"
    done
    exit 0 ;;
esac
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done
# record the argv the wrapper actually built, so tests can assert on -m / -c values
[ -n "${STUB_ARGV:-}" ] && printf '%s\n' "$*" > "$STUB_ARGV"
input="$(cat)"
case "${STUB_MODE:-ok}" in
  hang)  sleep 30 ;;
  fail)  echo "stub: simulated failure" >&2; exit 1 ;;
  empty) : > "${out:-/dev/null}"; exit 0 ;;
  # json: emit a verdict array wrapped in prose + a markdown fence, to prove the
  # judge mode extracts clean compact JSON out of a realistically-messy response.
  json) printf 'Here are the verdicts:\n```json\n[{"id":"a","ok":true},{"id":"b","ok":false}]\n```\nDone.\n' > "${out:-/dev/stdout}" ;;
  *)     { printf 'STUB_OK\n'; printf '%s\n' "$input"; } > "${out:-/dev/stdout}" ;;
esac
exit 0
STUB
chmod +x "$STUBDIR/codex"
export PATH="$STUBDIR:$PATH"

echo "== arg validation =="
"$WRAP" --mode </dev/null 2>/dev/null;            expect_exit "missing value for --mode"  2 $?
"$WRAP" --mode bogus </dev/null 2>/dev/null;      expect_exit "invalid --mode"            2 $?
echo x | "$WRAP" --timeout abc 2>/dev/null;       expect_exit "non-numeric --timeout"     2 $?
echo x | "$WRAP" --timeout 0 2>/dev/null;         expect_exit "--timeout 0 rejected"      2 $?
printf '   \n' | "$WRAP" --mode prose 2>/dev/null; expect_exit "empty prose content"      2 $?

echo "== codex missing =="
( PATH="/usr/bin:/bin"; echo x | "$WRAP" --mode prose >/dev/null 2>&1 ); expect_exit "codex not found" 3 $?

echo "== prose happy path =="
OUT="$(printf 'The claim that X holds.' | "$WRAP" --mode prose --effort low 2>/dev/null)"; rc=$?
expect_exit "prose exit 0" 0 "$rc"
contains "$OUT" "STUB_OK"            "prose returns stub findings"
contains "$OUT" "CONTENT TO REVIEW"  "prose prompt carries the framing"
contains "$OUT" "The claim that X holds." "prose prompt carries the content"

echo "== advise mode =="
OUT="$(printf 'Should I use a queue or direct calls between services A and B?' | "$WRAP" --mode advise --effort low 2>/dev/null)"; rc=$?
expect_exit "advise exit 0" 0 "$rc"
contains "$OUT" "SITUATION / DECISION / CONTEXT" "advise prompt carries the advisor framing"
contains "$OUT" "queue or direct calls"          "advise prompt carries the decision"

echo "== scout mode =="
SR="$WORK/scoutrepo"; mkdir -p "$SR"   # scout requires --repo to be an existing dir
OUT="$(printf 'where does retry/backoff live, and what calls it?' | "$WRAP" --mode scout --repo "$SR" --effort low 2>/dev/null)"; rc=$?
expect_exit "scout exit 0" 0 "$rc"
contains "$OUT" "WHAT TO SCOUT FOR"   "scout prompt carries the scout framing"
contains "$OUT" "retry/backoff"       "scout prompt carries the recon task"
printf 'x' | "$WRAP" --mode scout --repo "$SR/nope" >/dev/null 2>&1; expect_exit "scout: missing --repo dir rejected" 2 $?

echo "== judge mode =="
JR="$WORK/judgerepo"; mkdir -p "$JR"
WL="$WORK/worklist.json"; printf '[{"id":"a","front":"x"},{"id":"b","front":"y"}]' > "$WL"
SCH="$WORK/schema.json"; printf '{"id":"<id>","verdict":"keep|fix","note":"<why>"}' > "$SCH"
# strict-fail: a prose (non-JSON) codex response -> exit 4, raw + prompt dumped to stderr.
EJ="$WORK/judge.err"
"$WRAP" --mode judge --file "$WL" --schema "$SCH" --focus "is each card too easy?" --repo "$JR" --effort low </dev/null >/dev/null 2>"$EJ"; rc=$?
expect_exit "judge: non-JSON codex output -> 4" 4 "$rc"
contains "$(cat "$EJ")" "WORKLIST TO JUDGE"        "judge prompt carries the judge framing"
contains "$(cat "$EJ")" "is each card too easy?"   "judge prompt carries the rubric focus"
contains "$(cat "$EJ")" "keep|fix"                 "judge prompt carries the output schema"
contains "$(cat "$EJ")" '"id":"a"'                 "judge prompt carries the worklist"
# happy path: messy (fenced + prose-wrapped) JSON -> wrapper returns clean compact JSON.
OJ="$(STUB_MODE=json "$WRAP" --mode judge --file "$WL" --schema "$SCH" --effort low </dev/null 2>/dev/null)"; rc=$?
expect_exit "judge: json output -> 0" 0 "$rc"
contains "$OJ" '[{"id":"a","ok":true},{"id":"b","ok":false}]' "judge extracts clean compact JSON"
if printf '%s' "$OJ" | grep -q '```'; then bad "judge strips markdown fences"; else ok "judge strips markdown fences"; fi
if printf '%s' "$OJ" | grep -q 'Here are the verdicts'; then bad "judge strips surrounding prose"; else ok "judge strips surrounding prose"; fi
# judge requires content (worklist) — empty -> usage error
"$WRAP" --mode judge --repo "$JR" </dev/null 2>/dev/null; expect_exit "judge: empty worklist rejected" 2 $?

echo "== diff happy path + untracked inclusion =="
R="$WORK/repo"; mkdir -p "$R"
( cd "$R" && git init -q && git config user.email t@t && git config user.name t \
  && printf 'one\n' > tracked.txt && git add tracked.txt && git commit -qm base \
  && printf 'one\ntwo\n' > tracked.txt && printf 'brand new file\n' > untracked.txt )
OUT="$("$WRAP" --mode diff --repo "$R" --effort low 2>/dev/null)"; rc=$?
expect_exit "diff exit 0" 0 "$rc"
contains "$OUT" "UNTRACKED"        "diff prompt has an untracked section"
contains "$OUT" "brand new file"   "untracked file content is included"
contains "$OUT" "+two"             "tracked change is included"

echo "== diff no-op / bad base =="
C="$WORK/clean"; mkdir -p "$C"
( cd "$C" && git init -q && git config user.email t@t && git config user.name t && echo x > a && git add a && git commit -qm base )
"$WRAP" --mode diff --repo "$C" >/dev/null 2>&1;             expect_exit "diff: no changes" 2 $?
"$WRAP" --mode diff --repo "$C" --base nope >/dev/null 2>&1; expect_exit "diff: bad base"   2 $?

echo "== codex failure / timeout =="
printf 'x' | STUB_MODE=fail  "$WRAP" --mode prose >/dev/null 2>&1;             expect_exit "codex non-zero -> 4" 4 $?
printf 'x' | STUB_MODE=empty "$WRAP" --mode prose >/dev/null 2>&1;             expect_exit "codex empty   -> 4" 4 $?
printf 'x' | STUB_MODE=hang  "$WRAP" --mode prose --timeout 1 >/dev/null 2>&1; expect_exit "timeout      -> 5" 5 $?

echo "== version-drift adaptation =="
printf x | STUB_FLAGS='--output-last-message --sandbox --ignore-rules --skip-git-repo-check' "$WRAP" --mode prose --effort low >/dev/null 2>"$WORK/e1"; rc=$?
expect_exit "missing hardening flag still runs" 0 "$rc"
contains "$(cat "$WORK/e1")" "lacks --ephemeral" "warns about the dropped flag"
printf x | STUB_FLAGS='--sandbox --ephemeral' "$WRAP" --mode prose >/dev/null 2>"$WORK/e2"; rc=$?
expect_exit "missing --output-last-message -> 6" 6 "$rc"
contains "$(cat "$WORK/e2")" "output-last-message" "explains the incompatibility"

echo "== doctor =="
"$WRAP" --doctor >/dev/null 2>&1;                        expect_exit "doctor: compatible -> 0"   0 $?
STUB_FLAGS='--sandbox' "$WRAP" --doctor >/dev/null 2>&1;  expect_exit "doctor: incompatible -> 6" 6 $?

# --- GPT-5.6 era: max/ultra efforts, explicit model, Luna+ultra guard -------------
echo "== effort allowlist (gpt-5.6 adds max + ultra) =="
AV="$WORK/argv"
for e in low medium high xhigh max ultra; do
  printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode prose --effort "$e" >/dev/null 2>&1
  expect_exit "--effort $e accepted" 0 $?
  contains "$(cat "$AV")" "model_reasoning_effort=$e" "--effort $e reaches codex"
done
printf 'x' | "$WRAP" --mode prose --effort bogus >/dev/null 2>&1
expect_exit "--effort bogus rejected (unknown values are forwarded verbatim and 400)" 2 $?

echo "== the ultra gate: ultra means delegation, or it means nothing =="
# `ultra` is the only CLI-side effort: the CLI maps Ultra->Max on the wire, and the sole
# thing it adds is MultiAgentMode::Proactive — which requires the multi_agent_v2 feature.
# With that feature off, ultra and max build byte-identical requests. So ultra must turn
# the feature on for the invocation, or refuse. It must never silently mean max.
printf 'x' | STUB_ARGV="$AV" STUB_V2=true "$WRAP" --mode prose --effort ultra >/dev/null 2>&1
expect_exit "ultra accepted when multi_agent_v2 can be enabled" 0 $?
contains "$(cat "$AV")" "features.multi_agent_v2=true" "ultra enables multi_agent_v2 for the invocation"
contains "$(cat "$AV")" "model_reasoning_effort=ultra" "ultra still reaches codex as ultra"

printf 'x' | STUB_ARGV="$AV" STUB_V2=true "$WRAP" --mode prose --effort max >/dev/null 2>&1
not_contains "$(cat "$AV")" "features.multi_agent_v2" "max does NOT enable multi_agent_v2"

: > "$AV"
printf 'x' | STUB_ARGV="$AV" STUB_V2=false "$WRAP" --mode prose --effort ultra >/dev/null 2>&1
expect_exit "ultra REFUSED (exit 6) when multi_agent_v2 is off — never silently downgraded" 6 $?
not_contains "$(cat "$AV")" "model_reasoning_effort" "refused ultra never reaches codex exec"

: > "$AV"
printf 'x' | STUB_ARGV="$AV" STUB_V2=missing "$WRAP" --mode prose --effort ultra >/dev/null 2>&1
expect_exit "ultra REFUSED (exit 6) when the feature no longer exists" 6 $?

echo "== hermetic model: always pass -m explicitly =="
# ~/.codex/config.toml is written concurrently by the ChatGPT.app Codex, so inheriting
# the configured model makes a review silently non-reproducible. Always pass -m.
printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode prose --effort low >/dev/null 2>&1
contains "$(cat "$AV")" "-m gpt-5.6-sol" "prose defaults to an explicit -m gpt-5.6-sol"
printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode prose --effort low --model gpt-5.6-terra >/dev/null 2>&1
contains "$(cat "$AV")" "-m gpt-5.6-terra" "--model overrides the default"

echo "== per-mode effort defaults =="
# `max` is the deepest SERVER effort and is exactly what ultra sent before the gate
# existed. Proactive fan-out is an opt-in, not a silent default: it multiplies tokens
# and engages an under-development orchestration layer.
printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode prose >/dev/null 2>&1
contains "$(cat "$AV")" "model_reasoning_effort=max" "prose defaults to max"
not_contains "$(cat "$AV")" "features.multi_agent_v2" "prose does not fan out by default"
printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode advise >/dev/null 2>&1
contains "$(cat "$AV")" "model_reasoning_effort=max" "advise defaults to max"
printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode verify --repo "$WORK" >/dev/null 2>&1
contains "$(cat "$AV")" "model_reasoning_effort=high" "verify defaults to high (retrieval, not reasoning)"
SR2="$WORK/scoutrepo2"; mkdir -p "$SR2"
printf 'x' | STUB_ARGV="$AV" "$WRAP" --mode scout --repo "$SR2" >/dev/null 2>&1
contains "$(cat "$AV")" "model_reasoning_effort=low" "scout defaults to low (cheap targeting is the mode's purpose)"
STUB_MODE=json STUB_ARGV="$AV" "$WRAP" --mode judge --file "$WL" --schema "$SCH" </dev/null >/dev/null 2>&1
contains "$(cat "$AV")" "model_reasoning_effort=xhigh" "judge defaults to xhigh (strict JSON at volume, no fan-out)"

echo "== Luna + ultra guard =="
# Luna advertises low..max — no ultra. The CLI accepts --effort ultra on Luna WITHOUT
# error, so a silent downgrade is indistinguishable from success. Reject it loudly.
printf 'x' | "$WRAP" --mode prose --model gpt-5.6-luna --effort ultra >/dev/null 2>&1
expect_exit "luna + ultra rejected" 2 $?
printf 'x' | "$WRAP" --mode prose --model gpt-5.6-luna --effort max >/dev/null 2>&1
expect_exit "luna + max allowed (luna supports max)" 0 $?
# bash `case` is case-sensitive; an uppercase slug used to sail straight past the guard
# into the silent downgrade the guard exists to prevent.
printf 'x' | "$WRAP" --mode prose --model gpt-5.6-LUNA --effort ultra >/dev/null 2>&1
expect_exit "luna guard is case-insensitive (gpt-5.6-LUNA + ultra rejected)" 2 $?
# Sol supports ultra, and 'luna' must not match as a substring of some other slug.
printf 'x' | STUB_V2=true "$WRAP" --mode prose --model gpt-5.6-terra --effort ultra >/dev/null 2>&1
expect_exit "terra + ultra allowed (terra supports ultra)" 0 $?

echo
# The budget library is tested with node's runner. run.sh used to skip it entirely, so a
# green wrapper suite said nothing about ai-budget-lib.mjs. One command, one verdict.
echo "== ai-budget library (node --test) =="
if command -v node >/dev/null 2>&1; then
  if node --test "$(dirname "$0")/ai-budget.test.mjs" >"$WORK/nodetest.out" 2>&1; then
    ok "ai-budget.test.mjs: $(grep -E '^# pass' "$WORK/nodetest.out" | tr -dc '0-9') passing"
  else
    bad "ai-budget.test.mjs failed"
    grep -E '^not ok' "$WORK/nodetest.out" | head -10
  fi
else
  bad "node not found — ai-budget library untested"
fi

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
