# Maintenance & Codex version compatibility

This wrapper drives the `codex` CLI through a small, specific surface — and that surface is
the main thing that breaks as Codex evolves. The wrapper is built to **degrade gracefully and
fail loudly** rather than silently. This doc maps each coupling point, how the wrapper handles
a change today, and what to do if Codex changes it.

Tested against **Codex CLI 0.144.1**. Run `codex-adversary.sh --doctor` to check your build.

## The Codex surface we depend on

| Dependency | Used for | If Codex changes it |
|---|---|---|
| `codex exec` subcommand | the whole non-interactive path | preflight runs `codex exec --help`; if it fails → **exit 6** with a clear message |
| `--output-last-message FILE` | clean capture of only the final answer | **required** — preflight checks it → **exit 6** if absent. See the `--json` fallback below |
| `--sandbox read-only` | the read-only safety guarantee | load-bearing for safety; if renamed, update the constant in `build_codex_cmd` — do **not** silently drop it, a review must stay read-only |
| `--ephemeral`, `--ignore-rules`, `--skip-git-repo-check` | hardening | each is **auto-dropped with a stderr note** if absent from `--help` (graceful) |
| `-c model_reasoning_effort=<v>` | per-pass effort | generic config override; if the key is renamed, update `build_codex_cmd` |
| `-C DIR` | root Codex in a repo / temp dir | stable; if renamed, update the prose/diff/advise branches |
| `-m MODEL` | model selection | **always** passed (default `gpt-5.6-sol`). `~/.codex/config.toml` is rewritten by other Codex clients (the ChatGPT.app Codex), so an inherited model is non-reproducible. If a slug is retired, update `DEFAULT_MODEL` |

## Anticipated breakage modes (and the fix)

1. **A hardening flag is renamed/removed.** Self-heals: `codex_supports` drops it with a note.
   Nothing to do unless you want the capability back under the new name.
2. **`--output-last-message` is removed.** Implement the `--json` fallback: run `codex exec
   --json`, capture stdout, and extract the final assistant message from the JSONL stream into
   `$OUT_FILE`. Gate it behind `codex_supports "--json"` and prefer `--output-last-message`
   when present. This is the single most important fallback to add if the essential capture
   flag ever changes.
3. **`--sandbox` mode names change** (`read-only` → something else). Update the `--sandbox`
   value in `build_codex_cmd`; keep it read-only and re-verify Codex cannot write during a
   review (the safety claim in the README depends on it).
4. **Effort values change** (e.g. `xhigh` dropped, or a model rejects it). The wrapper passes
   the value verbatim. Update the `--effort` validation `case` (`VALID_EFFORTS`), the skill's
   rubric, and consider a `codex_supports`-style guard. A rejected effort surfaces as exit 4.
   **This happened on 2026-07-09 (GPT-5.6):** `max` and `ultra` were added *above* `xhigh`.
   They are **not the same kind of thing**, and the distinction is load-bearing:
   - `max` is a **server** effort. `ReasoningEffort::as_str()` in `codex-rs/protocol` is
     documented "the exact value used on the wire" and emits `"max"`; nothing maps it down.
   - `ultra` is **CLI-side**. `core/src/client.rs::reasoning_effort_for_request()` maps
     `Ultra => Max` before the request, so the wire sees `max`. Its sole extra effect is
     `MultiAgentMode::Proactive` — and `session/multi_agents.rs::effective_multi_agent_mode()`
     returns `None` unless `multi_agent_version == V2`, which `config/mod.rs` grants only when
     the `multi_agent_v2` feature is on. That feature ships **off** ("under development").

   So with the feature off, `ultra` and `max` build byte-identical requests: `ultra` would be
   a lie. The wrapper therefore enables `features.multi_agent_v2` per-invocation for `ultra`
   and **exits 6 if it cannot** (see `ultra_v2_available`). If a future Codex renames or
   removes that feature, the gate fails closed and `ultra` is refused — which is correct.
   Re-check `ultra_v2_available`'s parse of `codex features list` when the CLI changes.

   An **unknown** effort value is forwarded verbatim and 400s, so keep `VALID_EFFORTS` an
   explicit allowlist; do not relax it to "anything goes".
   Note also that **Luna accepts `--effort ultra` without error despite not supporting it** —
   a silent downgrade. The wrapper refuses that pair (case-insensitively); re-check the guard
   when variants change: only Sol and Terra list `ultra` in `supported_reasoning_levels`.
5. **Auth/login flow changes.** The wrapper doesn't touch auth; a logged-out Codex surfaces as
   **exit 4**. README troubleshooting points users at `codex login`.
6. **`codex exec --help` output format changes** so `grep` misses a flag that is actually
   present. `codex_supports` would false-negative and drop a hardening flag (low impact) — but
   if it ever hid `--output-last-message` you'd get a spurious exit 6. Re-check the grep
   patterns against the new `--help` and bump the tested version.
7. **Job control unavailable** in the pure-bash timeout fallback. The wrapper detects whether
   `set -m` engaged and falls back to single-PID kill; with GNU `timeout`/`gtimeout` it uses
   `-k`. If a platform breaks this, the timeout still fires — just less thorough on
   grandchildren.
8. **`rate_limits` telemetry shape changes.** `ai-budget` reads `~/.codex/sessions/**/*.jsonl`.
   Three properties of that data are load-bearing and non-obvious; each has already produced a
   wrong budget reading:
   - **`timestamp` is when the line was WRITTEN, not when the reading was taken.** Resumed and
     forked sessions replay historical snapshots with fresh timestamps. Never order by it.
   - **The logs interleave different limits.** `limit_id` separates the general quota
     (`codex`) from per-model quotas (`codex_bengalfox`); `plan_type` separates plans, and a
     stale plan's exhausted window coexists with the live one. Only the plan in the
     `id_token` governs your calls — hence `codexPlanFromIdToken`. If OpenAI moves that claim,
     the function returns `null`, the plan filter is skipped, and readings get pessimistic
     rather than wrong. Re-point it, don't remove it.
   - **Several window instances are live at once per plan** (observed: `codex`/`pro` at
     `used=29` and `used=100` simultaneously). Take the **binding** one — the highest
     `used_percent` among unexpired instances. Any live window at 100% refuses the call,
     however few snapshots name it. Do not select by consensus or by furthest reset; both
     answer a question nobody asked, and both need machinery to avoid the optimistic failure.
   - **`used_percent` never decreases within a session** (0 decreases / 37 sessions). There is
     no reservation-and-refund scheme; usage accrues. If a future Codex *does* refund, the
     `max()` would latch at the peak and under-report headroom for the rest of the window —
     re-run the in-session monotonicity check before trusting it.

   The reported figure is the general `codex` limit, which gates `gpt-5.6-sol`. It does **not**
   predict every model: Luna and `codex_bengalfox` (*GPT-5.3-Codex-Spark*) were both served
   while that limit read 100% used — which is why Codex appears to "keep working after running
   out". Treat the whole thing as advisory; the only certain check is a cheap call **with the
   model you will actually run**:
   `codex exec -m gpt-5.6-sol -c model_reasoning_effort=low ... "Reply: OK"`.

## When you bump the supported Codex version

1. `./bin/codex-adversary.sh --doctor` — confirm all flags present, and that it still reports
   `ultra (multi_agent_v2): available`. If that flips to UNAVAILABLE, `ultra` is refused by
   design; check whether the feature was renamed before relaxing the gate.
2. `./test/run.sh` (stubbed; it now also runs the `ai-budget` node tests) plus one live
   `--mode prose`, `--mode diff`, and `--mode scout` smoke.
3. Re-verify the safety claim: subagents spawned under `--effort ultra` must still inherit the
   read-only sandbox. Test with a write canary, not by asking the model.
4. Cross-check `ai-budget read` against a live call **using `-m gpt-5.6-sol`** — if it says 0%
   left and a *Sol* call is served, the window-selection rule has drifted (see 8). Do not probe
   with Luna: it was observed served while the general `codex` limit read 100% used.
5. Update "Tested against …" here and in `README.md`.
6. Note it in `CHANGELOG.md`.

## Test surface

`test/run.sh` stubs `codex` (no network) and covers arg handling, exit codes, prompt
assembly, diff scope (including untracked files), the timeout path, **version-drift
adaptation** (simulating missing flags via `STUB_FLAGS`), and `--doctor`. CI also runs
`shellcheck`. Keep new behavior covered there — the stub's `--help` output is the seam for
simulating other Codex versions.
