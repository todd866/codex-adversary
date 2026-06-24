# Claude carry-forward fix — implementation report

## Helper: `pickClaudeWindows` (bin/ai-budget-lib.mjs)

```js
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
```

## refresh() wiring diff (bin/ai-budget.mjs)

Key changes:
1. Import `pickClaudeWindows` alongside the other lib imports.
2. Rename the fetch result to `freshWin`; compute `claudeWin` via `pickClaudeWindows(freshWin, readState(), nowMs)`.
3. History append gated on `freshWin?.weeklyPct` (NOT `claudeWin`) — carried values never pollute the trend slope.

```diff
- const claudeWin = await claudeWindows(nowEpoch);
+ const freshWin = await claudeWindows(nowEpoch);
+ const claudeWin = pickClaudeWindows(freshWin, readState(), nowMs);

- if (typeof claudeWeeklyPct === 'number') {
-   history.push({ t: nowMs, cw: claudeWeeklyPct });
- }
+ if (typeof freshWin?.weeklyPct === 'number') {
+   history.push({ t: nowMs, cw: freshWin.weeklyPct });
+ }
```

## Test output

```
1..40
# tests 40
# pass 40
# fail 0
```

5 new `pickClaudeWindows` tests added (tests 36-40):
- freshWin present → returned unchanged
- freshWin null + prevState <15min old → carries subset (weeklyPct/fiveHourPct/resets)
- freshWin null + prevState 20min old → null (too stale)
- freshWin null + prevState.claude null → null
- freshWin null + prevState null → null

History-append confirmed to use `freshWin?.weeklyPct` (not carried `claudeWin`).
