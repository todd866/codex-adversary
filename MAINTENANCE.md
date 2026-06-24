# Maintenance & Codex version compatibility

This wrapper drives the `codex` CLI through a small, specific surface — and that surface is
the main thing that breaks as Codex evolves. The wrapper is built to **degrade gracefully and
fail loudly** rather than silently. This doc maps each coupling point, how the wrapper handles
a change today, and what to do if Codex changes it.

Tested against **Codex CLI 0.139.0**. Run `codex-adversary.sh --doctor` to check your build.

## The Codex surface we depend on

| Dependency | Used for | If Codex changes it |
|---|---|---|
| `codex exec` subcommand | the whole non-interactive path | preflight runs `codex exec --help`; if it fails → **exit 6** with a clear message |
| `--output-last-message FILE` | clean capture of only the final answer | **required** — preflight checks it → **exit 6** if absent. See the `--json` fallback below |
| `--sandbox read-only` | the read-only safety guarantee | load-bearing for safety; if renamed, update the constant in `build_codex_cmd` — do **not** silently drop it, a review must stay read-only |
| `--ephemeral`, `--ignore-rules`, `--skip-git-repo-check` | hardening | each is **auto-dropped with a stderr note** if absent from `--help` (graceful) |
| `-c model_reasoning_effort=<v>` | per-pass effort | generic config override; if the key is renamed, update `build_codex_cmd` |
| `-C DIR` | root Codex in a repo / temp dir | stable; if renamed, update the prose/diff/advise branches |
| `-m MODEL` | optional model override | only used with `--model` |

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
   the value verbatim. Update the `--effort` validation `case`, the skill's rubric, and
   consider a `codex_supports`-style guard. A rejected effort currently surfaces as exit 4.
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

## When you bump the supported Codex version

1. `./bin/codex-adversary.sh --doctor` — confirm all flags present.
2. `./test/run.sh` (stubbed) plus one live `--mode prose` and `--mode diff` smoke.
3. Update "Tested against …" here and in `README.md`.
4. Note it in `CHANGELOG.md`.

## Test surface

`test/run.sh` stubs `codex` (no network) and covers arg handling, exit codes, prompt
assembly, diff scope (including untracked files), the timeout path, **version-drift
adaptation** (simulating missing flags via `STUB_FLAGS`), and `--doctor`. CI also runs
`shellcheck`. Keep new behavior covered there — the stub's `--help` output is the seam for
simulating other Codex versions.
