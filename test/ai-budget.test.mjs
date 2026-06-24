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
  assert.equal(formatIfBelow(STATE, 10, now), '');  // 18 >= 10 → silent
  const s = formatIfBelow(STATE, 30, now);           // Claude weekly 18 < 30, Codex weekly 81 → imbalance hint
  assert.match(s, /Claude is the constraint/);
  // Must NOT suggest frugality when Claude is the only constrained party
  assert.match(s, /route heavy|parallel|Codex/i);
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

// 2. Weekly low + far from reset + Codex weekly healthy → frugal + Codex-offload fires
test('formatIfBelow: weekly low (14%), far from reset + Codex healthy → frugal + offload hint', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const weeklyResetsAt = Math.floor(base / 1000) + 5 * 24 * 3600; // 5d away
  const fiveHourResetsAt = Math.floor(base / 1000) + 3 * 3600;
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 90, weeklyPct: 14, fiveHourResetsAt, weeklyResetsAt, resetsAt: weeklyResetsAt, spentToday: 0, spent7d: 0 },
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

// 5. null reset times / missing windows → no throw; low weekly with null reset still conserves
test('formatIfBelow: null weeklyResetsAt → conserves (fail-safe)', () => {
  const base = Date.parse('2026-06-24T12:00:00Z');
  const state = {
    generatedAt: '2026-06-24T12:00:00Z',
    claude: { fiveHourPct: 80, weeklyPct: 14, fiveHourResetsAt: null, weeklyResetsAt: null, resetsAt: null, spentToday: 0, spent7d: 0 },
    codex:  { fiveHourPct: 99, weeklyPct: 72, fiveHourResetsAt: null, weeklyResetsAt: null, resetsAt: null, spentToday: 0, spent7d: 0 },
  };
  let out;
  assert.doesNotThrow(() => { out = formatIfBelow(state, 30, base); });
  // null reset → not "resetting soon" → weekly low 14 < 30 → frugal hint should fire
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
