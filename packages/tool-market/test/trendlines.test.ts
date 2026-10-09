import { describe, expect, it } from 'vitest'
import { trendlineCandidate } from '../src/trendlines.js'
import { detectTrendlines, renderStructure, priceStructure, type Swing } from '../src/structure.js'
import { detectSwingPoints } from '../src/swing-points.js'

// Well-separated wick reactions to the line y=100+i; no implicit touch from
// ordinary candles. Mirror prices about 150 for symmetric resistance cases.
function fixture(indices = [4, 12], kind: 'support' | 'resistance' = 'support') {
  const bars = Array.from({ length: 30 }, (_, index) => {
    const line = 100 + index
    const low = indices.includes(index) ? line : line + 2
    return {
      time: new Date(Date.UTC(2026, 0, 1, 0, index * 15)).toISOString(),
      low: kind === 'support' ? low : 300 - (low + 2),
      high: kind === 'support' ? low + 2 : 300 - low,
      close: kind === 'support' ? low + 1 : 300 - (low + 1), volume: 100,
    }
  })
  const pivots = indices.map(index => ({ index, time: bars[index]!.time,
    price: kind === 'support' ? bars[index]!.low : bars[index]!.high }))
  return { bars, pivots }
}

describe.each(['support', 'resistance'] as const)('%s trendline validation', kind => {
  it('keeps two separated anchors provisional', () => {
    const { bars, pivots } = fixture([4, 12], kind)
    const line = trendlineCandidate(bars, pivots, kind)!
    expect(line.status).toBe('candidate')
    expect(line.touches).toBe(2)
    expect(line.retests).toBe(0)
  })

  it('counts later independent pivots rather than hugging candles', () => {
    const { bars, pivots } = fixture([4, 12], kind)
    for (let i = 13; i < 22; i++) {
      const y = kind === 'support' ? 100 + i : 200 - i
      if (kind === 'support') Object.assign(bars[i]!, { low: y + 0.05, high: y + 2, close: y + 1 })
      else Object.assign(bars[i]!, { high: y - 0.05, low: y - 2, close: y - 1 })
    }
    const line = trendlineCandidate(bars, pivots, kind)!
    expect(line.touches).toBe(2)
    expect(line.status).toBe('candidate')
  })

  it('verifies a third later independent reaction without moving the anchors', () => {
    const { bars, pivots } = fixture([4, 12, 20], kind)
    const line = trendlineCandidate(bars, pivots, kind)!
    expect(line.status).toBe('confirmed')
    expect(line.anchorIndices).toEqual([4, 12])
    expect(line.touchPoints).toHaveLength(3)
    expect(line.retests).toBe(1)
  })

  it('rejects a line cutting an intervening wick even if the close is safe', () => {
    const { bars, pivots } = fixture([4, 12], kind)
    if (kind === 'support') bars[8]!.low = 107
    else bars[8]!.high = 193
    expect(trendlineCandidate(bars, pivots, kind)).toBeNull()
  })

  it('marks a later close beyond as broken, not retrospectively confirmed', () => {
    const { bars, pivots } = fixture([4, 12, 20], kind)
    if (kind === 'support') Object.assign(bars[16]!, { low: 114, close: 115 })
    else Object.assign(bars[16]!, { high: 186, close: 185 })
    const line = trendlineCandidate(bars, pivots, kind)!
    expect(line.status).toBe('broken')
    expect(line.firstBreakTime).toBe(bars[16]!.time)
    expect(line.retests).toBe(0)
    expect(line.closesBeyond).toBe(1)
  })

  it('rejects adjacent anchors and never falls back to the wrong slope', () => {
    const { bars, pivots } = fixture([4, 6], kind)
    expect(trendlineCandidate(bars, pivots, kind)).toBeNull()
    const wrong = fixture([4, 12], kind === 'support' ? 'resistance' : 'support')
    // Present real extremes in the requested role, but their slope is reversed.
    const ps = wrong.pivots.map(p => ({ ...p,
      price: kind === 'support' ? wrong.bars[p.index]!.low : wrong.bars[p.index]!.high }))
    expect(trendlineCandidate(wrong.bars, ps, kind)).toBeNull()
  })

  it('rejects a cluster with no material departure between its pivots', () => {
    const { bars, pivots } = fixture([4, 12, 20], kind)
    for (let i = 5; i < 20; i++) {
      if (i === 12) continue
      const y = kind === 'support' ? 100 + i : 200 - i
      if (kind === 'support') Object.assign(bars[i]!, { low: y + 0.05, high: y + 2, close: y + 1 })
      else Object.assign(bars[i]!, { high: y - 0.05, low: y - 2, close: y - 1 })
    }
    expect(trendlineCandidate(bars, pivots, kind)).toBeNull()
  })
})

it('does not count a possibly live last bar as a confirmed break', () => {
  const { bars, pivots } = fixture()
  Object.assign(bars[29]!, { low: 120, close: 121 })
  const line = trendlineCandidate(bars, pivots, 'support')!
  expect(line.status).toBe('candidate')
  expect(line.closesBeyond).toBe(0)
  expect(line.pathPoints[2]!.time).toBe(bars[29]!.time)
})

it('caps tolerance by local volatility instead of counting all nearby highs', () => {
  const bars = Array.from({ length: 30 }, (_, i) => ({
    time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    high: 2500 - i - 0.4, low: 2500 - i - 0.6, close: 2500 - i - 0.5, volume: 100,
  }))
  bars[4]!.high = 2496
  bars[12]!.high = 2488
  bars[20]!.high = 2480.8 // 0.032% away: inside old 0.3%, outside volatility cap
  const pivots = [4, 12, 20].map(index => ({ index, time: bars[index]!.time, price: bars[index]!.high }))
  const line = trendlineCandidate(bars, pivots, 'resistance')!
  expect(line.status).toBe('candidate')
  expect(line.touches).toBe(2)
  expect(line.retests).toBe(0)
})

it('uses raw wick prices despite snapshot display rounding', () => {
  const { bars, pivots } = fixture([4, 12, 20])
  bars.forEach(bar => { bar.high += 0.003; bar.low += 0.003; bar.close += 0.003 })
  const lows: Swing[] = pivots.map(p => ({ ...p, label: 'HL', rsi: null }))
  const lines = detectTrendlines(bars, [], lows)
  expect(lines[0]!.p1.price).toBe(104.003)
  expect(lines[0]!.status).toBe('confirmed')
})

it('rejects empty/duplicate/out-of-range pivots without throwing', () => {
  const { bars, pivots } = fixture()
  expect(trendlineCandidate([], pivots, 'support')).toBeNull()
  expect(trendlineCandidate(bars, [pivots[0]!, pivots[0]!], 'support')).toBeNull()
  expect(trendlineCandidate(bars, [{ ...pivots[0]!, index: 99 }, pivots[1]!], 'support')).toBeNull()
})

describe.each(['support', 'resistance'] as const)('%s raw-candle parity', kind => {
  it.each(['unique', 'plateau', 'live-tail'] as const)('agrees on %s pivots and line status', shape => {
    const bars = Array.from({ length: shape === 'live-tail' ? 24 : 30 }, (_, i) => ({
      time: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      low: 102 + i * 0.1, high: 104 + i * 0.1, close: 103 + i * 0.1, volume: 100,
    }))
    for (const index of [4, 12, 20]) {
      const reaction = { low: 100 + index * 0.1, high: 102 + index * 0.1, close: 101 + index * 0.1 }
      Object.assign(bars[index]!, reaction)
      if (shape === 'plateau') Object.assign(bars[index + 1]!, reaction)
    }
    if (kind === 'resistance') bars.forEach(bar => {
      const { low, high, close } = bar
      Object.assign(bar, { low: 300 - high, high: 300 - low, close: 300 - close })
    })
    const swings = detectSwingPoints(bars.slice(0, -1))
    const pivots = kind === 'support' ? swings.swingLows : swings.swingHighs
    const candidate = trendlineCandidate(bars, pivots, kind)
    const snapshot = priceStructure(bars).trendlines.find(line => line.direction === (kind === 'support' ? 'up' : 'down'))
    if (shape === 'plateau') {
      expect(pivots).toHaveLength(0)
      expect(candidate).toBeNull()
      expect(snapshot).toBeUndefined()
    } else {
      expect(candidate?.status).toBe(shape === 'live-tail' ? 'candidate' : 'confirmed')
      expect(snapshot).toMatchObject({ touches: candidate!.touches, retests: candidate!.retests,
        status: candidate!.status, p1: candidate!.anchors[0], p2: candidate!.anchors[1] })
    }
  })
})

it('uses identical geometry/status in the snapshot and swing-point tool', () => {
  const { bars, pivots } = fixture([4, 12, 20])
  const lows: Swing[] = pivots.map(p => ({ ...p, label: 'HL', rsi: null }))
  const candidate = trendlineCandidate(bars, pivots, 'support')!
  const lines = detectTrendlines(bars, [], lows)
  expect(lines).toHaveLength(1)
  expect(lines[0]).toMatchObject({ touches: candidate.touches, retests: candidate.retests,
    status: candidate.status, p1: { index: 4 }, p2: { index: 12 } })
  const text = renderStructure({ highs: [], lows, trend: 'up', breakOut: null, divergence: [],
    volume: { lastRatio: null, peakRatio: null, peakTime: null }, trendlines: lines })
  expect(text).toContain('3个独立摆动触点')
  expect(text).toContain('回测确认（非保证）')
})
