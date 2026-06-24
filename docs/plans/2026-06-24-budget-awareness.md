# Budget Awareness & Guardrail — Implementation Plan (Feature 1 of 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A background service that publishes Claude + Codex token-budget (rate-limit) state to a local JSON file, and hooks that poll it so Claude is aware of both budgets and frugal near its limit.

**Architecture:** Node (ESM, zero deps — `node:test`, global `fetch`, `fs`). Pure parsers in `bin/ai-budget-lib.mjs`; CLI `bin/ai-budget.mjs` with `refresh` (the launchd service: read sources, publish JSON) and `read` / `if-below` (the hook readers: poll JSON). `install.sh` installs the LaunchAgent + merges three hooks into `~/.claude/settings.json`.

**Tech Stack:** Node 18+ (ESM, built-in test runner + fetch), bash (`install.sh`), macOS launchd, `security` CLI (Keychain).

**Spec:** `docs/specs/2026-06-24-budget-awareness-design.md`

## Global Constraints

- Zero runtime dependencies (Node built-ins only). Tests use `node:test` / `node:assert`.
- **Readers (`read` / `if-below`) must never block, prompt, network, or throw** — they only read one local JSON file; on any error they print nothing (or a staleness note) and exit 0.
- All the fragile I/O (Keychain, network, file globbing) lives ONLY in `refresh` (the out-of-band service).
- Published state path: `~/.claude/.cache/ai-budget.json`. Atomic write (temp + rename).
- Codex: `primary`=5-hour (`window_minutes` 300), `secondary`=weekly (10080); `remaining% = 100 − used_percent`; drop windows whose `resets_at` (epoch s) is already past.
- Claude limits: Keychain service `Claude Code-credentials` → `claudeAiOauth.accessToken` → `GET https://api.anthropic.com/api/oauth/usage` (header `Authorization: Bearer <token>`).
- Claude spend (transcripts `~/.claude/projects/**/*.jsonl`): `uncached = input + cache_creation + output`; `cachedInclusive = uncached + cache_read`.
- Threshold default for `if-below`: 30. "Stale" = published `generatedAt` older than 15 min.
- Commit messages end with: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`

## File structure
- `bin/ai-budget-lib.mjs` — pure functions (parsers + formatters). The testable core.
- `bin/ai-budget.mjs` — CLI: `refresh` | `read` | `if-below <pct>`. I/O only.
- `test/ai-budget.test.mjs` — `node:test` over the lib.
- `bin/com.codex-adversary.ai-budget.plist.template` — LaunchAgent template (install.sh fills `__BIN__`).
- `skills/budget-aware-allocation/SKILL.md` — the guardrail skill.
- `install.sh` — modified: copy ai-budget files, install/bootstrap the LaunchAgent, merge hooks.

---

## Task 1: Codex rate-limit parser

**Files:**
- Create: `bin/ai-budget-lib.mjs`
- Test: `test/ai-budget.test.mjs`

**Interfaces:**
- Produces: `parseCodexRateLimits(lines: string[], nowEpoch: number): { fiveHourPct: number|null, weeklyPct: number|null, resetsAt: number|null } | null` — `lines` are raw JSONL lines from the newest codex session; picks the last line carrying a `rate_limits` object; `*Pct` = remaining %; `resetsAt` = the weekly window's epoch reset. Returns `null` if no usable rate_limits.

- [ ] **Step 1: Write the failing test**

```js
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCodexRateLimits } from '../bin/ai-budget-lib.mjs';

test('parseCodexRateLimits: remaining = 100 - used_percent, weekly resetsAt', () => {
  const now = 1782300000;
  const line = JSON.stringify({ type: 'token_count', payload: { rate_limits: {
    primary:   { used_percent: 1.0,  window_minutes: 300,   resets_at: 1782314385 },
    secondary: { used_percent: 19.0, window_minutes: 10080, resets_at: 1782358258 },
  }}});
  const r = parseCodexRateLimits(['{}', line], now);
  assert.equal(r.fiveHourPct, 99);
  assert.equal(r.weeklyPct, 81);
  assert.equal(r.resetsAt, 1782358258);
});

test('parseCodexRateLimits: drops an already-reset window, returns null when none usable', () => {
  const now = 1782400000; // after both resets
  const line = JSON.stringify({ rate_limits: {
    primary:   { used_percent: 5, window_minutes: 300,   resets_at: 1782314385 },
    secondary: { used_percent: 5, window_minutes: 10080, resets_at: 1782358258 },
  }});
  const r = parseCodexRateLimits([line], now);
  assert.equal(r.fiveHourPct, null);
  assert.equal(r.weeklyPct, null);
});

test('parseCodexRateLimits: no rate_limits anywhere → null', () => {
  assert.equal(parseCodexRateLimits(['{"type":"message"}', 'not json'], 1782300000), null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ai-budget.test.mjs`
Expected: FAIL — `parseCodexRateLimits` is not exported / file missing.

- [ ] **Step 3: Implement**

In `bin/ai-budget-lib.mjs`:

```js
// Deep-find the first object that looks like a codex rate_limits dict.
function findRateLimits(obj) {
  if (!obj || typeof obj !== 'object') return null;
  if (obj.rate_limits && typeof obj.rate_limits === 'object') return obj.rate_limits;
  if (obj.primary && obj.secondary) return obj; // already the dict
  for (const v of Object.values(obj)) {
    const found = findRateLimits(v);
    if (found) return found;
  }
  return null;
}

function windowRemaining(win, nowEpoch) {
  if (!win || typeof win.used_percent !== 'number') return null;
  if (typeof win.resets_at === 'number' && win.resets_at > 0 && win.resets_at <= nowEpoch) return null; // reset elapsed
  return Math.round(100 - win.used_percent);
}

export function parseCodexRateLimits(lines, nowEpoch) {
  let rl = null;
  for (const line of lines) {           // last line that carries rate_limits wins
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const found = findRateLimits(obj);
    if (found) rl = found;
  }
  if (!rl) return null;
  const weeklyReset = rl.secondary && typeof rl.secondary.resets_at === 'number'
    && rl.secondary.resets_at > nowEpoch ? rl.secondary.resets_at : null;
  return {
    fiveHourPct: windowRemaining(rl.primary, nowEpoch),
    weeklyPct: windowRemaining(rl.secondary, nowEpoch),
    resetsAt: weeklyReset,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ai-budget.test.mjs`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add bin/ai-budget-lib.mjs test/ai-budget.test.mjs
git commit -m "feat(budget): codex rate-limit parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Claude transcript token-sum parser

**Files:**
- Modify: `bin/ai-budget-lib.mjs`
- Test: `test/ai-budget.test.mjs`

**Interfaces:**
- Produces: `sumClaudeTranscriptTokens(lines: string[], nowMs: number): { todayUncached, today, sevenDayUncached, sevenDay }` (token counts). A line counts when its `message.usage` exists; bucketed by `line.timestamp` (ISO) into today (same UTC date as `nowMs`) and last-7-days. `uncached = input + cache_creation + output`; full adds `cache_read`.

- [ ] **Step 1: Write the failing test**

```js
import { sumClaudeTranscriptTokens } from '../bin/ai-budget-lib.mjs';

test('sumClaudeTranscriptTokens: today vs 7d, uncached vs cached-inclusive', () => {
  const now = Date.parse('2026-06-24T12:00:00Z');
  const mk = (ts, i, o, cc, cr) => JSON.stringify({
    timestamp: ts, message: { usage: {
      input_tokens: i, output_tokens: o, cache_creation_input_tokens: cc, cache_read_input_tokens: cr } } });
  const lines = [
    mk('2026-06-24T09:00:00Z', 100, 50, 10, 1000), // today
    mk('2026-06-20T09:00:00Z', 200, 80, 0, 500),   // within 7d, not today
    mk('2026-06-10T09:00:00Z', 999, 999, 0, 0),    // older than 7d
    '{"type":"user"}',                              // no usage → ignored
  ];
  const r = sumClaudeTranscriptTokens(lines, now);
  assert.equal(r.todayUncached, 160);          // 100+10+50
  assert.equal(r.today, 1160);                 // +1000 cache_read
  assert.equal(r.sevenDayUncached, 160 + 280); // +(200+0+80)
  assert.equal(r.sevenDay, 1160 + 780);        // +(280+500)
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/ai-budget.test.mjs`
Expected: FAIL — `sumClaudeTranscriptTokens` not exported.

- [ ] **Step 3: Implement**

Append to `bin/ai-budget-lib.mjs`:

```js
export function sumClaudeTranscriptTokens(lines, nowMs) {
  const dayMs = 86400000;
  const todayUTC = new Date(nowMs).toISOString().slice(0, 10);
  const sevenDayFloor = nowMs - 7 * dayMs;
  let todayUncached = 0, today = 0, sevenDayUncached = 0, sevenDay = 0;
  for (const line of lines) {
    if (!line.includes('"usage"')) continue;           // cheap pre-filter
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const u = obj?.message?.usage ?? obj?.usage;
    const ts = obj?.timestamp;
    if (!u || !ts) continue;
    const t = Date.parse(ts);
    if (Number.isNaN(t)) continue;
    const uncached = (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0);
    const full = uncached + (u.cache_read_input_tokens || 0);
    if (t >= sevenDayFloor) { sevenDayUncached += uncached; sevenDay += full; }
    if (ts.slice(0, 10) === todayUTC) { todayUncached += uncached; today += full; }
  }
  return { todayUncached, today, sevenDayUncached, sevenDay };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/ai-budget.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/ai-budget-lib.mjs test/ai-budget.test.mjs
git commit -m "feat(budget): claude transcript token-sum parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Claude OAuth-usage window parser

**Files:**
- Modify: `bin/ai-budget-lib.mjs`
- Test: `test/ai-budget.test.mjs`

**Interfaces:**
- Produces: `parseClaudeUsageWindows(usage: object, nowEpoch: number): { fiveHourPct: number|null, weeklyPct: number|null, resetsAt: number|null }` — `usage` is the parsed body of `GET /api/oauth/usage`. Tolerates `utilization` as fraction (0–1) or percent (0–100) and `resets_at` as epoch or ISO. Windows named `five_hour` and `seven_day`.

- [ ] **Step 1: Write the failing test**

```js
import { parseClaudeUsageWindows } from '../bin/ai-budget-lib.mjs';

test('parseClaudeUsageWindows: fraction utilization + ISO reset', () => {
  const now = Math.floor(Date.parse('2026-06-24T12:00:00Z') / 1000);
  const usage = {
    five_hour: { utilization: 0.38, resets_at: '2026-06-24T13:30:00Z' },
    seven_day: { utilization: 0.82, resets_at: '2026-06-25T13:30:00Z' },
  };
  const r = parseClaudeUsageWindows(usage, now);
  assert.equal(r.fiveHourPct, 62);
  assert.equal(r.weeklyPct, 18);
  assert.equal(r.resetsAt, Math.floor(Date.parse('2026-06-25T13:30:00Z') / 1000));
});

test('parseClaudeUsageWindows: percent utilization + epoch reset, missing windows → null', () => {
  const now = 1782300000;
  const r = parseClaudeUsageWindows({ five_hour: { utilization: 40, resets_at: 1782314385 } }, now);
  assert.equal(r.fiveHourPct, 60);
  assert.equal(r.weeklyPct, null);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `node --test test/ai-budget.test.mjs` → FAIL (not exported).

- [ ] **Step 3: Implement**

Append to `bin/ai-budget-lib.mjs`:

```js
function pctRemaining(win) {
  if (!win || win.utilization == null) return null;
  const u = Number(win.utilization);
  if (Number.isNaN(u)) return null;
  const usedPct = u <= 1 ? u * 100 : u;           // fraction-or-percent tolerant
  return Math.round(100 - usedPct);
}
function toEpoch(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : Math.floor(t / 1000);
}
export function parseClaudeUsageWindows(usage, nowEpoch) {
  const fh = usage?.five_hour, wk = usage?.seven_day;
  const reset = (w) => { const e = toEpoch(w?.resets_at); return e && e > nowEpoch ? e : null; };
  return {
    fiveHourPct: pctRemaining(fh),
    weeklyPct: pctRemaining(wk),
    resetsAt: reset(wk),
  };
}
```

- [ ] **Step 4: Run to verify it passes** — `node --test test/ai-budget.test.mjs` → PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/ai-budget-lib.mjs test/ai-budget.test.mjs
git commit -m "feat(budget): claude OAuth-usage window parser

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Snapshot formatter + threshold + staleness

**Files:**
- Modify: `bin/ai-budget-lib.mjs`
- Test: `test/ai-budget.test.mjs`

**Interfaces:**
- Consumes: published-state object `{ generatedAt: ISO, claude:{fiveHourPct,weeklyPct,resetsAt,spentToday,spent7d}|null, codex:{...}|null }`.
- Produces:
  - `lowestPct(state): number|null` — the smallest non-null window % across both providers.
  - `formatSnapshot(state, nowMs): string` — the human snapshot (2 lines), with an "as of …" age and a "⚠ stale" note if `generatedAt` > 15 min old.
  - `formatIfBelow(state, pct, nowMs): string` — `''` when no window < `pct`; else the low lines + the allocation hint.

- [ ] **Step 1: Write the failing test**

```js
import { lowestPct, formatSnapshot, formatIfBelow } from '../bin/ai-budget-lib.mjs';

const STATE = {
  generatedAt: '2026-06-24T12:00:00Z',
  claude: { fiveHourPct: 62, weeklyPct: 18, resetsAt: 1782358258, spentToday: 4100000, spent7d: 22000000 },
  codex:  { fiveHourPct: 99, weeklyPct: 81, resetsAt: 1782358258, spentToday: 0, spent7d: 2900000 },
};
const now = Date.parse('2026-06-24T12:00:40Z'); // 40s later

test('lowestPct picks the smallest window', () => {
  assert.equal(lowestPct(STATE), 18);
});
test('formatSnapshot mentions both providers and the age', () => {
  const s = formatSnapshot(STATE, now);
  assert.match(s, /Claude/); assert.match(s, /Codex/);
  assert.match(s, /18%/); assert.match(s, /as of/);
});
test('formatIfBelow: silent when all >= pct, speaks + hints when below', () => {
  assert.equal(formatIfBelow(STATE, 10, now), '');           // 18 >= 10 → silent
  const s = formatIfBelow(STATE, 30, now);                    // 18 < 30 → speak
  assert.match(s, /Claude weekly low|18%/);
  assert.match(s, /Codex/);                                   // imbalance hint
});
test('formatSnapshot flags stale state', () => {
  const stale = Date.parse('2026-06-24T12:20:00Z');           // 20 min later
  assert.match(formatSnapshot(STATE, stale), /stale/i);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (not exported).

- [ ] **Step 3: Implement**

Append to `bin/ai-budget-lib.mjs`:

```js
const fmtTok = (n) => n == null ? 'n/a'
  : n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'
  : n >= 1e3 ? Math.round(n / 1e3) + 'K' : String(n);
const pct = (p) => p == null ? 'n/a' : p + '%';

function ageStr(generatedAt, nowMs) {
  const t = Date.parse(generatedAt);
  if (Number.isNaN(t)) return { mins: Infinity, label: 'unknown age' };
  const mins = (nowMs - t) / 60000;
  const label = mins < 1.5 ? `as of ${Math.round(mins * 60)}s ago` : `as of ${Math.round(mins)}m ago`;
  return { mins, label };
}

const allPcts = (p) => p ? [p.fiveHourPct, p.weeklyPct].filter((x) => typeof x === 'number') : [];
export function lowestPct(state) {
  const xs = [...allPcts(state?.claude), ...allPcts(state?.codex)];
  return xs.length ? Math.min(...xs) : null;
}

function providerLine(name, p) {
  if (!p) return `${name.padEnd(6)} n/a`;
  return `${name.padEnd(6)} 5h ${pct(p.fiveHourPct)} · week ${pct(p.weeklyPct)} · `
       + `spent ${fmtTok(p.spentToday)} today / ${fmtTok(p.spent7d)} 7d`;
}

export function formatSnapshot(state, nowMs) {
  const { mins, label } = ageStr(state?.generatedAt, nowMs);
  const stale = mins > 15 ? ' ⚠ stale — service may be down' : '';
  return [providerLine('Claude', state?.claude), providerLine('Codex', state?.codex), `(${label}${stale})`].join('\n');
}

export function formatIfBelow(state, threshold, nowMs) {
  const low = lowestPct(state);
  if (low == null || low >= threshold) return '';
  const lines = [`⚠ token budget low (${low}% on the tightest window):`,
    providerLine('Claude', state?.claude), providerLine('Codex', state?.codex)];
  const c = state?.claude, x = state?.codex;
  const claudeLow = c && Math.min(...allPcts(c).concat(101)) < threshold;
  const codexHigh = x && Math.min(...allPcts(x).concat(101)) >= 50;
  if (claudeLow && codexHigh) {
    lines.push('→ Claude is the constraint; Codex has idle budget. Prefer routing heavy/parallel '
      + 'work to Codex and stay lean. Be deliberate before any big token spend.');
  } else {
    lines.push('→ Be deliberate before any big token spend; consider lower effort / batching.');
  }
  const { label } = ageStr(state?.generatedAt, nowMs);
  lines.push(`(${label})`);
  return lines.join('\n');
}
```

- [ ] **Step 4: Run to verify it passes** — PASS.

- [ ] **Step 5: Commit**

```bash
git add bin/ai-budget-lib.mjs test/ai-budget.test.mjs
git commit -m "feat(budget): snapshot formatter, threshold gate, staleness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `ai-budget.mjs` — the `refresh` service

**Files:**
- Create: `bin/ai-budget.mjs`

**Interfaces:**
- Consumes: all four lib functions.
- Produces: CLI `node ai-budget.mjs refresh` → reads sources, writes `~/.claude/.cache/ai-budget.json` atomically. (Reader modes added in Task 6.)

This task is I/O integration; verification is running it on a machine with real data, not a unit test (the parsers are already covered).

- [ ] **Step 1: Implement `refresh`**

`bin/ai-budget.mjs`:

```js
#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCodexRateLimits, sumClaudeTranscriptTokens, parseClaudeUsageWindows } from './ai-budget-lib.mjs';

const HOME = homedir();
const STATE = join(HOME, '.claude', '.cache', 'ai-budget.json');

function newestCodexSessionLines() {
  const root = join(HOME, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  let newest = null, newestMtime = 0;
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl')) { const m = statSync(p).mtimeMs; if (m > newestMtime) { newestMtime = m; newest = p; } }
  }};
  try { walk(root); } catch { return []; }
  if (!newest) return [];
  try { return readFileSync(newest, 'utf8').split('\n').filter(Boolean); } catch { return []; }
}

function allTranscriptLines() {
  const root = join(HOME, '.claude', 'projects');
  if (!existsSync(root)) return [];
  const out = [];
  const cutoff = Date.now() - 8 * 86400000; // only files touched in the last 8d
  const walk = (dir) => { for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.jsonl') && statSync(p).mtimeMs >= cutoff) {
      try { out.push(...readFileSync(p, 'utf8').split('\n').filter(Boolean)); } catch {}
    }
  }};
  try { walk(root); } catch {}
  return out;
}

async function claudeWindows(nowEpoch) {
  let token = null;
  try {
    const blob = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    token = JSON.parse(blob)?.claudeAiOauth?.accessToken ?? null;
  } catch { return null; }            // not macOS / denied / no item
  if (!token) return null;
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/usage', {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return parseClaudeUsageWindows(await res.json(), nowEpoch);
  } catch { return null; }
}

async function refresh() {
  const nowMs = Date.now(), nowEpoch = Math.floor(nowMs / 1000);
  const codexRL = parseCodexRateLimits(newestCodexSessionLines(), nowEpoch);
  const tlines = allTranscriptLines();
  const claudeSpend = sumClaudeTranscriptTokens(tlines, nowMs);
  const claudeWin = await claudeWindows(nowEpoch);
  const state = {
    generatedAt: new Date(nowMs).toISOString(),
    claude: claudeWin || claudeSpend ? {
      fiveHourPct: claudeWin?.fiveHourPct ?? null,
      weeklyPct: claudeWin?.weeklyPct ?? null,
      resetsAt: claudeWin?.resetsAt ?? null,
      spentToday: claudeSpend.today, spent7d: claudeSpend.sevenDay,
    } : null,
    codex: codexRL ? { ...codexRL, spentToday: null, spent7d: null } : null,
  };
  mkdirSync(join(HOME, '.claude', '.cache'), { recursive: true });
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, STATE);
}

const cmd = process.argv[2];
if (cmd === 'refresh') { await refresh(); }
```

- [ ] **Step 2: Run it for real**

Run: `node bin/ai-budget.mjs refresh && cat ~/.claude/.cache/ai-budget.json`
Expected: a JSON file with `codex` populated (5h/weekly %), `claude.spentToday`/`spent7d` populated; `claude.*Pct` populated **if** the Keychain "Always Allow" was granted, else `null`. No crash either way. (First run may show the macOS Keychain prompt — click Always Allow.)

- [ ] **Step 3: Commit**

```bash
git add bin/ai-budget.mjs
git commit -m "feat(budget): refresh service — read sources, publish state JSON

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `ai-budget.mjs` — `read` / `if-below` readers

**Files:**
- Modify: `bin/ai-budget.mjs`
- Test: `test/ai-budget.test.mjs` (a reader-from-fixture test)

**Interfaces:**
- Produces: `node ai-budget.mjs read` → prints `formatSnapshot`; `node ai-budget.mjs if-below <pct>` → prints `formatIfBelow` (or nothing). Both read ONLY `~/.claude/.cache/ai-budget.json`; missing/garbage file → print nothing, exit 0.
- Produces (testable): `readState(path): object|null`.

- [ ] **Step 1: Write the failing test**

```js
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readState } from '../bin/ai-budget.mjs';

test('readState returns parsed JSON, or null when missing/garbage', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aib-'));
  const good = join(dir, 'good.json'); writeFileSync(good, JSON.stringify({ generatedAt: 'x' }));
  assert.equal(readState(good).generatedAt, 'x');
  assert.equal(readState(join(dir, 'missing.json')), null);
  const bad = join(dir, 'bad.json'); writeFileSync(bad, 'not json');
  assert.equal(readState(bad), null);
});
```

- [ ] **Step 2: Run to verify it fails** — FAIL (`readState` not exported).

- [ ] **Step 3: Implement**

Add to `bin/ai-budget.mjs` (export `readState`; extend the CLI dispatch). Import the formatters:

```js
import { parseCodexRateLimits, sumClaudeTranscriptTokens, parseClaudeUsageWindows,
         formatSnapshot, formatIfBelow } from './ai-budget-lib.mjs';

export function readState(path = STATE) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

// replace the trailing dispatch with:
const cmd = process.argv[2];
if (cmd === 'refresh') { await refresh(); }
else if (cmd === 'read') { const s = readState(); if (s) process.stdout.write(formatSnapshot(s, Date.now()) + '\n'); }
else if (cmd === 'if-below') {
  const s = readState(); const pct = Number(process.argv[3] ?? 30);
  if (s) { const out = formatIfBelow(s, pct, Date.now()); if (out) process.stdout.write(out + '\n'); }
}
```

(Guard `refresh`'s top-level `await` so importing the module for tests doesn't run a command: only dispatch when `process.argv[1]` ends with `ai-budget.mjs`. Wrap the dispatch in `if (process.argv[1]?.endsWith('ai-budget.mjs')) { ... }`.)

- [ ] **Step 4: Run tests + manual** — `node --test test/ai-budget.test.mjs` PASS; `node bin/ai-budget.mjs read` prints the snapshot; `node bin/ai-budget.mjs if-below 100` prints (everything < 100); `if-below 0` prints nothing.

- [ ] **Step 5: Commit**

```bash
git add bin/ai-budget.mjs test/ai-budget.test.mjs
git commit -m "feat(budget): read / if-below reader modes (poll published state)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: LaunchAgent + install the service

**Files:**
- Create: `bin/com.codex-adversary.ai-budget.plist.template`
- Modify: `install.sh`

- [ ] **Step 1: Create the plist template**

`bin/com.codex-adversary.ai-budget.plist.template`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>com.codex-adversary.ai-budget</string>
  <key>ProgramArguments</key>
  <array><string>/usr/bin/env</string><string>node</string><string>__BIN__</string><string>refresh</string></array>
  <key>StartInterval</key><integer>60</integer>
  <key>RunAtLoad</key><true/>
  <key>ProcessType</key><string>Background</string>
</dict></plist>
```

- [ ] **Step 2: Add to `install.sh` (after the `bin/codex-adversary.sh` copy)**

```bash
# --- ai-budget: reader/service ---
cp "$SRC/bin/ai-budget.mjs" "$SRC/bin/ai-budget-lib.mjs" "$DEST/bin/"
if [ "$(uname)" = "Darwin" ] && command -v node >/dev/null 2>&1; then
  LA="$HOME/Library/LaunchAgents/com.codex-adversary.ai-budget.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  sed "s#__BIN__#$DEST/bin/ai-budget.mjs#g" "$SRC/bin/com.codex-adversary.ai-budget.plist.template" > "$LA"
  launchctl bootout "gui/$(id -u)/com.codex-adversary.ai-budget" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$LA" 2>/dev/null \
    && echo "ai-budget service installed (first refresh may prompt for Keychain access — click Always Allow)." \
    || echo "ai-budget: launchctl bootstrap failed; run 'node $DEST/bin/ai-budget.mjs refresh' manually."
else
  echo "ai-budget: non-macOS or no node — service not installed; readers will show what they can."
fi
```

- [ ] **Step 3: Verify**

Run: `./install.sh` then `launchctl list | grep ai-budget` (shows the label) and after ~a minute `cat ~/.claude/.cache/ai-budget.json`.
Expected: label present; state file refreshed.

- [ ] **Step 4: Commit**

```bash
git add bin/com.codex-adversary.ai-budget.plist.template install.sh
git commit -m "feat(budget): launchd service install (macOS), idempotent

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: Merge the three hooks into `~/.claude/settings.json`

**Files:**
- Modify: `install.sh`

**Interfaces:**
- Adds `SessionStart`, `UserPromptSubmit`, and a `PreToolUse` (matcher `Workflow|Agent|Task`) hook, each running the reader, preserving existing hooks (incl. the `SessionEnd` backup). Idempotent (skip if our command already present).

- [ ] **Step 1: Add a node merge step to `install.sh`**

```bash
# --- merge ai-budget hooks into settings.json (idempotent, JSON-aware) ---
node - "$DEST" <<'NODE'
const fs = require('fs'); const path = require('path');
const dest = process.argv[2]; const f = path.join(dest, 'settings.json');
const bin = path.join(dest, 'bin', 'ai-budget.mjs');
const s = fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : {};
s.hooks ||= {};
const cmd = (args) => `node "${bin}" ${args}`;
const want = {
  SessionStart:     { match: null,                 command: cmd('read') },
  UserPromptSubmit: { match: null,                 command: cmd('if-below 30') },
  PreToolUse:       { match: 'Workflow|Agent|Task', command: cmd('if-below 30') },
};
for (const [event, { match, command }] of Object.entries(want)) {
  s.hooks[event] ||= [];
  const has = JSON.stringify(s.hooks[event]).includes('ai-budget.mjs');
  if (has) continue;
  const entry = { hooks: [{ type: 'command', command }] };
  if (match) entry.matcher = match;
  s.hooks[event].push(entry);
}
fs.writeFileSync(f, JSON.stringify(s, null, 2) + '\n');
console.log('ai-budget hooks merged into', f);
NODE
```

- [ ] **Step 2: Verify idempotency**

Run: `./install.sh` twice; then `cat "$DEST/settings.json"`.
Expected: each event has exactly ONE ai-budget entry (the existing SessionEnd backup + any git-preflight untouched); second run prints merged but adds nothing.

- [ ] **Step 3: Commit**

```bash
git add install.sh
git commit -m "feat(budget): merge SessionStart/UserPromptSubmit/PreToolUse reader hooks

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: Guardrail skill

**Files:**
- Create: `skills/budget-aware-allocation/SKILL.md`

- [ ] **Step 1: Write the skill**

```markdown
---
name: budget-aware-allocation
description: Use when a token-budget snapshot shows a rate-limit window getting low (the SessionStart / UserPromptSubmit / PreToolUse budget hook fired), or before kicking off a large token spend (a big Workflow, a wide Agent fan-out, reading a huge corpus) — to decide whether to proceed lean, defer, or push the heavy work to Codex.
---

# Budget-Aware Allocation

## Overview
Claude and Codex have separate token rate-limit budgets. The `ai-budget` hook injects a snapshot when a window is low. Near a limit, an offhand request can detonate millions of tokens — be deliberate, and use the idle budget on the *other* provider.

## When the budget hook says a window is low
1. **Be deliberate before big spends.** If the next action is large (a Workflow, a wide Agent fan-out, ingesting a big corpus), say so and confirm scope before firing — don't let an offhand request blow the limit.
2. **Offload to the provider with headroom.** If Claude is the constraint and Codex has budget, route heavy/parallel *execution* and *review* to Codex (you orchestrate; Codex spends its own banked tokens). Codex review/advice is available now via `adversarial-review` / `codex-advisor`; heavy execution offload is Feature 2.
3. **Trim.** Lower effort, batch, and avoid re-reading large context when near the edge.

## When healthy
The hook is silent. Work normally.

## Never
- Don't trust a snapshot flagged "⚠ stale" as live — re-check or proceed conservatively.
- Don't hard-block on budget; this is judgment, not a gate.
```

- [ ] **Step 2: Verify it installs**

Run: `./install.sh` then `ls "$DEST/skills/budget-aware-allocation/SKILL.md"`.
Expected: present (install.sh already copies `skills/*`).

- [ ] **Step 3: Commit**

```bash
git add skills/budget-aware-allocation/SKILL.md
git commit -m "feat(budget): budget-aware-allocation guardrail skill

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: Docs + full verification

**Files:**
- Modify: `README.md`, `CHANGELOG.md`

- [ ] **Step 1: Document** — add a "Budget awareness" section to `README.md` (what `ai-budget` does, the service, the hooks, `node bin/ai-budget.mjs read` for a manual check, the one-time Keychain Always-Allow) and a `CHANGELOG.md` entry.

- [ ] **Step 2: Full suite + smoke**

```bash
node --test test/ai-budget.test.mjs     # all green
node bin/ai-budget.mjs refresh          # publishes state (Keychain Always-Allow once)
node bin/ai-budget.mjs read             # prints both providers
node bin/ai-budget.mjs if-below 100     # prints (all < 100)
rm -f ~/.claude/.cache/ai-budget.json && node bin/ai-budget.mjs read; echo "exit $?"  # missing file → prints nothing, exit 0
```
Expected: tests green; `read` shows Codex (and Claude % if Always-Allow granted); reader never errors on a missing file.

- [ ] **Step 3: Commit + push**

```bash
git add README.md CHANGELOG.md
git commit -m "docs(budget): README + changelog for budget awareness

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
git push origin main
```

---

## Self-Review (by plan author)

**Spec coverage:** data sources → Tasks 1–3,5 (codex/transcript/keychain-fetch, with the resolved `GET /api/oauth/usage` method); `ai-budget` reader+service → Tasks 5–6; published-JSON schema → Task 5; the three hooks → Task 8; guardrail skill → Task 9; install (service + hooks) → Tasks 7–8; error handling/staleness → Tasks 4,6 + the reader contract; testing → Tasks 1–4,6 + Task 10 smoke. ✓

**Placeholder scan:** none — every parser/formatter/CLI/install/skill step has complete code. The spec's "open Keychain item" is resolved in Global Constraints + Task 5 (`claudeAiOauth.accessToken` → `GET /api/oauth/usage`). ✓

**Type consistency:** `parseCodexRateLimits`/`parseClaudeUsageWindows` return `{fiveHourPct,weeklyPct,resetsAt}`; `sumClaudeTranscriptTokens` returns `{todayUncached,today,sevenDayUncached,sevenDay}`; the published `claude`/`codex` objects use `{fiveHourPct,weeklyPct,resetsAt,spentToday,spent7d}`; `formatSnapshot`/`formatIfBelow`/`lowestPct`/`readState` names match across Tasks 4/6/8. ✓
