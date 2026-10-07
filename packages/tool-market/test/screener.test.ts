import { describe, expect, it } from 'vitest'
import type { Candle, MarketDataProvider } from '@dsh-trading/market-data'
import {
  checkBullishAlignment,
  checkBearishAlignment,
  checkOversoldReversal,
  checkOverboughtReversal,
  checkVolumeBreakout,
  checkVolumeBreakdown,
  screenUniverse,
} from '../src/screener.js'

describe('screener', () => {
  it('identifies bullish moving average alignment', () => {
    // Generate 220 bars with a strong upward trend so SMA20 > SMA50 > SMA200
    const bars: Candle[] = []
    let price = 50
    for (let i = 0; i < 220; i++) {
      price += 1.0
      bars.push({
        time: new Date(Date.now() + i * 86400000).toISOString(),
        open: price - 0.5,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 1000,
      })
    }

    const match = checkBullishAlignment(bars)
    expect(match).not.toBeNull()
    expect(match?.pattern).toBe('bullish_alignment')
    expect(match?.score).toBeGreaterThanOrEqual(50)
  })

  it('detects volume breakout over 20-bar resistance', () => {
    const bars: Candle[] = []
    let price = 100
    for (let i = 0; i < 30; i++) {
      bars.push({
        time: new Date(Date.now() + i * 86400000).toISOString(),
        open: price,
        high: price + 2,
        low: price - 2,
        close: price + 1,
        volume: 1000,
      })
    }
    // Add breakout candle
    bars.push({
      time: new Date(Date.now() + 31 * 86400000).toISOString(),
      open: 102,
      high: 110,
      low: 101,
      close: 109,
      volume: 3500, // 3.5x median
    })

    const match = checkVolumeBreakout(bars)
    expect(match).not.toBeNull()
    expect(match?.pattern).toBe('volume_breakout')
    expect(match?.metrics.volumeRatio).toBeGreaterThan(1.8)
  })

  it('detects oversold reversal candlestick', () => {
    const bars: Candle[] = []
    let price = 100
    // Generate 25 downward bars to push RSI below 30
    for (let i = 0; i < 25; i++) {
      price -= 2.5
      bars.push({
        time: new Date(Date.now() + i * 86400000).toISOString(),
        open: price + 2,
        high: price + 2.5,
        low: price - 0.5,
        close: price,
        volume: 1000,
      })
    }
    // Reversal green candle with lower shadow
    bars.push({
      time: new Date(Date.now() + 26 * 86400000).toISOString(),
      open: price - 0.5,
      high: price + 3,
      low: price - 3,
      close: price + 2,
      volume: 1500,
    })

    const match = checkOversoldReversal(bars)
    expect(match).not.toBeNull()
    expect(match?.pattern).toBe('oversold_reversal')
    expect(Number(match?.metrics.rsi14)).toBeLessThanOrEqual(32)
  })

  it('identifies bearish moving average alignment', () => {
    // Generate 220 bars with a strong downward trend so SMA20 < SMA50 < SMA200
    const bars: Candle[] = []
    let price = 300
    for (let i = 0; i < 220; i++) {
      price -= 1.0
      bars.push({
        time: new Date(Date.now() + i * 86400000).toISOString(),
        open: price + 0.5,
        high: price + 1,
        low: price - 1,
        close: price,
        volume: 1000,
      })
    }

    const match = checkBearishAlignment(bars)
    expect(match).not.toBeNull()
    expect(match?.pattern).toBe('bearish_alignment')
    expect(match?.score).toBeGreaterThanOrEqual(50)
  })

  it('detects volume breakdown below 20-bar support', () => {
    const bars: Candle[] = []
    let price = 100
    for (let i = 0; i < 30; i++) {
      bars.push({
        time: new Date(Date.now() + i * 86400000).toISOString(),
        open: price,
        high: price + 2,
        low: price - 2,
        close: price - 1,
        volume: 1000,
      })
    }
    // Add breakdown candle
    bars.push({
      time: new Date(Date.now() + 31 * 86400000).toISOString(),
      open: 98,
      high: 99,
      low: 88,
      close: 90,
      volume: 3500, // 3.5x median
    })

    const match = checkVolumeBreakdown(bars)
    expect(match).not.toBeNull()
    expect(match?.pattern).toBe('volume_breakdown')
    expect(match?.metrics.volumeRatio).toBeGreaterThan(1.8)
  })

  it('detects overbought reversal candlestick', () => {
    const bars: Candle[] = []
    let price = 50
    // Generate 25 upward bars to push RSI above 68
    for (let i = 0; i < 25; i++) {
      price += 2.5
      bars.push({
        time: new Date(Date.now() + i * 86400000).toISOString(),
        open: price - 2,
        high: price + 0.5,
        low: price - 2.5,
        close: price,
        volume: 1000,
      })
    }
    // Reversal red candle with upper shadow
    bars.push({
      time: new Date(Date.now() + 26 * 86400000).toISOString(),
      open: price + 2,
      high: price + 5,
      low: price - 1,
      close: price - 0.5,
      volume: 1500,
    })

    const match = checkOverboughtReversal(bars)
    expect(match).not.toBeNull()
    expect(match?.pattern).toBe('overbought_reversal')
    expect(Number(match?.metrics.rsi14)).toBeGreaterThanOrEqual(68)
  })

  it('screens universe with mock provider', async () => {
    const mockProvider: MarketDataProvider = {
      id: 'mock',
      description: 'Mock Provider',
      getOhlcv: async (query: any) => {
        const symbol = typeof query === 'string' ? query : query.symbol
        if (symbol === 'UP') {
          const bars: Candle[] = []
          let p = 50
          for (let i = 0; i < 220; i++) {
            p += 1.0
            bars.push({
              time: new Date(Date.now() + i * 86400000).toISOString(),
              open: p - 0.5,
              high: p + 1,
              low: p - 1,
              close: p,
              volume: 1000,
            })
          }
          return bars
        }
        return []
      },
    }

    const results = await screenUniverse(mockProvider, ['UP', 'EMPTY'], '1d')
    expect(results.length).toBeGreaterThanOrEqual(1)
    expect(results[0]?.symbol).toBe('UP')
  })
})
