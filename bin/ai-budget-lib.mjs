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
  const fiveHourResetsAt = rl.primary && typeof rl.primary.resets_at === 'number'
    && rl.primary.resets_at > nowEpoch ? rl.primary.resets_at : null;
  const weeklyResetsAt = rl.secondary && typeof rl.secondary.resets_at === 'number'
    && rl.secondary.resets_at > nowEpoch ? rl.secondary.resets_at : null;
  return {
    fiveHourPct: windowRemaining(rl.primary, nowEpoch),
    weeklyPct: windowRemaining(rl.secondary, nowEpoch),
    fiveHourResetsAt,
    weeklyResetsAt,
    resetsAt: weeklyResetsAt,   // back-compat alias
  };
}

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
  const reset = (w) => { const e = toEpoch(w?.resets_at); return e !== null && e > nowEpoch ? e : null; };
  const fiveHourResetsAt = reset(fh);
  const weeklyResetsAt = reset(wk);
  return {
    fiveHourPct: pctRemaining(fh),
    weeklyPct: pctRemaining(wk),
    fiveHourResetsAt,
    weeklyResetsAt,
    resetsAt: weeklyResetsAt,   // back-compat alias
  };
}

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

const RESET_SOON_MIN = 90; // minutes

function resetsSoon(resetEpoch, nowMs) {
  if (resetEpoch == null) return false;
  return (resetEpoch * 1000 - nowMs) < RESET_SOON_MIN * 60000;
}

export function formatIfBelow(state, threshold, nowMs) {
  const nowEpoch = nowMs / 1000;
  const c = state?.claude, x = state?.codex;

  // Determine per-provider weekly state
  const claudeWeeklyPct = c?.weeklyPct ?? null;
  const claudeWeeklyReset = c?.weeklyResetsAt ?? null;
  const claudeWeeklyLow = claudeWeeklyPct != null && claudeWeeklyPct < threshold;
  const claudeWeeklyResetSoon = resetsSoon(claudeWeeklyReset, nowMs);

  const codexWeeklyPct = x?.weeklyPct ?? null;
  const codexWeeklyHealthy = codexWeeklyPct != null && codexWeeklyPct >= 50;

  // The frugal/offload hint fires ONLY on the WEEKLY window, and ONLY when it is low
  // AND not resetting soon (use-it-or-lose-it otherwise).
  const shouldWarnWeekly = claudeWeeklyLow && !claudeWeeklyResetSoon;

  // 5h window neutral note: show when 5h is below threshold but weekly is NOT triggering a warn
  // (ie weekly is healthy or resetting soon).
  const claudeFiveHourPct = c?.fiveHourPct ?? null;
  const claudeFiveHourReset = c?.fiveHourResetsAt ?? null;
  const fiveHourLow = claudeFiveHourPct != null && claudeFiveHourPct < threshold;

  // If nothing to say, return ''
  if (!shouldWarnWeekly && !fiveHourLow) return '';

  const lines = [];

  if (shouldWarnWeekly) {
    lines.push(`⚠ Claude weekly budget low (${claudeWeeklyPct}%):`,
      providerLine('Claude', c), providerLine('Codex', x));
    if (codexWeeklyHealthy) {
      lines.push('→ Claude is the constraint; Codex has idle budget. Prefer routing heavy/parallel '
        + 'work to Codex and stay lean. Be deliberate before any big token spend.');
    } else {
      lines.push('→ Be deliberate before any big token spend; consider lower effort / batching.');
    }
  } else if (fiveHourLow) {
    // Weekly is healthy (or resetting soon): 5h is just a throttle, emit neutral note only
    let resetNote = '';
    if (claudeFiveHourReset != null) {
      const minsUntil = Math.round((claudeFiveHourReset * 1000 - nowMs) / 60000);
      if (minsUntil > 0) {
        const h = Math.floor(minsUntil / 60), m = minsUntil % 60;
        resetNote = ` until it resets in ${h > 0 ? h + 'h ' : ''}${m}m`;
      }
    }
    lines.push(`↻ 5h window low (${claudeFiveHourPct}%); you may be throttled${resetNote} — it doesn't bank, so spend freely.`);
  }

  const { label } = ageStr(state?.generatedAt, nowMs);
  lines.push(`(${label})`);
  return lines.join('\n');
}
