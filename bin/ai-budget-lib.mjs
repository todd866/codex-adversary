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
