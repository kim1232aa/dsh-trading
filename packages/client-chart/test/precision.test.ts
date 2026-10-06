import { describe, expect, it } from 'vitest'
import { detectPricePrecision, formatPrice } from '../src/client/precision.js'

describe('precision detection and formatting', () => {
  it('detects 2 decimals for BTC and ETH', () => {
    const btcCandles = [
      { open: 65432.1, high: 65500.25, low: 65400.0, close: 65488.5 },
    ]
    expect(detectPricePrecision(btcCandles)).toBe(2)

    const ethCandles = [
      { open: 2700.55, high: 2720.0, low: 2695.12, close: 2715.8 },
    ]
    expect(detectPricePrecision(ethCandles)).toBe(2)
  })

  it('detects 4-5 decimals for DOGE and XRP', () => {
    const dogeCandles = [
      { open: 0.09581, high: 0.09612, low: 0.0954, close: 0.09592 },
    ]
    expect(detectPricePrecision(dogeCandles)).toBe(5)

    const xrpCandles = [
      { open: 0.5432, high: 0.5488, low: 0.541, close: 0.5465 },
    ]
    expect(detectPricePrecision(xrpCandles)).toBe(4)
  })

  it('detects 7-8 decimals for ultra-low price tokens (SHIB, PEPE)', () => {
    const shibCandles = [
      { open: 0.00001852, high: 0.0000189, low: 0.0000182, close: 0.00001865 },
    ]
    expect(detectPricePrecision(shibCandles)).toBe(8)
  })

  it('formats prices dynamically according to magnitude', () => {
    expect(formatPrice(65432.1234)).toBe('65432.12')
    expect(formatPrice(2715.5)).toBe('2715.50')
    expect(formatPrice(0.5432)).toBe('0.5432')
    expect(formatPrice(0.09592)).toBe('0.09592')
    expect(formatPrice(0.00001852)).toBe('0.00001852')
    expect(formatPrice(0)).toBe('0.00')
    expect(formatPrice(null)).toBe('–')
    expect(formatPrice(undefined)).toBe('–')
  })

  it('respects explicit precision parameter when provided', () => {
    expect(formatPrice(0.09592, 3)).toBe('0.096')
    expect(formatPrice(2715.5, 4)).toBe('2715.5000')
  })
})
