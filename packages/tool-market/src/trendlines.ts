/** Conservative wick-anchored, arithmetic-scale candidates; not trade signals. */
type Bar = { time: string; high: number; low: number; close: number }
type Pivot = { index: number; price: number; time: string }
type Kind = 'resistance' | 'support'

// Engineering heuristics, not universal TA rules. Volatility caps price tolerance.
const MIN_GAP = 4
const MIN_MOVE = 0.001
const MAX_PIVOTS = 16

export function trendlineCandidate(candles: readonly Bar[], pivots: readonly Pivot[], kind: Kind) {
  if (candles.length < 2 || pivots.length < 2) return null
  const last = candles.length - 1
  // OHLCV has no closed flag. Conservatively exclude the tail from break/touch
  // evidence even for historical requests; use it only for time projection.
  const lastEvidence = last - 1
  const ranges = candles.map((c, i) => Math.max(c.high - c.low,
    Math.abs(c.high - (candles[i - 1]?.close ?? c.close)),
    Math.abs(c.low - (candles[i - 1]?.close ?? c.close))))
  const tolerances = ranges.map((_, i) => {
    const recent = ranges.slice(Math.max(0, i - 13), i + 1).sort((a, b) => a - b)
    return Math.min(candles[i]!.close * 0.0015, recent[Math.floor(recent.length / 2)]! * 0.25)
  })
  const extreme = (c: Bar): number => kind === 'resistance' ? c.high : c.low
  const beyond = (price: number, line: number, tolerance: number): boolean =>
    kind === 'resistance' ? price > line + tolerance : price < line - tolerance
  const eligible = pivots.filter(p => Number.isInteger(p.index) && p.index >= 0 && p.index <= lastEvidence &&
    Number.isFinite(p.price) && p.price > 0 && p.time === candles[p.index]!.time &&
    Math.abs(p.price - extreme(candles[p.index]!)) <= p.price * 1e-8)
    .sort((a, b) => a.index - b.index).filter((p, i, ps) => i === 0 || p.index !== ps[i - 1]!.index)
  const search = eligible.slice(-MAX_PIVOTS)

  function evaluate(a: Pivot, b: Pivot) {
    const spanBars = b.index - a.index
    if (spanBars < MIN_GAP || Math.abs(b.price - a.price) / a.price < MIN_MOVE) return null
    const slope = (b.price - a.price) / spanBars
    if (kind === 'resistance' ? slope >= 0 : slope <= 0) return null
    const lineAt = (i: number): number => a.price + slope * (i - a.index)
    const projectedNow = lineAt(last)
    if (!Number.isFinite(projectedNow) || projectedNow <= 0) return null
    // A conventional wick-anchored line cannot slice through intervening candles.
    for (let i = a.index + 1; i < b.index; i++) {
      if (beyond(extreme(candles[i]!), lineAt(i), tolerances[i]!)) return null
    }
    let closesBeyond = 0
    let firstBreakIndex: number | null = null
    for (let i = b.index + 1; i <= lastEvidence; i++) {
      if (beyond(candles[i]!.close, lineAt(i), tolerances[i]!)) {
        closesBeyond++
        firstBreakIndex ??= i
      }
    }
    // Count separated pivot reactions, not every nearby candle. Require a departure
    // between touches so several pivots in one sideways cluster count only once.
    const touches: Pivot[] = [a]
    for (const p of eligible) {
      const previous = touches[touches.length - 1]!
      if (p.index <= a.index || p.index - previous.index < MIN_GAP ||
        (firstBreakIndex !== null && p.index >= firstBreakIndex) ||
        Math.abs(p.price - lineAt(p.index)) > tolerances[p.index]!) continue
      let departed = false
      for (let i = previous.index + 1; i < p.index; i++) {
        const distance = kind === 'resistance' ? lineAt(i) - candles[i]!.high : candles[i]!.low - lineAt(i)
        if (distance > 2 * tolerances[i]!) { departed = true; break }
      }
      if (departed) touches.push(p)
    }
    // Both defining anchors must be independent reactions. Extra points between
    // anchors help describe fit, but only a later reaction verifies this candidate.
    if (!touches.some(p => p.index === b.index)) return null
    const retests = touches.filter(p => p.index > b.index).length
    const status = firstBreakIndex !== null ? 'broken' as const : retests > 0 ? 'confirmed' as const : 'candidate' as const
    return {
      kind, direction: slope > 0 ? 'rising' as const : 'falling' as const,
      anchors: [{ time: a.time, price: a.price }, { time: b.time, price: b.price }] as const,
      anchorIndices: [a.index, b.index] as const,
      projectedNow, spanBars, scale: 'arithmetic' as const, status,
      pathPoints: [
        { time: a.time, price: a.price }, { time: b.time, price: b.price },
        { time: candles[last]!.time, price: Number(projectedNow.toPrecision(8)) },
      ],
      touches: touches.length, retests, closesBeyond,
      touchPoints: touches.map(p => ({ time: p.time, price: p.price })),
      firstBreakTime: firstBreakIndex === null ? null : candles[firstBreakIndex]!.time,
    }
  }

  const candidates: NonNullable<ReturnType<typeof evaluate>>[] = []
  for (let j = 1; j < search.length; j++) {
    for (let i = 0; i < j; i++) {
      const candidate = evaluate(search[i]!, search[j]!)
      if (candidate) candidates.push(candidate)
    }
  }
  // Always search pairs; never silently fall back to a wrong-slope or intersecting line.
  const rank = { confirmed: 2, candidate: 1, broken: 0 }
  candidates.sort((a, b) => rank[b.status] - rank[a.status] || b.retests - a.retests ||
    b.touches - a.touches || b.anchorIndices[1] - a.anchorIndices[1] || b.spanBars - a.spanBars)
  return candidates[0] ?? null
}
