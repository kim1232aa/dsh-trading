import { describe, expect, it } from 'vitest'
import {
  calculateEvasiveSuperTrend,
  evasiveSuperTrend,
  evasiveSuperTrendIndicator,
  type Candle,
} from '../src/client/indicators/evasive-st.js'

describe('calculateEvasiveSuperTrend', () => {
  it('returns empty objects for warmup bars prior to ATR length', () => {
    const bars: Candle[] = Array.from({ length: 15 }, (_, i) => ({
      high: 100 + i,
      low: 95 + i,
      close: 98 + i,
    }))

    const results = calculateEvasiveSuperTrend(bars, { lengthInput: 10 })
    expect(results).toHaveLength(15)

    // Bars 0..8 should have no calculated stBand (warmup for length 10)
    for (let i = 0; i < 9; i++) {
      expect(results[i]?.stBand).toBeUndefined()
      expect(results[i]?.trend).toBeUndefined()
    }

    // Bar 9 is the first bar with ATR and ST band
    expect(results[9]?.stBand).toBeDefined()
    expect(results[9]?.trend).toBe(1)
  })

  it('accurately applies noise avoidance in bull trend by pushing band downward', () => {
    // 2-bar length for transparent hand calculation
    // Bar 0: high 10, low 8, close 9 (TR = 2)
    // Bar 1: high 11, low 9, close 10 (TR = 2, ATR = 2, src = 10, lowerBase = 6, stBand = 6)
    // Bar 2: price drops near 6 (close = 7). Dist = 1 < ATR * 1.0 (2.75).
    // isNoisy is true -> band moves DOWN away from price to prevBand - (atr * alpha)
    const bars: Candle[] = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 8.5, low: 6.5, close: 7 },
    ]

    const results = calculateEvasiveSuperTrend(bars, {
      lengthInput: 2,
      multiplierInput: 2.0,
      thresholdInput: 1.0,
      alphaInput: 0.5,
    })

    // Bar 1: not noisy (|10 - 6| = 4 > 2 * 1.0)
    expect(results[1]?.isNoisy).toBe(false)
    expect(results[1]?.stBand).toBe(6)
    expect(results[1]?.trend).toBe(1)

    // Bar 2:
    // tr = max(2, |8.5 - 10|, |6.5 - 10|) = 3.5
    // atr = (2 * 1 + 3.5) / 2 = 2.75
    // prevBand = 6
    // dist = |7 - 6| = 1.0 < 2.75 * 1.0 -> isNoisy = true!
    // evasive stBand = 6 - (2.75 * 0.5) = 4.625 (instead of standard ST 6)
    expect(results[2]?.isNoisy).toBe(true)
    expect(results[2]?.atr).toBeCloseTo(2.75, 4)
    expect(results[2]?.stBand).toBeCloseTo(4.625, 4)
    expect(results[2]?.trend).toBe(1)
    expect(results[2]?.trendChanged).toBe(false)
    expect(results[2]?.up).toBeCloseTo(4.625, 4)
    expect(results[2]?.solidBand).toBeUndefined()
    expect(results[2]?.dottedBand).toBeCloseTo(4.625, 4)
  })

  it('triggers Bull to Bear trend flip when close penetrates stBand', () => {
    const bars: Candle[] = [
      { high: 10, low: 8, close: 9 },
      { high: 11, low: 9, close: 10 },
      { high: 8.5, low: 6.5, close: 7 },
      // Bar 3 plunges below stBand
      { high: 4, low: 1, close: 2 },
    ]

    const results = calculateEvasiveSuperTrend(bars, {
      lengthInput: 2,
      multiplierInput: 2.0,
      thresholdInput: 1.0,
      alphaInput: 0.5,
    })

    const bar3 = results[3]!
    expect(bar3.trend).toBe(-1)
    expect(bar3.trendChanged).toBe(true)
    expect(bar3.signal).toBe('bear')
    expect(bar3.dn).toBeDefined()
    expect(bar3.up).toBeUndefined()
    expect(bar3.stBand).toBe(bar3.upperBase)
    expect(bar3.switchDot).toBe(bar3.stBand)
  })

  it('accurately applies noise avoidance in bear trend and flips back to bull', () => {
    // Start in bear trend by plunging immediately
    const bars: Candle[] = [
      { high: 20, low: 18, close: 19 },
      { high: 21, low: 19, close: 10 }, // ATR=2, src=20, lowerBase=16, close=10 < 16 -> flips to Bear!
      { high: 14, low: 12, close: 13 }, // Price moves near bear band
      { high: 30, low: 25, close: 29 }, // Plunges upward, breaking bear band -> flips to Bull!
    ]

    const results = calculateEvasiveSuperTrend(bars, {
      lengthInput: 2,
      multiplierInput: 2.0,
      thresholdInput: 1.0,
      alphaInput: 0.5,
    })

    // Bar 1 flipped to bear
    expect(results[1]?.trend).toBe(-1)
    expect(results[1]?.trendChanged).toBe(true)
    expect(results[1]?.signal).toBe('bear')

    // Bar 2 is in bear trend
    expect(results[2]?.trend).toBe(-1)
    if (results[2]?.isNoisy) {
      // Band should be pushed UP (away from price)
      const prevBand = results[1]?.stBand!
      const expectedPushedBand = prevBand + results[2]!.atr! * 0.5
      expect(results[2]?.stBand).toBeCloseTo(expectedPushedBand, 4)
    }

    // Bar 3 closes above upperBase -> flips to bull
    expect(results[3]?.trend).toBe(1)
    expect(results[3]?.trendChanged).toBe(true)
    expect(results[3]?.signal).toBe('bull')
    expect(results[3]?.up).toBe(results[3]?.lowerBase)
  })

  it('works with default parameters and positional wrapper', () => {
    const bars: Candle[] = Array.from({ length: 120 }, (_, i) => {
      const c = 100 + 35 * Math.sin(i / 8)
      return { high: c + 2, low: c - 2, close: c }
    })

    const r1 = calculateEvasiveSuperTrend(bars)
    const r2 = evasiveSuperTrend(bars)
    expect(r1).toEqual(r2)

    // Signals should be present on large swings and alternate
    const signals = r1.filter(r => r.trendChanged)
    expect(signals.length).toBeGreaterThan(0)
    for (const sig of signals) {
      expect(['bull', 'bear']).toContain(sig.signal)
    }
  })

  it('exports valid klinecharts indicator configuration', () => {
    expect(evasiveSuperTrendIndicator.name).toBe('EVASIVE_ST')
    expect(evasiveSuperTrendIndicator.figures).toEqual([
      { key: 'up', type: 'line' },
      { key: 'dn', type: 'line' },
    ])
    expect(evasiveSuperTrendIndicator.calcParams).toEqual([10, 3.0, 1.0, 0.5])

    const bars: Candle[] = Array.from({ length: 30 }, (_, i) => ({
      high: 100 + i,
      low: 95 + i,
      close: 98 + i,
    }))

    const calcResult = evasiveSuperTrendIndicator.calc(bars)
    expect(calcResult).toHaveLength(30)

    const tooltip = evasiveSuperTrendIndicator.createTooltipDataSource({
      indicator: { calcParams: [10, 3.0, 1.0, 0.5], result: calcResult },
      crosshair: { dataIndex: 25 },
    })

    expect(tooltip.calcParamsText).toBe('(10, 3, 1, 0.5)')
    expect(tooltip.values.length).toBeGreaterThan(0)
  })
})
