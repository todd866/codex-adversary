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
  // NEW: both reset times exposed
  assert.equal(r.fiveHourResetsAt, 1782314385);
  assert.equal(r.weeklyResetsAt, 1782358258);
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
  assert.equal(r.resetsAt, null);
  // NEW: both reset times null when already elapsed
  assert.equal(r.fiveHourResetsAt, null);
  assert.equal(r.weeklyResetsAt, null);
});

test('parseCodexRateLimits: no rate_limits anywhere → null', () => {
  assert.equal(parseCodexRateLimits(['{"type":"message"}', 'not json'], 1782300000), null);
});

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
  // NEW: both reset times exposed
  assert.equal(r.fiveHourResetsAt, Math.floor(Date.parse('2026-06-24T13:30:00Z') / 1000));
  assert.equal(r.weeklyResetsAt, Math.floor(Date.parse('2026-06-25T13:30:00Z') / 1000));
});

test('parseClaudeUsageWindows: percent utilization + epoch reset, missing windows → null', () => {
  const now = 1782300000;
  const r = parseClaudeUsageWindows({ five_hour: { utilization: 40, resets_at: 1782314385 } }, now);
  assert.equal(r.fiveHourPct, 60);
  assert.equal(r.weeklyPct, null);
  assert.equal(r.resetsAt, null);
  // NEW: fiveHourResetsAt populated, weeklyResetsAt null when window missing
  assert.equal(r.fiveHourResetsAt, 1782314385);
  assert.equal(r.weeklyResetsAt, null);
});

import { lowestPct, formatSnapshot, formatIfBelow } from '../bin/ai-budget-lib.mjs';

// STATE: Claude weekly low (18%), Codex weekly healthy (81%). Both weekly resets far away (~12h).
// fiveHourResetsAt/weeklyResetsAt reflect the new parser output stored by refresh.
const STATE = {
  generatedAt: '2026-06-24T12:00:00Z',
  claude: {
    fiveHourPct: 62, weeklyPct: 18,
    fiveHourResetsAt: 1782314385, weeklyResetsAt: 1782358258,
    resetsAt: 1782358258,
    spentToday: 4100000, spent7d: 22000000,
  },
  codex: {
    fiveHourPct: 99, weeklyPct: 81,
    fiveHourResetsAt: 1782314385, weeklyResetsAt: 1782358258,
    resetsAt: 1782358258,
    spentToday: 0, spent7d: 2900000,
  },
};
const now = Date.parse('2026-06-24T12:00:40Z'); // 40s later — both resets ~12h away

test('lowestPct picks the smallest window', () => {
  assert.equal(lowestPct(STATE), 18);
});

test('formatSnapshot mentions both providers and the age', () => {
  const s = formatSnapshot(STATE, now);
  assert.match(s, /Claude/); assert.match(s, /Codex/);
  assert.match(s, /18%/); assert.match(s, /as of/);
});

test('formatIfBelow: weekly low + far from reset → frugal hint fires (baseline)', () => {
  // STATE has weeklyPct=18 which is above FLOOR_PCT=12 and no weeklyTrend → silent regardless of threshold
  assert.equal(formatIfBelow(STATE, 10, now), '');
  assert.equal(formatIfBelow(STATE, 30, now), '',
    'new design: 18% > FLOOR_PCT=12 with no trend data → silent');
});

test('formatSnapshot flags stale state', () => {
  const stale = Date.parse('2026-06-24T12:20:00Z');           // 20 min later
  assert.match(formatSnapshot(STATE, stale), /stale/i);
});

// ── New scenario tests ────────────────────────────────────────────────────────

// 1. Weekly healthy + 5h low resetting soon → NO frugal language, neutral 5h note allowed
test('formatIfBelow: weekly healthy, 5h low resetting in 45min → no frugal/conserve language', () => {
  // nowMs set so 5h reset is 45 minutes away
  const base = Date.parse('2026-06-24T12:00:00Z');
  const fiveHourResetsAt = Math.floor(base / 1000) + 45 * 60; // 45 min from now
  const weeklyResetsAt   = Math.floor(base / 1000) + 5 * 24 * 3600; // 5 days away
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 25, weeklyPct: 69, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 99, weeklyPct: 81, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  // Must NOT contain frugal/conserve language
  assert.doesNotMatch(out, /be deliberate|conserve|route heavy|parallel.*Codex|Codex.*budget|constraint/i,
    'should not warn to conserve when weekly is healthy');
});

// 2. Weekly near floor + far from reset + Codex weekly healthy → frugal + Codex-offload fires
// Updated: new design fires at FLOOR_PCT=12 or trend. Use 11% (< FLOOR_PCT) to trigger.
test('formatIfBelow: weekly near floor (11%), far from reset + Codex healthy → frugal + offload hint', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600; // 5d away
  const fiveHourResetsAt = Math.floor(base / 1000) + 3 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 90, weeklyPct: 11, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt,
              weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
              spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 99, weeklyPct: 72, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  assert.match(out, /Claude is the constraint/i);
  assert.match(out, /Codex/);
});

// 3. Weekly low + resets in 25min → use-it-or-lose-it, NO frugal hint
test('formatIfBelow: weekly low (12%) but resets in 25min → no frugal hint (use-it-or-lose-it)', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 25 * 60; // 25 min away — within RESET_SOON_MIN
  const fiveHourResetsAt = Math.floor(base / 1000) + 2 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 80, weeklyPct: 12, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 99, weeklyPct: 88, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  assert.doesNotMatch(out, /be deliberate|conserve|route heavy|Codex.*budget|constraint/i,
    'should not frugal-warn when weekly is about to reset');
});

// 4. 5h low (8%) far from reset + weekly healthy → NO frugal hint (5h never triggers it)
test('formatIfBelow: 5h low (8%) far from reset, weekly healthy → no frugal hint', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const fiveHourResetsAt = Math.floor(base / 1000) + 4 * 3600; // 4h away
  const weeklyResetsAt   = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 8, weeklyPct: 75, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 99, weeklyPct: 88, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  // The 5h window is below threshold but should not trigger frugal language
  assert.doesNotMatch(out, /be deliberate|conserve|route heavy|Codex.*budget|Claude is the constraint/i,
    '5h window low should never trigger frugal language');
});

// 5. null reset times / missing windows → no throw
// Updated: new design uses FLOOR_PCT=12. Use 11% (< FLOOR_PCT) + null reset → warn fires (fail-safe).
test('formatIfBelow: null weeklyResetsAt → conserves when below floor (fail-safe)', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 80, weeklyPct: 11, fiveHourResetsAt: null, weeklyResetsAt: null, resetsAt: null,
              weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
              spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 99, weeklyPct: 72, fiveHourResetsAt: null, weeklyResetsAt: null, resetsAt: null, spentToday: 0, spent7d: 0 },
  };
  let out;
  assert.doesNotThrow(() => { out = formatIfBelow(state, 30, base); });
  // null reset → not "resetting soon" → weekly 11 < FLOOR_PCT=12 → frugal hint should fire
  assert.match(out, /Claude is the constraint/i);
});

// 5b. Missing windows entirely → no throw, returns ''
test('formatIfBelow: missing windows entirely → no throw, returns empty', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: null, weeklyPct: null, fiveHourResetsAt: null, weeklyResetsAt: null, resetsAt: null, spentToday: 0, spent7d: 0 },
    codex:  null,
  };
  let out;
  assert.doesNotThrow(() => { out = formatIfBelow(state, 30, base); });
  assert.equal(out, '');
});

// 6. Everything healthy → returns ''
test('formatIfBelow: everything healthy → empty string', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600;
  const fiveHourResetsAt = Math.floor(base / 1000) + 3 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 75, weeklyPct: 65, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 90, weeklyPct: 88, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
  };
  assert.equal(formatIfBelow(state, 30, base), '');
});

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

// ── projectWeeklyTrend tests ──────────────────────────────────────────────────
import { projectWeeklyTrend } from '../bin/ai-budget-lib.mjs';

// Helper: build history with evenly-spaced points
function mkHistory(nowMs, minutesAgo, pcts) {
  // pcts = array [oldest...newest], minutesAgo = total span
  const step = (minutesAgo * 60000) / (pcts.length - 1);
  return pcts.map((cw, i) => ({ t: nowMs - minutesAgo * 60000 + i * step, cw }));
}

test('projectWeeklyTrend: declining trend, will run dry before reset → willRunDryBeforeReset true', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  // 25% → 10% over 60 minutes (well within TREND_LOOKBACK_MIN=180)
  const history = mkHistory(nowMs, 60, [25, 22, 18, 14, 10]);
  // Reset is 4 hours away = well after projected empty
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  const r = projectWeeklyTrend(history, 10, weeklyResetEpoch, nowMs);
  assert.equal(typeof r.slope, 'number');
  assert.ok(r.slope < 0, 'slope should be negative');
  assert.ok(r.projectedEmptyAt != null, 'projectedEmptyAt should be set');
  assert.ok(r.projectedEmptyAt < weeklyResetEpoch * 1000, 'projected empty before reset');
  assert.equal(r.willRunDryBeforeReset, true);
});

test('projectWeeklyTrend: slow decline, will NOT run dry before reset', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  // Very slow decline: 50% → 45% over 60 minutes
  const history = mkHistory(nowMs, 60, [50, 48, 47, 46, 45]);
  // Reset is 1 hour away — won't run dry (50%+ left at this rate)
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 3600;
  const r = projectWeeklyTrend(history, 45, weeklyResetEpoch, nowMs);
  assert.ok(r.slope < 0, 'slope should be negative');
  assert.equal(r.willRunDryBeforeReset, false);
});

test('projectWeeklyTrend: fewer than 2 points → null slope, willRunDryBeforeReset false', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  // Empty history
  assert.deepEqual(
    projectWeeklyTrend([], 20, weeklyResetEpoch, nowMs),
    { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false }
  );
  // One point
  assert.deepEqual(
    projectWeeklyTrend([{ t: nowMs - 60000, cw: 20 }], 20, weeklyResetEpoch, nowMs),
    { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false }
  );
});

test('projectWeeklyTrend: span < TREND_MIN_SPAN_MIN (20min) → null slope', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  // Only 10 minutes of span (less than 20-min minimum)
  const history = mkHistory(nowMs, 10, [30, 28, 26]);
  const r = projectWeeklyTrend(history, 26, weeklyResetEpoch, nowMs);
  assert.equal(r.slope, null);
  assert.equal(r.willRunDryBeforeReset, false);
});

test('projectWeeklyTrend: positive slope (refilling after reset) → willRunDryBeforeReset false', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  // Going UP (e.g. just after a reset)
  const history = mkHistory(nowMs, 60, [10, 20, 40, 60, 80]);
  const r = projectWeeklyTrend(history, 80, weeklyResetEpoch, nowMs);
  assert.ok(r.slope != null && r.slope >= 0, 'slope should be >= 0');
  assert.equal(r.projectedEmptyAt, null);
  assert.equal(r.willRunDryBeforeReset, false);
});

test('projectWeeklyTrend: null weeklyResetEpoch → willRunDryBeforeReset false even if declining', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const history = mkHistory(nowMs, 60, [25, 20, 15, 10, 5]);
  const r = projectWeeklyTrend(history, 5, null, nowMs);
  assert.ok(r.slope != null && r.slope < 0);
  assert.ok(r.projectedEmptyAt != null);
  assert.equal(r.willRunDryBeforeReset, false);
});

test('projectWeeklyTrend: null cw entries in history are filtered out', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  // 5 points spanning 60 min, 2 null → only 3 usable but span is the full 60 min
  const base = nowMs - 60 * 60000;
  const step = 15 * 60000;
  const history = [
    { t: base,            cw: 30 },
    { t: base + step,     cw: null },
    { t: base + 2*step,   cw: 22 },
    { t: base + 3*step,   cw: null },
    { t: base + 4*step,   cw: 14 },
  ];
  const r = projectWeeklyTrend(history, 14, weeklyResetEpoch, nowMs);
  // 3 valid points, span = 60 min >= 20 → should compute slope
  assert.equal(typeof r.slope, 'number');
  assert.ok(r.slope < 0);
});

test('projectWeeklyTrend: points outside lookback window (180min) are pruned', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  // First 2 points are >180 min old → should be pruned, leaving only 1 usable → null slope
  const history = [
    { t: nowMs - 200 * 60000, cw: 60 },
    { t: nowMs - 190 * 60000, cw: 55 },
    { t: nowMs - 10 * 60000,  cw: 20 }, // only 1 valid within lookback
  ];
  const r = projectWeeklyTrend(history, 20, weeklyResetEpoch, nowMs);
  assert.equal(r.slope, null);
  assert.equal(r.willRunDryBeforeReset, false);
});

test('projectWeeklyTrend: never throws on empty/garbage history', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(nowMs / 1000) + 4 * 3600;
  assert.doesNotThrow(() => projectWeeklyTrend(null, 20, weeklyResetEpoch, nowMs));
  assert.doesNotThrow(() => projectWeeklyTrend(undefined, 20, weeklyResetEpoch, nowMs));
  assert.doesNotThrow(() => projectWeeklyTrend('garbage', 20, weeklyResetEpoch, nowMs));
  assert.doesNotThrow(() => projectWeeklyTrend([null, undefined, {}], 20, weeklyResetEpoch, nowMs));
});

// ── New formatIfBelow tests (floor + trend-based) ────────────────────────────

test('formatIfBelow: floor 11% (< FLOOR_PCT=12) → warn even without trend', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(base / 1000) + 5 * 24 * 3600; // 5 days away
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 80, weeklyPct: 11,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch,
      weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
      spentToday: 0, spent7d: 0,
    },
    codex: { fiveHourPct: 99, weeklyPct: 72, weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  assert.match(out, /critically low/i);
  assert.match(out, /11%/);
});

test('formatIfBelow: 24% + willRunDryBeforeReset=true → trend warn fires', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 80, weeklyPct: 24,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch,
      weeklyTrend: { slope: -0.001, projectedEmptyAt: base + 2 * 3600000, willRunDryBeforeReset: true },
      spentToday: 0, spent7d: 0,
    },
    codex: { fiveHourPct: 99, weeklyPct: 72, weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  assert.match(out, /critically low/i);
  assert.match(out, /on track to run dry/i);
  assert.match(out, /24%/);
});

test('formatIfBelow: 20% + willRunDryBeforeReset=false → no warn', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 80, weeklyPct: 20,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch,
      weeklyTrend: { slope: -0.0001, projectedEmptyAt: base + 50 * 3600000, willRunDryBeforeReset: false },
      spentToday: 0, spent7d: 0,
    },
    codex: { fiveHourPct: 99, weeklyPct: 72, weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  assert.equal(out, '', 'should be silent: 20% is above FLOOR_PCT and not trending dry');
});

test('formatIfBelow: weekly 8% but resets in 30min → no warn (use-it-or-lose-it)', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(base / 1000) + 30 * 60; // 30 min away
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 80, weeklyPct: 8,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch,
      weeklyTrend: { slope: -0.001, projectedEmptyAt: base + 1 * 3600000, willRunDryBeforeReset: true },
      spentToday: 0, spent7d: 0,
    },
    codex: { fiveHourPct: 99, weeklyPct: 88, weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch, spentToday: 0, spent7d: 0 },
  };
  const out = formatIfBelow(state, 30, base);
  assert.doesNotMatch(out, /critically low/i, 'should not warn when resetting soon');
});

test('formatIfBelow: healthy (50%) no trend → empty string', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetEpoch = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 80, weeklyPct: 50,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch,
      weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
      spentToday: 0, spent7d: 0,
    },
    codex: { fiveHourPct: 99, weeklyPct: 88, weeklyResetsAt: weeklyResetEpoch, resetsAt: weeklyResetEpoch, spentToday: 0, spent7d: 0 },
  };
  assert.equal(formatIfBelow(state, 30, base), '');
});

// ── New formatSnapshot tests (5h note + trend note) ──────────────────────────

test('formatSnapshot: 5h low (<WATCH_PCT=30) → includes 5h spend-freely note', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const fiveHourResetsAt = Math.floor(base / 1000) + 2 * 3600; // 2h away
  const weeklyResetsAt   = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 20, weeklyPct: 65,
      fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt,
      weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
      spentToday: 0, spent7d: 0,
    },
    codex: null,
  };
  const out = formatSnapshot(state, base);
  assert.match(out, /5h.*low|window.*low/i, 'should include 5h note');
  assert.match(out, /spend freely|doesn.t bank/i, 'should say spend freely');
});

test('formatSnapshot: weeklyTrend willRunDryBeforeReset → includes trend note', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 80, weeklyPct: 25,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt, resetsAt: weeklyResetsAt,
      weeklyTrend: { slope: -0.001, projectedEmptyAt: base + 2 * 3600000, willRunDryBeforeReset: true },
      spentToday: 0, spent7d: 0,
    },
    codex: null,
  };
  const out = formatSnapshot(state, base);
  assert.match(out, /weekly.*trending|trending.*weekly|run dry/i, 'should include trend note');
});

test('formatSnapshot: 5h healthy, no trend → no extra notes', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: {
      fiveHourPct: 75, weeklyPct: 65,
      fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
      weeklyResetsAt, resetsAt: weeklyResetsAt,
      weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
      spentToday: 0, spent7d: 0,
    },
    codex: null,
  };
  const out = formatSnapshot(state, base);
  assert.doesNotMatch(out, /spend freely|trending/i, 'no extra notes when healthy');
});

// ── Disambiguation: "% left" labelling + "used" tokens + inline ⚠ marker ─────
// Regression for 2026-06-27: the glance rendered "week 9% · spent 120M" with the
// percentage UNLABELLED and sitting next to "spent", so a reader (human or model)
// read 9% as SPENT rather than REMAINING. The numbers are remaining; say so.
import { routingAdvice, weeklyIsConstraining } from '../bin/ai-budget-lib.mjs';

// The exact real state that triggered the misread: Claude weekly 9% (critical,
// trending dry), Codex weekly 91% (idle headroom). reset days away.
const CRIT_STATE = () => {
  const base = Date.parse('2026-06-27T23:43:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600;
  return {
    state: {
      generatedAt: '2026-06-27T23:43:00Z',
      claude: {
        fiveHourPct: 95, weeklyPct: 9,
        fiveHourResetsAt: Math.floor(base / 1000) + 3 * 3600,
        weeklyResetsAt, resetsAt: weeklyResetsAt,
        weeklyTrend: { slope: -2.6e-7, projectedEmptyAt: base + 5 * 3600000, willRunDryBeforeReset: true },
        spentToday: 121247523, spent7d: 715813109,
      },
      codex: {
        fiveHourPct: null, weeklyPct: 91,
        fiveHourResetsAt: null, weeklyResetsAt, resetsAt: weeklyResetsAt,
        spentToday: null, spent7d: null,
      },
    },
    now: base + 40000,
  };
};

test('formatSnapshot: percentages are labelled "left" (not bare %) so remaining≠spent', () => {
  const { state, now } = CRIT_STATE();
  const out = formatSnapshot(state, now);
  assert.match(out, /week 9% left/, 'weekly must read as remaining ("9% left")');
  assert.match(out, /5h 95% left/, '5h must read as remaining ("95% left")');
  assert.match(out, /week 91% left/, 'Codex weekly must read as remaining');
  // The consumed-tokens column must NOT be a bare "%" that can be confused for it
  assert.match(out, /used /, 'consumed tokens labelled "used", contrasting with "left"');
});

test('formatSnapshot: critical weekly window gets an inline ⚠ marker', () => {
  const { state, now } = CRIT_STATE();
  const out = formatSnapshot(state, now);
  // The ⚠ sits on the Claude weekly window (the one that is critical)…
  assert.match(out, /week 9% left ⚠/, 'critical Claude weekly carries inline ⚠');
  // …and NOT on the healthy Codex weekly window.
  assert.doesNotMatch(out, /week 91% left ⚠/, 'healthy Codex weekly has no ⚠');
});

test('formatSnapshot: surfaces the actionable verdict — constraint + offload target', () => {
  const { state, now } = CRIT_STATE();
  const out = formatSnapshot(state, now);
  assert.match(out, /Claude is the constraint/i, 'names which provider is the bottleneck');
  assert.match(out, /9%/, 'states the constraining number');
  assert.match(out, /run dry/i, 'carries the trend when trending dry');
  assert.match(out, /Codex has 91% left/i, 'names the offload target AND its headroom');
  assert.match(out, /route .*there|route heavy/i, 'tells you to route heavy work to Codex');
});

test('formatSnapshot: healthy weekly → no verdict, no ⚠ marker', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 80, weeklyPct: 65, fiveHourResetsAt: Math.floor(base/1000)+3*3600,
              weeklyResetsAt, resetsAt: weeklyResetsAt,
              weeklyTrend: { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false },
              spentToday: 1000, spent7d: 5000 },
    codex: { fiveHourPct: 90, weeklyPct: 88, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: null, spent7d: null },
  };
  const out = formatSnapshot(state, base);
  assert.doesNotMatch(out, /⚠/, 'no inline marker when healthy');
  assert.doesNotMatch(out, /is the constraint/i, 'no verdict when healthy');
  assert.match(out, /week 65% left/, 'still labelled "left"');
});

test('routingAdvice: codex healthy → names its headroom + says route there', () => {
  assert.match(routingAdvice(91), /Codex has 91% left/i);
  assert.match(routingAdvice(91), /route/i);
});

test('routingAdvice: codex unhealthy/unknown → frugal advice, no false offload', () => {
  assert.doesNotMatch(routingAdvice(20), /route/i);
  assert.match(routingAdvice(20), /deliberate|batch|lower effort/i);
  assert.doesNotMatch(routingAdvice(null), /route/i);
});

test('weeklyIsConstraining: floor, trend, reset-soon, healthy', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const farReset = Math.floor(base / 1000) + 5 * 24 * 3600;
  const soonReset = Math.floor(base / 1000) + 20 * 60;
  // below floor (12) far from reset → constraining
  assert.equal(weeklyIsConstraining({ weeklyPct: 9, weeklyResetsAt: farReset }, base), true);
  // below watch (30) + trending dry → constraining
  assert.equal(weeklyIsConstraining({ weeklyPct: 25, weeklyResetsAt: farReset,
    weeklyTrend: { willRunDryBeforeReset: true } }, base), true);
  // below floor BUT resetting soon → NOT constraining (use-it-or-lose-it)
  assert.equal(weeklyIsConstraining({ weeklyPct: 9, weeklyResetsAt: soonReset }, base), false);
  // healthy → not constraining
  assert.equal(weeklyIsConstraining({ weeklyPct: 65, weeklyResetsAt: farReset }, base), false);
  // null pct / null provider → not constraining, no throw
  assert.equal(weeklyIsConstraining({ weeklyPct: null }, base), false);
  assert.equal(weeklyIsConstraining(null, base), false);
});

// ── pickClaudeWindows tests ───────────────────────────────────────────────────
import { pickClaudeWindows } from '../bin/ai-budget-lib.mjs';

test('pickClaudeWindows: freshWin present → returned unchanged', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const freshWin = { weeklyPct: 63, fiveHourPct: 45, fiveHourResetsAt: 1, weeklyResetsAt: 2 };
  assert.deepEqual(pickClaudeWindows(freshWin, null, nowMs), freshWin);
});

test('pickClaudeWindows: freshWin null + prevState valid <15min old → carries subset', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const twoMinAgo = new Date(nowMs - 2 * 60 * 1000).toISOString();
  const prevState = {
    generatedAt: twoMinAgo,
    claude: { weeklyPct: 69, fiveHourPct: 33, fiveHourResetsAt: 1, weeklyResetsAt: 2 },
  };
  const result = pickClaudeWindows(null, prevState, nowMs);
  assert.equal(result.weeklyPct, 69);
  assert.equal(result.fiveHourPct, 33);
  assert.equal(result.fiveHourResetsAt, 1);
  assert.equal(result.weeklyResetsAt, 2);
});

test('pickClaudeWindows: freshWin null + prevState 20min old → null (too stale)', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const twentyMinAgo = new Date(nowMs - 20 * 60 * 1000).toISOString();
  const prevState = {
    generatedAt: twentyMinAgo,
    claude: { weeklyPct: 69, fiveHourPct: 33, fiveHourResetsAt: 1, weeklyResetsAt: 2 },
  };
  assert.equal(pickClaudeWindows(null, prevState, nowMs), null);
});

test('pickClaudeWindows: freshWin null + prevState.claude null → null', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  const twoMinAgo = new Date(nowMs - 2 * 60 * 1000).toISOString();
  const prevState = { generatedAt: twoMinAgo, claude: null };
  assert.equal(pickClaudeWindows(null, prevState, nowMs), null);
});

test('pickClaudeWindows: freshWin null + prevState null → null', () => {
  const nowMs = Date.parse('2026-06-24T12:00:00Z');
  assert.equal(pickClaudeWindows(null, null, nowMs), null);
});

// --- governing-window selection across interleaved sessions ---------------------
// Regression 1: the reader used to pick the newest session FILE and take that file's
// LAST rate_limits line. With the ChatGPT.app Codex and the CLI writing concurrently,
// the newest file need not carry the newest EVENT.
// Regression 2: selecting the newest EVENT is not a fix either. Concurrent writers
// report DIFFERENT window instances (distinct resets_at) with wildly different
// used_percent — 16% and 96% within the same second, observed 2026-07-10. Nothing in
// the payload marks which one governs the next call, so we do not guess: take the most
// conservative recent reading. Under-reporting exhaustion is the costly direction.

const rlLine = (ts, primaryUsed, secondaryUsed, resetsAt = 1782314385) => JSON.stringify({
  timestamp: ts,
  type: 'event_msg',
  payload: { type: 'token_count', rate_limits: {
    primary:   { used_percent: primaryUsed,   window_minutes: 300,   resets_at: resetsAt },
    secondary: { used_percent: secondaryUsed, window_minutes: 10080, resets_at: 1782358258 },
  }},
});

test('pickGoverningRateLimits: the worst recent reading wins, not the last line', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const lines = [
    rlLine('2026-07-10T00:16:19.728Z', 96, 15),  // 4% left
    rlLine('2026-07-10T00:16:09.407Z', 16, 3),   // healthier, appears last
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 4, 'must not take the last line');
  assert.equal(r.weeklyPct, 85);
});

test('pickGoverningRateLimits: exhausted window reports 0, not a stale healthy number', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const lines = [
    rlLine('2026-07-10T00:10:00.000Z', 17, 3),    // "83% left"
    rlLine('2026-07-10T00:17:00.000Z', 100, 16),  // truth: exhausted
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 0);
  assert.equal(r.weeklyPct, 84);
});

// THE case freshest-by-timestamp gets wrong. Both events are real, milliseconds apart,
// from concurrent writers reporting the SAME window instance. Newest-wins is a coin-flip.
// Within a fixed window used_percent only climbs, so the maximum is the current reading.
test('pickGoverningRateLimits: same window, disagreeing writers -> the highest used_percent', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const lines = [
    rlLine('2026-07-10T00:16:19.728Z', 96, 20),  // drained
    rlLine('2026-07-10T00:16:19.900Z', 16, 5),   // NEWER by 172ms, looks healthy
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 4, 'newest-event would have said 84% left');
  assert.equal(r.weeklyPct, 80, 'newest-event would have said 95% left');
});

// `timestamp` is when the line was WRITTEN. A resumed session replays OLD window instances
// with fresh timestamps, so staleness must be judged by resets_at, never by timestamp.
test('pickGoverningRateLimits: an EXPIRED window is ignored, however recently written', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const EXPIRED = now - 1;
  const LIVE = now + 14385;
  const lines = [
    // replayed one millisecond ago, but it describes a window that has already reset
    rlLine('2026-07-10T00:17:00.001Z', 100, 99, EXPIRED),
    rlLine('2026-07-10T00:17:00.000Z', 10, 5, LIVE),
    rlLine('2026-07-10T00:17:00.002Z', 10, 5, LIVE),
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 90, 'the replayed expired window must not dominate');
  assert.equal(r.fiveHourResetsAt, LIVE);
});

// No consensus (every bucket a single vote) must NOT resolve to the furthest reset — that is
// precisely the lone-outlier shape. With nothing to break the tie, be pessimistic.
test('pickGoverningRateLimits: never the furthest reset — the drained window binds', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const lines = [
    rlLine('2026-07-10T00:17:00.000Z', 95, 10, now + 1000),  // governing: 5% left
    rlLine('2026-07-10T00:17:00.001Z',  0,  0, now + 2000),  // lone outlier, further reset
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 5, 'furthest-reset tie-break would have reported 100% left');
});

// Greedy single-link chaining would fuse 20000..20360 into one four-vote bucket spanning
// 360s, out-voting three genuine snapshots of the real window.
test('pickGoverningRateLimits: many 0%-used instances cannot outweigh one drained window', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const lines = [
    ...[0, 120, 240, 360].map((d, i) => rlLine(`2026-07-10T00:17:0${i}.000Z`, 0, 0, now + 20000 + d)),
    ...[0, 1, 2].map((d) => rlLine('2026-07-10T00:17:00.000Z', 95, 10, now + 10000 + d)),
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 5, 'a chained bucket must not span more than jitterSec');
});

// Untagged events cannot be attributed to a plan. If ANY event is tagged, the untagged ones
// are legacy (likely a pre-upgrade plan) and must not vote.
test('pickGoverningRateLimits: untagged events cannot mask a plan-tagged drained window', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const R = now + 14385;
  const tagged = JSON.stringify({ payload: { rate_limits: {
    limit_id: 'codex', plan_type: 'pro',
    primary:   { used_percent: 95, window_minutes: 300,   resets_at: R },
    secondary: { used_percent: 10, window_minutes: 10080, resets_at: R + 100 },
  }}});
  // The untagged pair describe a DIFFERENT window instance, so they form a plurality.
  const OTHER = R + 5000;
  const lines = [tagged, rlLine('2026-07-10T00:17:00.000Z', 0, 0, OTHER), rlLine('2026-07-10T00:17:01.000Z', 0, 0, OTHER)];
  const r = pickGoverningRateLimits(lines, now, { plan: 'pro' });
  assert.equal(r.fiveHourPct, 5, 'two untagged 0% events must not outvote one tagged 95% event');
  assert.equal(r.fiveHourResetsAt, R);
});

// Snapshots of one window written a second apart carry resets_at a second apart. They are
// the same instance and must be bucketed together, or the newer reading is discarded.
test('pickGoverningRateLimits: resets_at jitter within a window is bucketed together', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const R = now + 14385;
  const lines = [
    rlLine('2026-07-10T00:17:00.000Z', 75, 12, R),      // later reading, reset 1s earlier
    rlLine('2026-07-10T00:16:00.000Z', 73, 12, R + 1),  // strictly-max resets_at, older reading
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 25, 'a 1s reset jitter must not split one window in two');
});

// The bug that made "0% left" appear while calls were being served: a stale `prolite`
// window sits in the same logs as the live `pro` one. Only the authenticated plan governs.
test('pickGoverningRateLimits: filters to the authenticated plan', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const R = now + 14385;
  const tagged = (plan, used, wk) => JSON.stringify({
    timestamp: '2026-07-10T00:17:00.000Z',
    payload: { rate_limits: {
      limit_id: 'codex', plan_type: plan,
      primary:   { used_percent: used, window_minutes: 300,   resets_at: R },
      secondary: { used_percent: wk,   window_minutes: 10080, resets_at: R + 100 },
    }},
  });
  const lines = [tagged('prolite', 100, 30), tagged('pro', 75, 12)];
  const r = pickGoverningRateLimits(lines, now, { plan: 'pro' });
  assert.equal(r.fiveHourPct, 25, "the other plan's exhausted window must be ignored");
  assert.equal(r.weeklyPct, 88);

  // With no plan known we must not silently adopt one; conservatism across plans is the
  // documented fallback, and the caller is told nothing more than the logs support.
  const unknown = pickGoverningRateLimits(lines, now);
  assert.equal(unknown.fiveHourPct, 0, 'unknown plan -> worst across plans, not a guess');
});

// A lone spurious instance reporting a further-forward reset at 0% used is the most GENEROUS
// reading, so the binding (most-used) window ignores it for free. Selecting by furthest reset,
// or by consensus, needs extra machinery to reach the same answer.
test('pickGoverningRateLimits: a further-reset 0%-used outlier cannot mask a drained window', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const LIVE = now + 14000;
  const OUTLIER = LIVE + 774;
  const lines = [
    ...Array.from({ length: 12 }, () => rlLine('2026-07-10T01:18:00.000Z', 80, 13, LIVE)),
    rlLine('2026-07-10T01:18:30.000Z', 0, 0, OUTLIER),
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 20, 'furthest-reset selection would have reported 100% left');
  assert.equal(r.fiveHourResetsAt, LIVE);
});

// The 2026-07-10 shape: `codex`/`pro` carried TWO live 5h windows at once — one at used=29,
// one at used=100 — each re-reported by the same 15 sessions. A Sol call was refused. The
// question is never "which window do most sessions mention", it is "which one blocks me".
test('pickGoverningRateLimits: with two live windows for one plan, the drained one binds', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const HEALTHY = now + 13000;   // used=29, and mentioned MORE often
  const DRAINED = now + 14400;   // used=100
  const lines = [
    ...Array.from({ length: 20 }, () => rlLine('2026-07-10T02:03:00.000Z', 29, 5, HEALTHY)),
    ...Array.from({ length: 3 },  () => rlLine('2026-07-10T02:03:20.000Z', 100, 16, DRAINED)),
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 0, 'a consensus rule would have reported 71% left while Sol was refused');
  assert.equal(r.fiveHourResetsAt, DRAINED);
});

// Per-model quotas (codex_bengalfox = GPT-5.3-Codex-Spark) are always ~0% used and would
// mask a drained general quota if mixed in.
test('pickGoverningRateLimits: ignores per-model limit_ids', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const R = now + 14385;
  const tagged = (limitId, used) => JSON.stringify({
    timestamp: '2026-07-10T00:17:00.000Z',
    payload: { rate_limits: {
      limit_id: limitId, plan_type: 'pro',
      primary:   { used_percent: used, window_minutes: 300,   resets_at: R },
      secondary: { used_percent: 10,   window_minutes: 10080, resets_at: R + 100 },
    }},
  });
  const r = pickGoverningRateLimits([tagged('codex_bengalfox', 0), tagged('codex', 80)], now, { plan: 'pro' });
  assert.equal(r.fiveHourPct, 20, "a fresh per-model quota must not mask the general one");
});

test('codexPlanFromIdToken: reads chatgpt_plan_type out of the namespaced claim', async () => {
  const { codexPlanFromIdToken } = await import('../bin/ai-budget-lib.mjs');
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const tok = `hdr.${b64({ 'https://api.openai.com/auth': { chatgpt_plan_type: 'pro' } })}.sig`;
  assert.equal(codexPlanFromIdToken(tok), 'pro');
  assert.equal(codexPlanFromIdToken('garbage'), null);
  assert.equal(codexPlanFromIdToken(undefined), null);
  assert.equal(codexPlanFromIdToken(`hdr.${b64({ sub: 'x' })}.sig`), null, 'no claim -> null, never a guess');
});

// The 5h and weekly minima answer different questions and may come from different events.
test('pickGoverningRateLimits: windows are minimised independently', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const lines = [
    rlLine('2026-07-10T00:16:00.000Z', 90, 5),   // worst primary
    rlLine('2026-07-10T00:16:30.000Z', 10, 40),  // worst secondary
  ];
  const r = pickGoverningRateLimits(lines, now);
  assert.equal(r.fiveHourPct, 10);
  assert.equal(r.weeklyPct, 60);
});

// Timestamps are deliberately not consulted at all: they record when a line was written,
// not when the reading was taken. An untimed line describing the live window counts exactly
// as much as a timestamped one describing it.
test('pickGoverningRateLimits: timestamps are irrelevant; the window instance decides', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const untimed = JSON.stringify({ rate_limits: {
    primary:   { used_percent: 99, window_minutes: 300,   resets_at: 1782314385 },
    secondary: { used_percent: 99, window_minutes: 10080, resets_at: 1782358258 },
  }});
  const r = pickGoverningRateLimits([untimed, rlLine('2026-07-10T00:17:00.000Z', 90, 20)], now);
  assert.equal(r.fiveHourPct, 1, 'same live window: the highest used_percent wins');
});

test('pickGoverningRateLimits: falls back to an untimed line when nothing is timestamped', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const untimed = JSON.stringify({ rate_limits: {
    primary:   { used_percent: 40, window_minutes: 300,   resets_at: 1782314385 },
    secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1782358258 },
  }});
  const r = pickGoverningRateLimits([untimed], now);
  assert.equal(r.fiveHourPct, 60);
  assert.equal(r.weeklyPct, 90);
});

// The pre-filter guards a hot hook against reading whole session transcripts into
// memory. It must not drop the bare-dict shape that findRateLimits also accepts.
test('looksLikeRateLimitLine: matches both wrapper and bare-dict shapes, rejects noise', async () => {
  const { looksLikeRateLimitLine } = await import('../bin/ai-budget-lib.mjs');
  assert.equal(looksLikeRateLimitLine(rlLine('2026-07-10T00:00:00.000Z', 1, 1)), true);
  assert.equal(looksLikeRateLimitLine(JSON.stringify({
    primary: { used_percent: 1 }, secondary: { used_percent: 1 },
  })), true, 'bare dict must survive the pre-filter');
  assert.equal(looksLikeRateLimitLine(JSON.stringify({ type: 'agent_message', text: 'hi' })), false);
});

test('pickGoverningRateLimits: falls back to untimed lines when NO line carries a timestamp', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  const now = 1782300000;
  const a = JSON.stringify({ rate_limits: {
    primary:   { used_percent: 10, window_minutes: 300,   resets_at: 1782314385 },
    secondary: { used_percent: 10, window_minutes: 10080, resets_at: 1782358258 },
  }});
  const b = JSON.stringify({ rate_limits: {
    primary:   { used_percent: 40, window_minutes: 300,   resets_at: 1782314385 },
    secondary: { used_percent: 40, window_minutes: 10080, resets_at: 1782358258 },
  }});
  const r = pickGoverningRateLimits([a, b], now);
  assert.equal(r.fiveHourPct, 60, 'untimed lines get the same pessimistic treatment');
});

test('pickGoverningRateLimits: returns null when there are no rate_limit events', async () => {
  const { pickGoverningRateLimits } = await import('../bin/ai-budget-lib.mjs');
  assert.equal(pickGoverningRateLimits(['{}', 'not json'], 1782300000), null);
});
