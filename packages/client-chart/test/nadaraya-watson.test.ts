import { describe, expect, it } from 'vitest'
import {
  calculateNadarayaWatson,
  cosineKernel,
  createNadarayaWatsonTooltipDataSource,
  epanechnikovKernel,
  gaussianKernel,
  kernelWeight,
  nadarayaWatsonFigures,
  nadarayaWatsonIndicator,
  nadarayaWatsonStyles,
  nadarayaWatsonTrend,
  quarticKernel,
  rationalQuadraticKernel,
  triangularKernel,
  type KernelType,
} from '../src/client/indicators/nadaraya-watson.js'

describe('Nadaraya-Watson Kernel Functions', () => {
  const h = 16 // bandwidth 8 * mult 2.0

  it('gaussianKernel decays smoothly with distance and has infinite support', () => {
    expect(gaussianKernel(0, h)).toBe(1)
    expect(gaussianKernel(h, h)).toBeCloseTo(Math.exp(-0.5), 6)
    expect(gaussianKernel(2 * h, h)).toBeCloseTo(Math.exp(-2), 6)
    expect(gaussianKernel(100, h)).toBeGreaterThan(0)
    expect(gaussianKernel(0, 0)).toBe(0)
  })

  it('rationalQuadraticKernel produces heavier tails than Gaussian', () => {
    const rq = 8.0
    expect(rationalQuadraticKernel(0, h, rq)).toBe(1)
    const gVal = gaussianKernel(2 * h, h)
    const rqVal = rationalQuadraticKernel(2 * h, h, rq)
    // Rational quadratic has fatter tails than Gaussian
    expect(rqVal).toBeGreaterThan(gVal)
  })

  it('compact kernels cut off strictly at u > 1 (dist > h)', () => {
    // At center (dist = 0)
    expect(epanechnikovKernel(0, h)).toBeCloseTo(0.75, 6)
    expect(triangularKernel(0, h)).toBe(1.0)
    expect(quarticKernel(0, h)).toBeCloseTo(15 / 16, 6)
    expect(cosineKernel(0, h)).toBeCloseTo(Math.PI / 4, 6)

    // Inside support (dist = h / 2)
    expect(epanechnikovKernel(h / 2, h)).toBeGreaterThan(0)
    expect(triangularKernel(h / 2, h)).toBeGreaterThan(0)
    expect(quarticKernel(h / 2, h)).toBeGreaterThan(0)
    expect(cosineKernel(h / 2, h)).toBeGreaterThan(0)

    // Outside support (dist > h)
    expect(epanechnikovKernel(h + 1, h)).toBe(0)
    expect(triangularKernel(h + 1, h)).toBe(0)
    expect(quarticKernel(h + 1, h)).toBe(0)
    expect(cosineKernel(h + 1, h)).toBe(0)
  })

  it('kernelWeight dispatcher handles all 6 kernel types', () => {
    const kernels: KernelType[] = [
      'Gaussian',
      'Epanechnikov',
      'Triangular',
      'Quartic',
      'Cosine',
      'Rational Quadratic',
    ]
    for (const k of kernels) {
      const w0 = kernelWeight(0, h, k)
      expect(w0).toBeGreaterThan(0)
      expect(Number.isNaN(w0)).toBe(false)
    }
  })
})

describe('calculateNadarayaWatson', () => {
  // Generate 80 synthetic bars with a clear sine wave trend
  const bars = Array.from({ length: 80 }, (_, i) => {
    const base = 100 + Math.sin(i / 8) * 20 + i * 0.5
    return {
      open: base - 0.5,
      high: base + 2,
      low: base - 2,
      close: base,
    }
  })

  it('handles empty input and single bar gracefully', () => {
    expect(calculateNadarayaWatson([])).toEqual([])

    const single = calculateNadarayaWatson([{ close: 123.45 }])
    expect(single.length).toBe(1)
    expect(single[0]!.value).toBeCloseTo(123.45, 2)
    expect(single[0]!.innerBand).toBeCloseTo(123.45, 2)
    expect(single[0]!.upperBand).toBeCloseTo(123.45, 2)
    expect(single[0]!.lowerBand).toBeCloseTo(123.45, 2)
    expect(single[0]!.residual).toBe(0)
    expect(single[0]!.slope).toBe(0)
    expect(single[0]!.isBullish).toBe(true)
    expect(single[0]!.trend).toBe('bullish')
    expect(single[0]!.up).toBeCloseTo(123.45, 2)
    expect(single[0]!.dn).toBeUndefined()
  })

  it('computes smooth values and valid non-NaN bands for all 6 kernels', () => {
    const kernels: KernelType[] = [
      'Gaussian',
      'Epanechnikov',
      'Triangular',
      'Quartic',
      'Cosine',
      'Rational Quadratic',
    ]

    for (const kernelType of kernels) {
      const result = calculateNadarayaWatson(bars, {
        kernelType,
        lookback: 30,
        bandwidth: 6,
        multiplier: 2.0,
        bandMultiplier: 1.5,
      })

      expect(result.length).toBe(bars.length)

      for (let i = 0; i < result.length; i++) {
        const r = result[i]!
        expect(Number.isNaN(r.value)).toBe(false)
        expect(Number.isNaN(r.innerBand)).toBe(false)
        expect(Number.isNaN(r.upperBand)).toBe(false)
        expect(Number.isNaN(r.lowerBand)).toBe(false)
        expect(Number.isNaN(r.residual)).toBe(false)
        expect(Number.isNaN(r.slope)).toBe(false)

        // Envelope geometry
        expect(r.innerBand).toBe(r.value)
        expect(r.upperBand).toBeGreaterThanOrEqual(r.innerBand)
        expect(r.lowerBand).toBeLessThanOrEqual(r.innerBand)
        expect(r.residual).toBeGreaterThanOrEqual(0)

        // Upper and lower aliases
        expect(r.upper).toBe(r.upperBand)
        expect(r.lower).toBe(r.lowerBand)

        // Slope and trend consistency
        if (i > 0) {
          const prev = result[i - 1]!
          expect(r.slope).toBeCloseTo(r.value - prev.value, 8)
          if (r.value > prev.value) {
            expect(r.trend).toBe('bullish')
            expect(r.isBullish).toBe(true)
            expect(r.up).toBe(r.value)
            expect(r.dn).toBeUndefined()
          } else {
            expect(r.trend).toBe('bearish')
            expect(r.isBullish).toBe(false)
            expect(r.dn).toBe(r.value)
            expect(r.up).toBeUndefined()
          }
        }
      }
    }
  })

  it('supports presets: Default, Fast Response, Smooth Trend', () => {
    const fast = calculateNadarayaWatson(bars, { preset: 'Fast Response' })
    const smooth = calculateNadarayaWatson(bars, { preset: 'Smooth Trend' })
    const def = calculateNadarayaWatson(bars, { preset: 'Default' })

    expect(fast.length).toBe(bars.length)
    expect(smooth.length).toBe(bars.length)
    expect(def.length).toBe(bars.length)

    // Fast response tracks local price closer than smooth trend
    const midIdx = Math.floor(bars.length / 2)
    expect(fast[midIdx]!.value).not.toBe(smooth[midIdx]!.value)
  })

  it('supports different price sources (close, hl2, hlc3, high, low)', () => {
    const resClose = calculateNadarayaWatson(bars, { source: 'close' })
    const resHl2 = calculateNadarayaWatson(bars, { source: 'hl2' })
    const resHigh = calculateNadarayaWatson(bars, { source: 'high' })

    expect(resClose[20]!.value).toBeDefined()
    expect(resHl2[20]!.value).toBeDefined()
    expect(resHigh[20]!.value).toBeGreaterThan(resClose[20]!.value)
  })

  it('detects bullish and bearish reversal turning points', () => {
    // Construct V-shape: falling then rising
    const vBars = [
      { close: 100 },
      { close: 90 },
      { close: 80 },
      { close: 70 },
      { close: 60 },
      { close: 70 },
      { close: 80 },
      { close: 90 },
      { close: 100 },
    ]
    const res = calculateNadarayaWatson(vBars, { lookback: 3, bandwidth: 2, multiplier: 1.0 })
    const turnedBullishBars = res.filter(r => r.turnedBullish)
    expect(turnedBullishBars.length).toBeGreaterThanOrEqual(1)
  })

  it('nadarayaWatsonTrend backwards-compatibility wrapper matches calculateNadarayaWatson', () => {
    const res1 = nadarayaWatsonTrend(bars, 30, 6, 2.0, 1.8)
    const res2 = calculateNadarayaWatson(bars, {
      lookback: 30,
      bandwidth: 6,
      multiplier: 2.0,
      bandMultiplier: 1.8,
    })
    expect(res1.length).toBe(res2.length)
    expect(res1[40]!.value).toBeCloseTo(res2[40]!.value, 8)
    expect(res1[40]!.upperBand).toBeCloseTo(res2[40]!.upperBand, 8)
  })
})

describe('Klinecharts Indicator Configuration', () => {
  it('exports figures and styles suitable for klinecharts registration', () => {
    expect(nadarayaWatsonFigures).toEqual([
      { key: 'up', title: '核回归: ', type: 'line' },
      { key: 'dn', title: '核回归: ', type: 'line' },
      { key: 'upper', title: '上轨: ', type: 'line' },
      { key: 'lower', title: '下轨: ', type: 'line' },
    ])
    expect(nadarayaWatsonStyles.lines.length).toBe(4)
    expect(nadarayaWatsonIndicator.name).toBe('NW_TREND')
    expect(nadarayaWatsonIndicator.series).toBe('price')
  })

  it('executes indicator calc function correctly', () => {
    const bars = [{ close: 100 }, { close: 102 }, { close: 104 }, { close: 103 }]
    const result = nadarayaWatsonIndicator.calc(bars, { calcParams: [50, 8, 2.0, 1.8] })
    expect(result.length).toBe(4)
    expect(result[3]!.value).toBeDefined()
  })

  it('creates tooltip data source with colored legend and parameters', () => {
    const bars = [{ close: 100 }, { close: 105 }]
    const result = nadarayaWatsonIndicator.calc(bars, { calcParams: [50, 8, 2.0, 1.8] })
    const tooltip = createNadarayaWatsonTooltipDataSource({
      indicator: { calcParams: [50, 8, 2.0, 1.8], result },
      crosshair: { dataIndex: 1 },
    })

    expect(tooltip.name).toBe('核回归')
    expect(tooltip.calcParamsText).toBe('(50, 8, 2, 1.8)')
    expect(tooltip.values.length).toBe(3) // 中轨, 上轨, 下轨
    expect(tooltip.values[0]!.title).toBe('中轨: ')
    expect(tooltip.values[1]!.title).toBe('上轨: ')
    expect(tooltip.values[2]!.title).toBe('下轨: ')
  })
})
