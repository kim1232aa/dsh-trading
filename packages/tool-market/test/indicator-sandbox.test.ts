import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { runCustomIndicator } from '../src/indicator-sandbox.js'

describe('Custom Indicator Sandbox', () => {
  const candles: Candle[] = [
    { openTime: 1000, open: 100, high: 105, low: 98, close: 102, volume: 1000 },
    { openTime: 2000, open: 102, high: 108, low: 101, close: 107, volume: 1500 },
    { openTime: 3000, open: 107, high: 110, low: 104, close: 105, volume: 1200 },
    { openTime: 4000, open: 105, high: 106, low: 99, close: 100, volume: 2000 },
    { openTime: 5000, open: 100, high: 103, low: 97, close: 98, volume: 1800 },
  ]

  it('evaluates simple custom indicator formula', () => {
    // Formula returning spread percentage
    const code = `
      function calculate(candles) {
        return candles.map(c => ((c.high - c.low) / c.close) * 100);
      }
    `
    const result = runCustomIndicator(code, candles, { name: 'spread_pct' })
    expect(result.name).toBe('spread_pct')
    expect(result.values).toHaveLength(5)
    expect(result.values[0]).toBeCloseTo(((105 - 98) / 102) * 100, 4)
    expect(result.executionTimeMs).toBeGreaterThanOrEqual(0)
  })

  it('exposes built-in helper functions like sma and rsi inside sandbox', () => {
    const code = `
      function calculate() {
        const ma3 = sma(3);
        return ma3.map((m, i) => m !== null ? closes[i] - m : null);
      }
    `
    const result = runCustomIndicator(code, candles, { name: 'price_minus_sma3' })
    expect(result.values).toHaveLength(5)
    expect(result.values[0]).toBeNull()
    expect(result.values[1]).toBeNull()
    // ma3 at index 2 = (102 + 107 + 105) / 3 = 104.6667
    // close at index 2 = 105 -> close - ma3 = 0.3333
    expect(result.values[2]).toBeCloseTo(105 - (102 + 107 + 105) / 3, 4)
  })

  it('enforces 100ms infinite loop timeout cutoff and throws guard error', () => {
    const infiniteLoopCode = `
      function calculate() {
        while (true) {}
      }
    `
    expect(() => {
      runCustomIndicator(infiniteLoopCode, candles, { timeoutMs: 50, name: 'stuck_loop' })
    }).toThrowError(/timed out/i)
  })

  it('isolates context and blocks access to dangerous host APIs', () => {
    const maliciousCode = `
      function calculate() {
        if (typeof process !== 'undefined') return [1];
        if (typeof require !== 'undefined') return [2];
        return [0];
      }
    `
    const res = runCustomIndicator(maliciousCode, candles)
    expect(res.values).toEqual([0])
  })

  it('sanitizes NaN and Infinity into null', () => {
    const nanCode = `
      function calculate(candles) {
        return [1, 0 / 0, Infinity, -Infinity, 5];
      }
    `
    const res = runCustomIndicator(nanCode, candles)
    expect(res.values).toEqual([1, null, null, null, 5])
  })
})
