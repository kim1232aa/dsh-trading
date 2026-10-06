import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import {
  createDonchianStrategy,
  createDualEmaStrategy,
  runBacktest,
} from '../src/backtest-engine.js'

function generateCandles(count: number, startPrice = 100, trend = 0.5): Candle[] {
  const candles: Candle[] = []
  let price = startPrice
  const baseTime = Date.parse('2026-01-01T00:00:00.000Z')

  for (let i = 0; i < count; i++) {
    const change = Math.sin(i / 5) * 2 + trend
    const open = price
    const close = price + change
    const high = Math.max(open, close) + 1
    const low = Math.min(open, close) - 1
    const volume = 1000 + Math.abs(Math.sin(i)) * 500
    candles.push({
      time: new Date(baseTime + i * 3600_000).toISOString(),
      open,
      high,
      low,
      close,
      volume,
    })
    price = close
  }
  return candles
}

describe('backtest-engine', () => {
  it('runs dual EMA strategy and computes equity curve and statistics', () => {
    const bars = generateCandles(100, 100, 0.2)
    const strategy = createDualEmaStrategy(5, 15)

    const result = runBacktest('ETHUSDT', '1h', bars, strategy, {
      initialCapital: 10000,
      feePct: 0.0005,
      slippagePct: 0.0002,
    })

    expect(result.symbol).toBe('ETHUSDT')
    expect(result.timeframe).toBe('1h')
    expect(result.initialCapital).toBe(10000)
    expect(result.equityCurve.length).toBe(100)
    expect(result.totalTrades).toBeGreaterThanOrEqual(1)
    expect(result.artifact.version).toBe(1)
    expect(result.artifact.trades.length).toBe(result.totalTrades)
    expect(result.artifact.costs.included).toBe(true)
  })

  it('runs Donchian breakout strategy correctly', () => {
    const bars = generateCandles(120, 100, 0.3)
    const strategy = createDonchianStrategy(10, 5)

    const result = runBacktest('BTCUSDT', '1d', bars, strategy)

    expect(result.totalTrades).toBeGreaterThan(0)
    expect(result.winRatePct).toBeGreaterThanOrEqual(0)
    expect(result.winRatePct).toBeLessThanOrEqual(100)
    expect(result.maxDrawdownPct).toBeGreaterThanOrEqual(0)
    expect(result.sharpeRatio).toBeTypeOf('number')
  })

  it('handles empty trades gracefully', () => {
    const bars = generateCandles(50, 100, 0)
    // Strategy that never enters
    const passiveStrategy = () => ({ action: 'hold' as const })

    const result = runBacktest('SOLUSDT', '15m', bars, passiveStrategy)

    expect(result.totalTrades).toBe(0)
    expect(result.winRatePct).toBe(0)
    expect(result.finalEquity).toBe(10000)
    expect(result.totalReturnPct).toBe(0)
  })
})
