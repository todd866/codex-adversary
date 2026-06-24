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

# --- stub `codex`: captures the prompt it's handed; mode set via $STUB_MODE -------
STUBDIR="$WORK/stubbin"; mkdir -p "$STUBDIR"
cat > "$STUBDIR/codex" <<'STUB'
#!/usr/bin/env bash
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output-last-message" ] && out="$a"; prev="$a"; done
input="$(cat)"
case "${STUB_MODE:-ok}" in
  hang)  sleep 30 ;;
  fail)  echo "stub: simulated failure" >&2; exit 1 ;;
  empty) : > "${out:-/dev/null}"; exit 0 ;;
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

echo
echo "passed: $PASS, failed: $FAIL"
[ "$FAIL" -eq 0 ]
