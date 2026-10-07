import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { detectSwingPoints } from '../src/indicator-sandbox.js'

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
