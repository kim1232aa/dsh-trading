/**
 * Nadaraya-Watson Trend [QuantAlgo]
 * Faithful TypeScript translation of the TradingView Pine Script v6 indicator.
 *
 * One-sided causal (non-repainting) Nadaraya-Watson kernel regression estimator:
 *   h = bandwidth * multiplier
 *   nwVal = sum(w * price) / sum(w)  over lag in [0, lookback]
 * Volatility envelope from kernel-weighted mean absolute residual:
 *   upperBand = nwVal + residual * bandMultiplier
 *   lowerBand = nwVal - residual * bandMultiplier
 */

export type KernelType =
  | 'Gaussian'
  | 'Epanechnikov'
  | 'Triangular'
  | 'Quartic'
  | 'Cosine'
  | 'Rational Quadratic'

export type PresetType = 'Default' | 'Fast Response' | 'Smooth Trend'

export type PriceSource = 'close' | 'hl2' | 'hlc3' | 'ohlc4' | 'high' | 'low' | 'open'

export interface CandleLike {
  open?: number | undefined
  high?: number | undefined
  low?: number | undefined
  close: number
}

export type CandleInput = number | CandleLike

export interface NadarayaWatsonOptions {
  preset?: PresetType | undefined
  kernelType?: KernelType | undefined
  lookback?: number | undefined
  bandwidth?: number | undefined
  multiplier?: number | undefined
  relativeWeight?: number | undefined // rq for Rational Quadratic (default 8.0)
  bandMultiplier?: number | undefined
  source?: PriceSource | undefined
}

export interface NadarayaWatsonBarResult {
  value: number // NW estimator value
  nw: number // alias for value
  slope: number // nw[t] - nw[t-1]
  trend: 'bullish' | 'bearish'
  isBullish: boolean
  residual: number // weighted mean absolute residual
  innerBand: number // center NW estimate
  upperBand: number // nw + residual * bandMult
  lowerBand: number // nw - residual * bandMult
  turnedBullish: boolean
  turnedBearish: boolean
  up?: number | undefined
  dn?: number | undefined
  upper: number
  lower: number
  price?: number | undefined
}

export const NW_PRESETS: Record<PresetType, { lookback: number; bandwidth: number; multiplier: number }> = {
  Default: { lookback: 50, bandwidth: 8, multiplier: 2.0 },
  'Fast Response': { lookback: 25, bandwidth: 5, multiplier: 1.5 },
  'Smooth Trend': { lookback: 100, bandwidth: 12, multiplier: 2.5 },
}

export function gaussianKernel(dist: number, h: number): number {
  if (h <= 0) return 0
  return Math.exp(-(dist * dist) / (2 * h * h))
}

export function rationalQuadraticKernel(dist: number, h: number, rq = 8.0): number {
  if (h <= 0 || rq <= 0) return 0
  return Math.pow(1 + (dist * dist) / (2 * rq * h * h), -rq)
}

export function epanechnikovKernel(dist: number, h: number): number {
  if (h <= 0) return 0
  const u = dist / h
  return Math.abs(u) <= 1 ? 0.75 * (1 - u * u) : 0
}

export function triangularKernel(dist: number, h: number): number {
  if (h <= 0) return 0
  const u = dist / h
  return Math.abs(u) <= 1 ? 1 - Math.abs(u) : 0
}

export function quarticKernel(dist: number, h: number): number {
  if (h <= 0) return 0
  const u = dist / h
  return Math.abs(u) <= 1 ? (15 / 16) * Math.pow(1 - u * u, 2) : 0
}

export function cosineKernel(dist: number, h: number): number {
  if (h <= 0) return 0
  const u = dist / h
  return Math.abs(u) <= 1 ? (Math.PI / 4) * Math.cos((Math.PI * u) / 2) : 0
}

export function kernelWeight(
  dist: number,
  h: number,
  ktype: KernelType,
  rq = 8.0,
): number {
  switch (ktype) {
    case 'Gaussian':
      return gaussianKernel(dist, h)
    case 'Rational Quadratic':
      return rationalQuadraticKernel(dist, h, rq)
    case 'Epanechnikov':
      return epanechnikovKernel(dist, h)
    case 'Triangular':
      return triangularKernel(dist, h)
    case 'Quartic':
      return quarticKernel(dist, h)
    case 'Cosine':
      return cosineKernel(dist, h)
    default:
      return gaussianKernel(dist, h)
  }
}

export function extractPrice(bar: CandleInput, source: PriceSource = 'close'): number {
  if (typeof bar === 'number') return bar
  switch (source) {
    case 'open':
      return bar.open ?? bar.close
    case 'high':
      return bar.high ?? bar.close
    case 'low':
      return bar.low ?? bar.close
    case 'hl2': {
      const h = bar.high ?? bar.close
      const l = bar.low ?? bar.close
      return (h + l) / 2
    }
    case 'hlc3': {
      const h = bar.high ?? bar.close
      const l = bar.low ?? bar.close
      return (h + l + bar.close) / 3
    }
    case 'ohlc4': {
      const o = bar.open ?? bar.close
      const h = bar.high ?? bar.close
      const l = bar.low ?? bar.close
      return (o + h + l + bar.close) / 4
    }
    case 'close':
    default:
      return bar.close
  }
}

/**
 * Pure calculation of Nadaraya-Watson Trend indicator.
 * ponytail: O(N * lookback) direct lag convolution; upgrade to FFT or running ring buffer when lookback > 500.
 */
export function calculateNadarayaWatson(
  candles: readonly CandleInput[],
  options: NadarayaWatsonOptions = {},
): NadarayaWatsonBarResult[] {
  const n = candles.length
  if (n === 0) return []

  const preset = options.preset
  const defaultLookback = preset ? NW_PRESETS[preset].lookback : 50
  const defaultBandwidth = preset ? NW_PRESETS[preset].bandwidth : 8
  const defaultMultiplier = preset ? NW_PRESETS[preset].multiplier : 2.0

  const lookback = Math.max(1, options.lookback ?? defaultLookback)
  const bandwidth = Math.max(0.1, options.bandwidth ?? defaultBandwidth)
  const multiplier = Math.max(0.01, options.multiplier ?? defaultMultiplier)
  const kernelType: KernelType = options.kernelType ?? 'Gaussian'
  const relativeWeight = Math.max(0.1, options.relativeWeight ?? 8.0)
  const bandMultiplier = Math.max(0, options.bandMultiplier ?? 1.5)
  const source: PriceSource = options.source ?? 'close'

  const h = bandwidth * multiplier

  // Precompute kernel weights for lags 0..lookback
  const weights = new Float64Array(lookback + 1)
  for (let i = 0; i <= lookback; i++) {
    weights[i] = kernelWeight(i, h, kernelType, relativeWeight)
  }

  // Pre-extract price array for cache locality
  const prices = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    prices[i] = extractPrice(candles[i]!, source)
  }

  const results: NadarayaWatsonBarResult[] = new Array(n)

  for (let t = 0; t < n; t++) {
    const wLen = Math.min(t, lookback)

    let sumW = 0
    let sumP = 0
    for (let j = 0; j <= wLen; j++) {
      const w = weights[j]!
      sumW += w
      sumP += prices[t - j]! * w
    }
    const nwVal = sumW !== 0 ? sumP / sumW : prices[t]!

    let sumAbs = 0
    let sumResW = 0
    for (let j = 0; j <= wLen; j++) {
      const w = weights[j]!
      if (w > 0) {
        sumAbs += w * Math.abs(prices[t - j]! - nwVal)
        sumResW += w
      }
    }
    const residual = sumResW !== 0 ? sumAbs / sumResW : 0
    const upperBand = nwVal + residual * bandMultiplier
    const lowerBand = nwVal - residual * bandMultiplier

    const prevNw = t > 0 ? results[t - 1]?.value : undefined
    const prev2Nw = t > 1 ? results[t - 2]?.value : undefined

    const slope = prevNw !== undefined ? nwVal - prevNw : 0
    const isBullish = prevNw === undefined ? true : nwVal > prevNw
    const trend = isBullish ? ('bullish' as const) : ('bearish' as const)

    const turnedBullish = prevNw !== undefined && prev2Nw !== undefined && prevNw < prev2Nw && nwVal > prevNw
    const turnedBearish = prevNw !== undefined && prev2Nw !== undefined && prevNw > prev2Nw && nwVal < prevNw

    results[t] = {
      value: nwVal,
      nw: nwVal,
      slope,
      trend,
      isBullish,
      residual,
      innerBand: nwVal,
      upperBand,
      lowerBand,
      turnedBullish,
      turnedBearish,
      up: isBullish ? nwVal : undefined,
      dn: !isBullish ? nwVal : undefined,
      upper: upperBand,
      lower: lowerBand,
      price: prices[t],
    }
  }

  return results
}

/**
 * Backwards-compatible nadarayaWatsonTrend matching the signature in ChartCard.
 */
export function nadarayaWatsonTrend(
  bars: readonly CandleInput[],
  lookback = 50,
  bandwidth = 8,
  mult = 2.0,
  bandMult = 1.8,
): NadarayaWatsonBarResult[] {
  return calculateNadarayaWatson(bars, {
    lookback,
    bandwidth,
    multiplier: mult,
    bandMultiplier: bandMult,
  })
}

export const nadarayaWatsonFigures = [
  { key: 'up', title: '核回归: ', type: 'line' },
  { key: 'dn', title: '核回归: ', type: 'line' },
  { key: 'upper', title: '上轨: ', type: 'line' },
  { key: 'lower', title: '下轨: ', type: 'line' },
]

export const nadarayaWatsonStyles = {
  lines: [
    { color: '#00ffaa', size: 2, style: 'solid', smooth: false, dashedValue: [2, 2] },
    { color: '#f23645', size: 2, style: 'solid', smooth: false, dashedValue: [2, 2] },
    { color: '#50a0f0', size: 1, style: 'dashed', smooth: false, dashedValue: [2, 2] },
    { color: '#50a0f0', size: 1, style: 'dashed', smooth: false, dashedValue: [2, 2] },
  ],
}

export function createNadarayaWatsonTooltipDataSource({
  indicator,
  crosshair,
}: {
  indicator: { calcParams: number[]; result: NadarayaWatsonBarResult[] }
  crosshair: { dataIndex?: number | undefined }
}) {
  const i = crosshair.dataIndex
  const row = i !== undefined ? indicator.result?.[i] : undefined
  const v = row ? (row.up ?? row.dn ?? row.value)?.toFixed(2) : undefined
  const upColor = '#00ffaa'
  const dnColor = '#f23645'
  const bandColor = '#50a0f0'
  return {
    name: '核回归',
    calcParamsText: indicator.calcParams?.length ? `(${indicator.calcParams.join(', ')})` : '',
    values: v === undefined ? [] : [
      { title: '中轨: ', value: { text: v, color: row?.isBullish ? upColor : dnColor } },
      row?.upper !== undefined ? { title: '上轨: ', value: { text: row.upper.toFixed(2), color: bandColor } } : null,
      row?.lower !== undefined ? { title: '下轨: ', value: { text: row.lower.toFixed(2), color: bandColor } } : null,
    ].filter((x): x is NonNullable<typeof x> => x !== null),
    icons: [],
  }
}

/**
 * Klinecharts indicator registration definition for Nadaraya-Watson Trend.
 */
export const nadarayaWatsonIndicator = {
  name: 'NW_TREND',
  shortName: '核回归',
  series: 'price' as const,
  precision: 2,
  calcParams: [50, 8, 2.0, 8.0, 2.5],
  figures: nadarayaWatsonFigures,
  styles: nadarayaWatsonStyles,
  calc: (dataList: readonly CandleInput[], ind: { calcParams: number[] }) => {
    const params = ind.calcParams ?? []
    return calculateNadarayaWatson(dataList, {
      source: 'hlc3',
      kernelType: 'Rational Quadratic',
      lookback: params[0] ?? 50,
      bandwidth: params[1] ?? 8,
      multiplier: params[2] ?? 2.0,
      relativeWeight: params[3] ?? 8.0,
      bandMultiplier: params[4] ?? 2.5,
    })
  },
  createTooltipDataSource: createNadarayaWatsonTooltipDataSource,
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, bounding, kLineDataList }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: NadarayaWatsonBarResult[] }
    xAxis: { convertToPixel: (val: number) => number }
    yAxis: { convertToPixel: (val: number) => number }
    visibleRange: { from: number; to: number }
    bounding: { width: number; height: number }
    kLineDataList: { high?: number; low?: number }[]
  }) => {
    const results = indicator.result
    if (!results || results.length === 0) return false
    const from = Math.max(0, visibleRange.from)
    const to = Math.min(results.length - 1, visibleRange.to)
    if (from >= to) return false

    ctx.save()

    // 1. Subtle background wash matching trend (as in TradingView show_bgcolor)
    for (let i = from; i <= to; i++) {
      const r = results[i]
      if (!r) continue
      const x1 = Math.max(0, xAxis.convertToPixel(i - 0.5))
      const x2 = Math.min(bounding.width, xAxis.convertToPixel(i + 0.5))
      if (x2 > x1) {
        ctx.fillStyle = r.isBullish ? 'rgba(0, 255, 170, 0.035)' : 'rgba(242, 54, 69, 0.035)'
        ctx.fillRect(x1, 0, x2 - x1, bounding.height)
      }
    }

    // 2. 6-step gradient cloud fill between source price (hlc3) and the NW line
    for (let i = from; i < to; i++) {
      const rA = results[i]
      const rB = results[i + 1]
      if (!rA || !rB || rA.price === undefined || rB.price === undefined) continue
      const xA = xAxis.convertToPixel(i)
      const xB = xAxis.convertToPixel(i + 1)
      const yPriceA = yAxis.convertToPixel(rA.price)
      const yNwA = yAxis.convertToPixel(rA.value)
      const yPriceB = yAxis.convertToPixel(rB.price)
      const yNwB = yAxis.convertToPixel(rB.value)

      ctx.beginPath()
      ctx.moveTo(xA, yNwA)
      ctx.lineTo(xB, yNwB)
      ctx.lineTo(xB, yPriceB)
      ctx.lineTo(xA, yPriceA)
      ctx.closePath()

      const yTop = Math.min(yNwA, yPriceA, yNwB, yPriceB)
      const yBottom = Math.max(yNwA, yPriceA, yNwB, yPriceB)
      const grad = ctx.createLinearGradient(0, yTop, 0, yBottom)
      const c = rB.isBullish ? '0, 255, 170' : '242, 54, 69'
      grad.addColorStop(0, `rgba(${c}, 0.28)`)
      grad.addColorStop(1, `rgba(${c}, 0.03)`)
      ctx.fillStyle = grad
      ctx.fill()
    }

    // 3. Outer residual envelope cloud (between upper and lower bands)
    ctx.beginPath()
    let started = false
    for (let i = from; i <= to; i++) {
      const r = results[i]
      if (!r || r.upper === undefined) continue
      const x = xAxis.convertToPixel(i)
      const y = yAxis.convertToPixel(r.upper)
      if (!started) { ctx.moveTo(x, y); started = true }
      else { ctx.lineTo(x, y) }
    }
    if (started) {
      for (let i = to; i >= from; i--) {
        const r = results[i]
        if (!r || r.lower === undefined) continue
        const x = xAxis.convertToPixel(i)
        const y = yAxis.convertToPixel(r.lower)
        ctx.lineTo(x, y)
      }
      ctx.closePath()
      ctx.fillStyle = 'rgba(80, 160, 240, 0.08)'
      ctx.fill()
    }

    // 4. Reversal triangle markers (▲ and ▼ exactly like TradingView)
    for (let i = from; i <= to; i++) {
      const r = results[i]
      if (!r) continue
      const x = xAxis.convertToPixel(i)
      if (r.turnedBullish) {
        const k = kLineDataList[i]
        const yBase = yAxis.convertToPixel(k?.low ?? r.value) + 14
        ctx.beginPath()
        ctx.moveTo(x, yBase - 8)
        ctx.lineTo(x - 6, yBase + 3)
        ctx.lineTo(x + 6, yBase + 3)
        ctx.closePath()
        ctx.fillStyle = '#00ffaa'
        ctx.fill()
      } else if (r.turnedBearish) {
        const k = kLineDataList[i]
        const yBase = yAxis.convertToPixel(k?.high ?? r.value) - 14
        ctx.beginPath()
        ctx.moveTo(x, yBase + 8)
        ctx.lineTo(x - 6, yBase - 3)
        ctx.lineTo(x + 6, yBase - 3)
        ctx.closePath()
        ctx.fillStyle = '#f23645'
        ctx.fill()
      }
    }

    // 5. Dynamic K-line candle bar colouring based on NW trend and envelope penetration
    for (let i = from; i <= to; i++) {
      const r = results[i]
      const k = kLineDataList[i] as { open?: number; high?: number; low?: number; close?: number } | undefined
      if (!r || !k || k.open === undefined || k.close === undefined || k.high === undefined || k.low === undefined) continue

      const x = xAxis.convertToPixel(i)
      const yOpen = yAxis.convertToPixel(k.open)
      const yClose = yAxis.convertToPixel(k.close)
      const yHigh = yAxis.convertToPixel(k.high)
      const yLow = yAxis.convertToPixel(k.low)

      let barColor = r.isBullish ? '#00ffaa' : '#f23645'
      // Envelope extreme penetration: highlight overbought / oversold exhaustion
      if (k.high >= (r.upper ?? Infinity)) {
        barColor = '#ffb300' // Upper envelope overbought / exhaustion amber
      } else if (k.low <= (r.lower ?? -Infinity)) {
        barColor = '#e040fb' // Lower envelope oversold / exhaustion violet
      }

      // Compute adaptive candle body width based on current bar spacing
      const nextX = i < to ? xAxis.convertToPixel(i + 1) : x + 6
      const prevX = i > from ? xAxis.convertToPixel(i - 1) : x - 6
      const barSpacing = Math.abs(nextX - prevX) / 2
      const barWidth = Math.max(1, Math.min(12, barSpacing * 0.7))
      const halfW = barWidth / 2

      ctx.save()
      ctx.strokeStyle = barColor
      ctx.fillStyle = barColor
      ctx.lineWidth = 1

      // Draw wick
      ctx.beginPath()
      ctx.moveTo(x, yHigh)
      ctx.lineTo(x, yLow)
      ctx.stroke()

      // Draw candle body
      const topY = Math.min(yOpen, yClose)
      const height = Math.max(1.5, Math.abs(yClose - yOpen))
      ctx.fillRect(x - halfW, topY, barWidth, height)

      ctx.restore()
    }

    ctx.restore()
    return false
  },
}
