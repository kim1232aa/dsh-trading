import { describe, expect, it } from 'vitest'
import { enrichChartTimeframe } from '../src/client/ChartCard.js'
import { candlesToPayload } from '../src/client/market-client.js'
import type { ChartTimeframeData } from '../src/client/payload.js'

/** Chip figure keys used by TM_MACD / STOCH / ADX / MFI / BB in ChartCard. */
const CHIP_SERIES_KEYS = [
  'macd_hist', 'macd', 'macd_signal',
  'stoch_k', 'stoch_d',
  'adx', 'plus_di', 'minus_di',
  'mfi14',
  'bb_upper', 'bb_middle', 'bb_lower',
] as const

function synthCandles(n: number) {
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + Math.sin(i / 8) * 5 + i * 0.05
    return {
      time: new Date(Date.UTC(2024, 0, 1, 0, i)).toISOString(),
      open: base - 0.2,
      high: base + 1,
      low: base - 1,
      close: base,
      volume: 1000 + i,
    }
  })
}

describe('enrichChartTimeframe (live panel chips)', () => {
  it('fills indicators + series for candlesToPayload-style live frames', () => {
    const payload = candlesToPayload('binance', 'BTCUSDT', '15m', synthCandles(80))
    const raw = payload.timeframes[0]!
    expect(raw.indicators).toBeNull()
    expect(raw.series).toBeUndefined()

    const tf = enrichChartTimeframe(raw)
    expect(tf.indicators).not.toBeNull()
    expect(tf.indicators?.['macd']).toBeDefined()
    expect(tf.indicators?.['stochastic']).toBeDefined()
    expect(tf.indicators?.['adx14']).toBeDefined()
    expect(tf.indicators?.['mfi14']).toBeDefined()
    expect(tf.indicators?.['bollinger20']).toBeDefined()

    for (const key of CHIP_SERIES_KEYS) {
      const col = tf.series?.[key]
      expect(Array.isArray(col), key).toBe(true)
      expect(col!.length, key).toBe(tf.candles.length)
    }
  })

  it('keeps agent-provided series when already aligned', () => {
    const candles = synthCandles(10)
    const series = { rsi14: candles.map((_, i) => i) }
    const raw: ChartTimeframeData = {
      timeframe: '15m',
      candles,
      indicators: { macd: { state: 'bullish' } },
      series,
    }
    const tf = enrichChartTimeframe(raw)
    expect(tf.series).toBe(series)
    expect(tf.indicators).toBe(raw.indicators)
  })
})
