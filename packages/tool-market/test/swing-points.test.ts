import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { classifySwingStructure, detectSwingPoints } from '../src/indicator-sandbox.js'
import { trendlineCandidate } from '../src/index.js'

/** Zig-zag through the given turning prices, `leg` bars per leg. */
function zigzag(turns: number[], leg = 5): Candle[] {
  const out: Candle[] = []
  for (let t = 0; t < turns.length - 1; t++) {
    for (let k = 0; k < leg; k++) {
      const mid = turns[t]! + ((turns[t + 1]! - turns[t]!) * k) / leg
      out.push(makeCandle(out.length, mid + 1, mid - 1))
    }
  }
  const lastMid = turns[turns.length - 1]!
  for (let k = 0; k < 4; k++) out.push(makeCandle(out.length, lastMid + 1 - k * 0.1, lastMid - 1 - k * 0.1))
  return out
}

describe('classifySwingStructure', () => {
  it('reads a descending staircase as LH + LL = down', () => {
    const bars = zigzag([100, 120, 90, 112, 82, 104, 74])
    const { points, bias } = classifySwingStructure(detectSwingPoints(bars, 2, 2))
    expect(bias).toBe('down')
    expect(points.some(p => p.label === 'LH')).toBe(true)
    expect(points.some(p => p.label === 'LL')).toBe(true)
  })

  it('reads an ascending staircase as HH + HL = up', () => {
    const bars = zigzag([50, 70, 60, 80, 70, 90, 80])
    expect(classifySwingStructure(detectSwingPoints(bars, 2, 2)).bias).toBe('up')
  })

  it('ignores flat plateaus (strict pivots)', () => {
    const flat = Array.from({ length: 20 }, (_, i) => makeCandle(i, 101, 99))
    const s = detectSwingPoints(flat)
    expect(s.swingHighs.length + s.swingLows.length).toBe(0)
  })
})

describe('trendlineCandidate', () => {
  it('anchors a falling resistance on the last two real swing highs', () => {
    const bars = zigzag([100, 120, 90, 112, 82, 104, 74])
    const { swingHighs } = detectSwingPoints(bars, 2, 2)
    const line = trendlineCandidate(bars, swingHighs, 'resistance')!
    expect(line.direction).toBe('falling')
    const a = swingHighs[swingHighs.length - 2]!
    const b = swingHighs[swingHighs.length - 1]!
    expect(line.anchors[0]).toEqual({ time: a.time, price: a.price })
    expect(line.anchors[1]).toEqual({ time: b.time, price: b.price })
    expect(line.pathPoints[2]!.time).toBe(bars[bars.length - 1]!.time)
    expect(line.closesBeyond).toBe(0)
  })

  it('returns null with fewer than two pivots', () => {
    expect(trendlineCandidate([], [], 'support')).toBeNull()
  })
})

function makeCandle(i: number, high: number, low: number): Candle {
  return {
    time: new Date(Date.now() + i * 86400000).toISOString(),
    open: (high + low) / 2,
    high,
    low,
    close: (high + low) / 2,
    volume: 1000,
  }
}

describe('detectSwingPoints', () => {
  it('finds swing highs and lows with default left=3 right=3', () => {
    // Create a V-shape: descending then ascending
    const bars: Candle[] = []
    for (let i = 0; i < 15; i++) {
      const mid = i < 7 ? 100 - i * 5 : 65 + (i - 7) * 5
      bars.push(makeCandle(i, mid + 2, mid - 2))
    }
    const { swingHighs, swingLows } = detectSwingPoints(bars)
    // The bottom of the V should be a swing low
    expect(swingLows.length).toBeGreaterThanOrEqual(1)
    const lowestSwing = swingLows.reduce((a, b) => (a.price < b.price ? a : b))
    expect(lowestSwing.price).toBeLessThanOrEqual(68) // near the bottom
  })

  it('finds swing high at peak of inverted V', () => {
    const bars: Candle[] = []
    for (let i = 0; i < 15; i++) {
      const mid = i < 7 ? 50 + i * 5 : 85 - (i - 7) * 5
      bars.push(makeCandle(i, mid + 2, mid - 2))
    }
    const { swingHighs } = detectSwingPoints(bars)
    expect(swingHighs.length).toBeGreaterThanOrEqual(1)
    const highestSwing = swingHighs.reduce((a, b) => (a.price > b.price ? a : b))
    expect(highestSwing.price).toBeGreaterThanOrEqual(82) // near the top
  })

  it('respects custom left/right parameters', () => {
    const bars: Candle[] = []
    for (let i = 0; i < 20; i++) {
      const mid = i < 10 ? 100 - i * 3 : 70 + (i - 10) * 3
      bars.push(makeCandle(i, mid + 1, mid - 1))
    }
    const tight = detectSwingPoints(bars, 2, 2)
    const wide = detectSwingPoints(bars, 5, 5)
    // Wider window is more selective → fewer or equal swing points
    expect(wide.swingLows.length).toBeLessThanOrEqual(tight.swingLows.length)
  })
})
