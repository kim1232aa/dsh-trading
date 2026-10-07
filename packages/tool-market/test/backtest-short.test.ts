import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { createDonchianStrategy, createDualEmaStrategy, runBacktest } from '../src/backtest-engine.js'

/** Oscillating series with a drift; negative drift = bear market. Swings big enough to make EMAs cross. */
function series(count: number, start: number, drift: number): Candle[] {
  const out: Candle[] = []
  let price = start
  const t0 = Date.parse('2026-01-01T00:00:00.000Z')
  for (let i = 0; i < count; i++) {
    const open = price
    const close = Math.max(1, price + Math.sin(i / 8) * 4 + drift)
    out.push({
      time: new Date(t0 + i * 3600_000).toISOString(),
      open,
      high: Math.max(open, close) + 1,
      low: Math.min(open, close) - 1,
      close,
      volume: 1000,
    })
    price = close
  }
  return out
}

describe('short-side preset strategies', () => {
  const bear = series(300, 800, -0.8)

  it('long-only presets never open a short (backwards compatible default)', () => {
    for (const strat of [createDualEmaStrategy(12, 26), createDonchianStrategy(20, 10)]) {
      const res = runBacktest('X', '1h', bear, strat)
      expect(res.trades.every(t => t.side === 'long')).toBe(true)
    }
  })

  it('dual EMA short-only trades shorts and profits in a downtrend', () => {
    const res = runBacktest('X', '1h', bear, createDualEmaStrategy(12, 26, 'short'), { allowShort: true })
    expect(res.trades.length).toBeGreaterThan(0)
    expect(res.trades.every(t => t.side === 'short')).toBe(true)
    expect(res.totalReturnPct).toBeGreaterThan(0)
  })

  it('donchian short-only breaks down and profits in a downtrend', () => {
    const res = runBacktest('X', '1h', bear, createDonchianStrategy(20, 10, 'short'), { allowShort: true })
    expect(res.trades.length).toBeGreaterThan(0)
    expect(res.trades.every(t => t.side === 'short')).toBe(true)
    expect(res.totalReturnPct).toBeGreaterThan(0)
  })

  it('both-direction mode trades both sides on a round trip', () => {
    const t0 = Date.parse('2026-01-01T00:00:00.000Z')
    const roundTrip = [...series(200, 300, 0.8), ...series(200, 460, -0.8)]
      .map((c, i) => ({ ...c, time: new Date(t0 + i * 3600_000).toISOString() }))
    const res = runBacktest('X', '1h', roundTrip, createDualEmaStrategy(12, 26, 'both'), { allowShort: true })
    const sides = new Set(res.trades.map(t => t.side))
    expect(sides.has('long')).toBe(true)
    expect(sides.has('short')).toBe(true)
  })
})
