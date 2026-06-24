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
  assert.equal(r.resetsAt, null);
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
});

test('parseClaudeUsageWindows: percent utilization + epoch reset, missing windows → null', () => {
  const now = 1782300000;
  const r = parseClaudeUsageWindows({ five_hour: { utilization: 40, resets_at: 1782314385 } }, now);
  assert.equal(r.fiveHourPct, 60);
  assert.equal(r.weeklyPct, null);
  assert.equal(r.resetsAt, null);
});
