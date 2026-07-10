#!/usr/bin/env node
import { readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, statSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { summariseCodexRateLimits, looksLikeRateLimitLine, parseCodexRetryAt, shouldProbeCodex,
         sumClaudeTranscriptTokens, parseClaudeUsageWindows, formatSnapshot, formatIfBelow,
         projectWeeklyTrend, pickClaudeWindows } from './ai-budget-lib.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const HOME = homedir();
const STATE = join(HOME, '.claude', '.cache', 'ai-budget.json');
const HISTORY = join(HOME, '.claude', '.cache', 'ai-budget-history.json');
const HISTORY_MAX = 400;

function readHistory() {
  try {
    const raw = JSON.parse(readFileSync(HISTORY, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw;
  } catch { return []; }
}

function writeHistory(history) {
  try {
    const tmp = HISTORY + '.tmp';
    writeFileSync(tmp, JSON.stringify(history));
    renameSync(tmp, HISTORY);
  } catch { /* never crash refresh */ }
}

// Rate-limit lines from EVERY session touched recently — not just the newest file.
// Concurrent Codex sessions (ChatGPT.app + CLI) report different window instances, so
// the governing snapshot can live in a file that is not the newest by mtime.
// summariseCodexRateLimits() then reports the spread across live windows, not a winner.
//
// Two hazards, both a direct consequence of walking a directory that concurrent Codex
// processes are actively writing and rotating:
//   * A file can vanish between readdirSync naming it and statSync reading it. A throw
//     there must skip that entry, NOT abort the walk — an aborted walk returns [], which
//     silently drops Codex from the budget snapshot entirely.
//   * Session transcripts carry tool output and get large. Only rate-limit lines are
//     ever used, so filter before accumulating rather than holding every line in memory
//     on a hook that runs at SessionStart and before tool calls.
function recentCodexSessionLines(windowMs = 12 * 3600_000) {
  const root = join(HOME, '.codex', 'sessions');
  if (!existsSync(root)) return [];
  const cutoff = Date.now() - windowMs;
  const files = [];
  const walk = (dir) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith('.jsonl')) continue;
      try { if (statSync(p).mtimeMs >= cutoff) files.push(p); } catch { /* rotated away mid-walk */ }
    }
  };
  walk(root);
  const out = [];
  for (const f of files) {
    try {
      for (const l of readFileSync(f, 'utf8').split('\n')) {
        if (l && looksLikeRateLimitLine(l)) out.push(l);
      }
    } catch { /* skip */ }
  }
  return out;
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

// The Codex model whose admission we actually care about — the one codex-adversary.sh runs.
// A cheaper model proves nothing: gpt-5.6-luna was served while the general limit read 100%.
const PROBE_MODEL = process.env.CODEX_PROBE_MODEL || 'gpt-5.6-sol';
const PROBE_TIMEOUT_MS = 30_000;

// refresh() is run by launchd, whose PATH is /usr/bin:/bin:/usr/sbin:/sbin. `codex` lives in
// an nvm bin dir, so a bare execFileSync('codex') throws ENOENT there and the probe reports
// `unknown` forever — while working perfectly when a human tests it in a login shell. Resolve
// the binary explicitly. `dirname(process.execPath)` is the nvm bin dir that holds both node
// and codex, so it self-heals across nvm version bumps.
function resolveCodexBin() {
  const candidates = [
    process.env.CODEX_BIN,
    join(dirname(process.execPath), 'codex'),
    '/opt/homebrew/bin/codex',
    '/usr/local/bin/codex',
    join(HOME, '.local', 'bin', 'codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (existsSync(c)) return c; } catch { /* keep looking */ }
  }
  return null;   // caller reports `unknown`, never `refusing`
}

// Ask Codex the only question its telemetry cannot answer: will you take a new turn?
// One trivial request at the lowest effort. Distinguishes three outcomes, and NEVER reports a
// crash, a timeout, or a missing binary as a refusal — that would stand an agent down on no
// evidence, the exact failure this whole exercise was about.
function probeCodex(nowMs) {
  const bin = resolveCodexBin();
  if (!bin) return { at: nowMs, status: 'unknown', model: PROBE_MODEL, retryAt: null, detail: 'codex-not-found' };
  let dir;
  try {
    dir = mkdtempSync(join(tmpdir(), 'codex-probe-'));
    // `codex` is a `#!/usr/bin/env node` shim, so resolving its path is not enough: under
    // launchd's PATH the child cannot find `node` and dies with exit 127. Put node's own
    // directory on the child's PATH.
    const nodeDir = dirname(process.execPath);
    execFileSync(bin, [
      'exec', '--sandbox', 'read-only', '--ephemeral', '--skip-git-repo-check',
      '-C', dir, '-m', PROBE_MODEL, '-c', 'model_reasoning_effort=low',
      'Reply with exactly: OK',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'], timeout: PROBE_TIMEOUT_MS, encoding: 'utf8',
      env: { ...process.env, PATH: `${nodeDir}:${process.env.PATH ?? ''}` },
    });
    return { at: nowMs, status: 'serving', model: PROBE_MODEL, retryAt: null };
  } catch (e) {
    const out = `${e?.stdout ?? ''}${e?.stderr ?? ''}`;
    if (/usage limit|rate.?limit|\b429\b/i.test(out)) {
      return { at: nowMs, status: 'refusing', model: PROBE_MODEL, retryAt: parseCodexRetryAt(out, nowMs) };
    }
    // ENOENT, timeout (e.signal === 'SIGTERM'), auth failure, anything else: we learned nothing.
    return { at: nowMs, status: 'unknown', model: PROBE_MODEL, retryAt: null, detail: e?.code ?? e?.signal ?? null };
  } finally {
    if (dir) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
  }
}

async function refresh() {
  const nowMs = Date.now(), nowEpoch = Math.floor(nowMs / 1000);
  const codexRL = summariseCodexRateLimits(recentCodexSessionLines(), nowEpoch);
  // refresh() runs every 60s; the probe is throttled, and a believed refusal is not re-tested
  // until the retry time Codex itself named.
  const prevProbe = readState()?.codex?.probe ?? null;
  const codexProbe = shouldProbeCodex(prevProbe, nowMs) ? probeCodex(nowMs) : prevProbe;
  const tlines = allTranscriptLines();
  const claudeSpend = sumClaudeTranscriptTokens(tlines, nowMs);
  const freshWin = await claudeWindows(nowEpoch);
  const claudeWin = pickClaudeWindows(freshWin, readState(), nowMs);

  const claudeWeeklyPct = claudeWin?.weeklyPct ?? null;
  const claudeWeeklyResetsAt = claudeWin?.weeklyResetsAt ?? null;

  // Maintain history: append only on a FRESH fetch (never on a carried value,
  // which would pollute the trend slope with repeated stale points).
  let history = readHistory();
  if (typeof freshWin?.weeklyPct === 'number') {
    history.push({ t: nowMs, cw: freshWin.weeklyPct });
  }
  // Prune to within TREND_LOOKBACK_MIN (re-use the constant's value directly)
  const lookbackFloor = nowMs - 180 * 60 * 1000;
  history = history.filter(p => p != null && typeof p.t === 'number' && p.t >= lookbackFloor);
  if (history.length > HISTORY_MAX) history = history.slice(history.length - HISTORY_MAX);
  writeHistory(history);

  // Compute trend and embed in claude state
  const weeklyTrend = projectWeeklyTrend(history, claudeWeeklyPct ?? 0, claudeWeeklyResetsAt, nowMs);

  const state = {
    generatedAt: new Date(nowMs).toISOString(),
    claude: (!claudeWin && tlines.length === 0) ? null : {
      fiveHourPct: claudeWin?.fiveHourPct ?? null,
      weeklyPct: claudeWeeklyPct,
      fiveHourResetsAt: claudeWin?.fiveHourResetsAt ?? null,
      weeklyResetsAt: claudeWeeklyResetsAt,
      resetsAt: claudeWeeklyResetsAt,   // back-compat alias
      weeklyTrend,
      spentToday: claudeSpend.todayUncached, spent7d: claudeSpend.sevenDayUncached,
    },
    // The probe stands alone: it is meaningful even when the rate-limit telemetry is absent,
    // and it is the only field here that reflects a decision the server actually made.
    codex: (codexRL || codexProbe)
      ? { ...(codexRL ?? {}), probe: codexProbe, spentToday: null, spent7d: null }
      : null,
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
