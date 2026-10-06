import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import {
  adx,
  atr,
  bollinger,
  ema,
  macd,
  mfi,
  stochastic,
} from '../src/candle-indicators.js'
import { rsi, sma, wma } from '../src/indicators.js'

describe('Indicator Extreme Market Stress Tests', () => {
  // Helper to generate N flat candles (like limit-up/down or halted stock)
  function makeFlatCandles(count: number, price = 100, volume = 0): Candle[] {
    const out: Candle[] = []
    const start = Date.now() - count * 60_000
    for (let i = 0; i < count; i++) {
      out.push({
        openTime: start + i * 60_000,
        open: price,
        high: price,
        low: price,
        close: price,
        volume,
      })
    }
    return out
  }

  // Helper to generate sub-dollar tiny price candles (e.g. PEPE/SHIB)
  function makeMicroPriceCandles(count: number): Candle[] {
    const out: Candle[] = []
    const start = Date.now() - count * 60_000
    let p = 0.00001234
    for (let i = 0; i < count; i++) {
      p += (i % 2 === 0 ? 0.0000001 : -0.00000008)
      out.push({
        openTime: start + i * 60_000,
        open: p,
        high: p * 1.005,
        low: p * 0.995,
        close: p,
        volume: 1_000_000,
      })
    }
    return out
  }

  it('handles completely flat candles without NaN or throwing (Halted / 一字板)', () => {
    const candles = makeFlatCandles(50, 100, 0)
    const closes = candles.map(c => c.close)

    // SMA, EMA, WMA on flat series
    const s = sma(closes, 14)
    expect(s.filter(v => v !== null).every(v => v === 100)).toBe(true)

    const e = ema(closes, 14)
    expect(e.filter(v => v !== null).every(v => v === 100)).toBe(true)

    const w = wma(closes, 14)
    expect(w.filter(v => v !== null).every(v => v === 100)).toBe(true)

    // RSI on flat series (no gains, no losses -> should be finite, typically 100 or 50)
    const r = rsi(closes, 14)
    const validRsi = r.filter(v => v !== null)
    expect(validRsi.length).toBeGreaterThan(0)
    expect(validRsi.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true)

    // Stochastic on flat range
    const stoch = stochastic(candles, 14, 3, 3)
    const validK = stoch.k.filter(v => v !== null)
    expect(validK.length).toBeGreaterThan(0)
    expect(validK.every(v => v === 50)).toBe(true)

    // Bollinger on flat range (standard deviation = 0 -> upper = lower = middle)
    const bb = bollinger(closes, 20, 2)
    const validMiddle = bb.middle.filter(v => v !== null)
    expect(validMiddle.every(v => v === 100)).toBe(true)
    const validUpper = bb.upper.filter(v => v !== null)
    expect(validUpper.every(v => v === 100)).toBe(true)

    // ATR on flat range (true range = 0)
    const a = atr(candles, 14)
    const validAtr = a.filter(v => v !== null)
    expect(validAtr.every(v => v === 0)).toBe(true)

    // MFI with zero volume
    const m = mfi(candles, 14)
    const validMfi = m.filter(v => v !== null)
    expect(validMfi.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true)
  })

  it('handles micro-price sub-dollar assets without underflow or NaN', () => {
    const candles = makeMicroPriceCandles(50)
    const closes = candles.map(c => c.close)

    const s = sma(closes, 14)
    expect(s.filter(v => v !== null).every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)).toBe(true)

    const r = rsi(closes, 14)
    expect(r.filter(v => v !== null).every(v => typeof v === 'number' && v >= 0 && v <= 100)).toBe(true)

    const m = macd(closes, 12, 26, 9)
    const validHist = m.histogram.filter(v => v !== null)
    expect(validHist.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true)

    const a = atr(candles, 14)
    expect(a.filter(v => v !== null).every(v => typeof v === 'number' && Number.isFinite(v) && v > 0)).toBe(true)
  })

  it('handles extreme price flash spikes and drops without crashing', () => {
    const count = 40
    const candles: Candle[] = []
    const start = Date.now() - count * 60_000
    for (let i = 0; i < count; i++) {
      let p = 100
      if (i === 20) p = 1000 // 10x spike
      if (i === 21) p = 1 // 99% crash
      candles.push({
        openTime: start + i * 60_000,
        open: p,
        high: p * 1.05,
        low: p * 0.95,
        close: p,
        volume: 50_000,
      })
    }

    const closes = candles.map(c => c.close)
    const bb = bollinger(closes, 20, 2)
    const validUpper = bb.upper.filter(v => v !== null)
    expect(validUpper.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true)

    const adxRes = adx(candles, 14)
    const validAdx = adxRes.adx.filter(v => v !== null)
    expect(validAdx.every(v => typeof v === 'number' && Number.isFinite(v))).toBe(true)
  })
})
