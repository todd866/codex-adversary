#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseCodexRateLimits, sumClaudeTranscriptTokens, parseClaudeUsageWindows,
         formatSnapshot, formatIfBelow } from './ai-budget-lib.mjs';

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
      signal: AbortSignal.timeout(10000),
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
    claude: (!claudeWin && tlines.length === 0) ? null : {
      fiveHourPct: claudeWin?.fiveHourPct ?? null,
      weeklyPct: claudeWin?.weeklyPct ?? null,
      resetsAt: claudeWin?.resetsAt ?? null,
      spentToday: claudeSpend.todayUncached, spent7d: claudeSpend.sevenDayUncached,
    },
    codex: codexRL ? { ...codexRL, spentToday: null, spent7d: null } : null,
  };
  try {
    mkdirSync(join(HOME, '.claude', '.cache'), { recursive: true });
    const tmp = STATE + '.tmp';
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, STATE);
  } catch (e) { /* swallow — never break a session */ }
}

export function readState(path = STATE) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

if (process.argv[1]?.endsWith('ai-budget.mjs')) {
  const cmd = process.argv[2];
  if (cmd === 'refresh') { await refresh().catch(() => {}); }
  else if (cmd === 'read') { const s = readState(); if (s) process.stdout.write(formatSnapshot(s, Date.now()) + '\n'); }
  else if (cmd === 'if-below') {
    const s = readState(); const pct = Number(process.argv[3] ?? 30);
    if (s) { const out = formatIfBelow(s, pct, Date.now()); if (out) process.stdout.write(out + '\n'); }
  }
}
