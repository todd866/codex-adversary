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
