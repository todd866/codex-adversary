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
// A window percentage is REMAINING, never spent — always render it as "N% left"
// so it can't be confused with the "used X tokens" column beside it.
const pctLeft = (p) => p == null ? 'n/a' : `${p}% left`;

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

function providerLine(name, p, weeklyCritical = false) {
  if (!p) return `${name.padEnd(6)} n/a`;
  const mark = weeklyCritical ? ' ⚠' : '';
  const used = (p.spentToday == null && p.spent7d == null)
    ? 'used n/a'
    : `used ${fmtTok(p.spentToday)} today / ${fmtTok(p.spent7d)} 7d`;
  return `${name.padEnd(6)} 5h ${pctLeft(p.fiveHourPct)} · week ${pctLeft(p.weeklyPct)}${mark} · ${used}`;
}

export function formatSnapshot(state, nowMs) {
  const { mins, label } = ageStr(state?.generatedAt, nowMs);
  const stale = mins > 15 ? ' ⚠ stale — service may be down' : '';
  const c = state?.claude, x = state?.codex;
  // A critically-low *weekly* window (the constraining one) is marked inline so
  // the eye lands on the exact problem. 5h-low is "use it or lose it", not a
  // problem, so it never gets the ⚠.
  const claudeCritical = weeklyIsConstraining(c, nowMs);
  const codexCritical = weeklyIsConstraining(x, nowMs);
  const lines = [
    providerLine('Claude', c, claudeCritical),
    providerLine('Codex', x, codexCritical),
    `(${label}${stale})`,
  ];

  // (a) 5h use-it-or-lose-it note when 5h is below WATCH_PCT
  const fiveHourPct = c?.fiveHourPct ?? null;
  if (fiveHourPct != null && fiveHourPct < WATCH_PCT) {
    const resetNote = fiveHourResetNote(c?.fiveHourResetsAt, nowMs);
    lines.push(`↻ 5h window low (${fiveHourPct}%)${resetNote} — doesn't bank, spend freely`);
  }

  // (b) THE ACTIONABLE VERDICT — when Claude's weekly is the constraint, name it,
  // its remaining headroom, the trend, AND where to offload. This is the
  // conclusion (don't make the reader infer it from raw numbers, which is exactly
  // how 9%-remaining got misread as 9%-spent on 2026-06-27).
  if (claudeCritical) {
    const trendSuffix = (c.weeklyPct < WATCH_PCT && c?.weeklyTrend?.willRunDryBeforeReset)
      ? ', on track to run dry before reset' : '';
    lines.push(`⚠ Claude is the constraint — ${c.weeklyPct}% week left${trendSuffix}. ${routingAdvice(x?.weeklyPct)}`);
  } else if (c?.weeklyTrend?.willRunDryBeforeReset) {
    // trending dry but not yet critical — the soft heads-up
    lines.push('weekly trending down — on track to run dry before reset');
  }

  return lines.join('\n');
}

const RESET_SOON_MIN = 90;       // minutes (already existed)
const FLOOR_PCT = 12;             // "approaching 10%" critical floor
const WATCH_PCT = 30;             // below this + trending dry → critical warn
const CODEX_HEALTHY_PCT = 50;     // ≥ this weekly → safe to offload heavy work to
const TREND_LOOKBACK_MIN = 180;   // prune history older than this
const TREND_MIN_SPAN_MIN = 20;    // need at least this span of usable points

function resetsSoon(resetEpoch, nowMs) {
  if (resetEpoch == null) return false;
  return (resetEpoch * 1000 - nowMs) < RESET_SOON_MIN * 60000;
}

/**
 * weeklyIsConstraining — single source of truth for "is this provider's WEEKLY
 * window the bottleneck right now?". A window is constraining when it is low
 * enough to matter AND not about to reset the problem away:
 *   - weeklyPct < FLOOR_PCT (hard floor, ~10%), OR
 *   - weeklyPct < WATCH_PCT AND its trend projects running dry before reset,
 *   - and in BOTH cases the weekly window is NOT resetting soon.
 * Pure, null-safe, never throws. Shared by formatSnapshot (glance) and
 * formatIfBelow (pre-big-op gate) so the two never disagree about what's critical.
 */
export function weeklyIsConstraining(p, nowMs) {
  try {
    if (!p || p.weeklyPct == null) return false;
    if (resetsSoon(p.weeklyResetsAt, nowMs)) return false;
    if (p.weeklyPct < FLOOR_PCT) return true;
    if (p.weeklyPct < WATCH_PCT && p?.weeklyTrend?.willRunDryBeforeReset === true) return true;
    return false;
  } catch { return false; }
}

/**
 * routingAdvice — the single offload sentence, shared by glance + gate so the
 * advice never drifts. If Codex has healthy weekly headroom, name the number and
 * say route there; otherwise advise frugality (there's nowhere to offload).
 */
export function routingAdvice(codexWeeklyPct) {
  return (codexWeeklyPct != null && codexWeeklyPct >= CODEX_HEALTHY_PCT)
    ? `Codex has ${codexWeeklyPct}% left — route heavy/parallel work there.`
    : 'Be deliberate before any big token spend; consider lower effort / batching.';
}

/**
 * Pure trend helper. Returns { slope, projectedEmptyAt, willRunDryBeforeReset }.
 * - history: array of { t: <ms>, cw: <weeklyPct|null> }
 * - currentPct: current weekly % (used for projection)
 * - weeklyResetEpoch: epoch seconds of next weekly reset (or null)
 * - nowMs: current time in ms
 */
export function projectWeeklyTrend(history, currentPct, weeklyResetEpoch, nowMs) {
  const noTrend = { slope: null, projectedEmptyAt: null, willRunDryBeforeReset: false };
  try {
    if (!Array.isArray(history) || history.length < 2) return noTrend;

    const lookbackFloor = nowMs - TREND_LOOKBACK_MIN * 60000;
    // Keep only valid points: non-null cw, within lookback window
    const pts = history.filter(
      p => p != null && typeof p.t === 'number' && typeof p.cw === 'number' && p.t >= lookbackFloor
    );

    if (pts.length < 2) return noTrend;

    const earliest = pts[0], latest = pts[pts.length - 1];
    if ((latest.t - earliest.t) < TREND_MIN_SPAN_MIN * 60000) return noTrend;

    // Least-squares slope of cw vs t (pct per ms)
    const n = pts.length;
    let sumT = 0, sumCw = 0, sumTCw = 0, sumT2 = 0;
    for (const { t, cw } of pts) { sumT += t; sumCw += cw; sumTCw += t * cw; sumT2 += t * t; }
    const denom = n * sumT2 - sumT * sumT;
    const slope = denom === 0 ? 0 : (n * sumTCw - sumT * sumCw) / denom;

    if (slope >= 0) {
      // Flat or refilling — no dry risk
      return { slope, projectedEmptyAt: null, willRunDryBeforeReset: false };
    }

    // slope < 0: project when currentPct reaches 0
    const projectedEmptyAt = nowMs + (currentPct / (-slope));
    const willRunDryBeforeReset = weeklyResetEpoch != null
      && projectedEmptyAt < weeklyResetEpoch * 1000;

    return { slope, projectedEmptyAt, willRunDryBeforeReset };
  } catch {
    return noTrend;
  }
}

/**
 * formatIfBelow — the critical safety net for the before-every-big-op path.
 * Fires ONLY on the weekly window, ONLY when:
 *   - weekly is NOT resetting soon (>90min away or unknown reset), AND
 *   - weeklyPct != null, AND
 *   - weeklyPct < FLOOR_PCT (11% → approaching 10%)
 *     OR (weeklyPct < WATCH_PCT AND weeklyTrend.willRunDryBeforeReset === true)
 *
 * The 5h note and trend status live in formatSnapshot (the once-per-session glance).
 * The `threshold` param is kept for back-compat but the weekly decision uses
 * FLOOR_PCT/WATCH_PCT/trend, not the param.
 */
export function formatIfBelow(state, threshold, nowMs) {
  try {
    const c = state?.claude, x = state?.codex;

    // Same predicate the glance uses — the gate and the glance must agree.
    if (!weeklyIsConstraining(c, nowMs)) return '';

    const claudeWeeklyPct = c.weeklyPct;
    const trend = c?.weeklyTrend ?? null;
    const trendSuffix = (claudeWeeklyPct < WATCH_PCT && trend?.willRunDryBeforeReset === true)
      ? ', on track to run dry before reset' : '';
    const codexWeeklyPct = x?.weeklyPct ?? null;
    const codexWeeklyHealthy = codexWeeklyPct != null && codexWeeklyPct >= CODEX_HEALTHY_PCT;

    const advice = routingAdvice(codexWeeklyPct);
    const lines = [
      `⚠ Claude weekly critically low (${claudeWeeklyPct}%)${trendSuffix}`,
      codexWeeklyHealthy ? `Claude is the constraint; ${advice}` : advice,
    ];

    const { label } = ageStr(state?.generatedAt, nowMs);
    lines.push(`(${label})`);
    return lines.join('\n');
  } catch {
    return '';
  }
}

function fiveHourResetNote(fiveHourResetsAt, nowMs) {
  if (fiveHourResetsAt == null) return '';
  const minsUntil = Math.round((fiveHourResetsAt * 1000 - nowMs) / 60000);
  if (minsUntil <= 0) return '';
  const h = Math.floor(minsUntil / 60), m = minsUntil % 60;
  return `, resets in ${h > 0 ? h + 'h ' : ''}${m}m`;
}

/**
 * pickClaudeWindows — carry-forward on transient fetch failure.
 *
 * Returns:
 *   - freshWin if it is non-null (the fetch succeeded; use it).
 *   - A window-subset from prevState.claude if freshWin is null, prevState has a
 *     numeric weeklyPct, and prevState.generatedAt is within maxStaleMs of nowMs.
 *   - null otherwise.
 *
 * Pure, never throws.
 */
export function pickClaudeWindows(freshWin, prevState, nowMs, maxStaleMs = 15 * 60 * 1000) {
  try {
    if (freshWin != null) return freshWin;
    const c = prevState?.claude;
    if (typeof c?.weeklyPct !== 'number') return null;
    const t = Date.parse(prevState?.generatedAt);
    if (Number.isNaN(t)) return null;
    if (nowMs - t >= maxStaleMs) return null;
    return {
      fiveHourPct:      c.fiveHourPct      ?? null,
      weeklyPct:        c.weeklyPct,
      fiveHourResetsAt: c.fiveHourResetsAt ?? null,
      weeklyResetsAt:   c.weeklyResetsAt   ?? null,
    };
  } catch {
    return null;
  }
}
