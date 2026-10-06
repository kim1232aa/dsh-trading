/**
 * Evasive SuperTrend [LuxAlgo]
 * Faithful TypeScript translation of the TradingView Pine Script v6 indicator.
 *
 * Traditional SuperTrend is strictly monotonic (only moves closer to price).
 * Evasive SuperTrend detects when price enters the noise zone near the band
 * and pushes the band away by (alpha * ATR) to avoid premature whipsaws.
 */

export interface Candle {
  high: number
  low: number
  close: number
  open?: number
  timestamp?: number
  volume?: number
}

export interface EvasiveSuperTrendOptions {
  /** ATR lookback period (Pine: lengthInput = 10) */
  lengthInput?: number | undefined
  /** Multiplier for ATR band distance (Pine: multiplierInput = 3.0) */
  multiplierInput?: number | undefined
  /** Noise threshold in xATR (Pine: thresholdInput = 1.0) */
  thresholdInput?: number | undefined
  /** Expansion distance in xATR when noisy (Pine: alphaInput = 0.5) */
  alphaInput?: number | undefined
  /** Short aliases */
  length?: number | undefined
  multiplier?: number | undefined
  threshold?: number | undefined
  alpha?: number | undefined
}

export interface EvasiveSuperTrendResult {
  /** Current SuperTrend band value */
  stBand?: number | undefined
  /** Current trend direction: 1 for Bull, -1 for Bear */
  trend?: 1 | -1 | undefined
  /** Whether the price was in the noise zone before the band update */
  isNoisy?: boolean | undefined
  /** Whether the trend direction flipped on this bar */
  trendChanged?: boolean | undefined
  /** Signal emitted on trend change: 'bull' | 'bear' | null */
  signal?: 'bull' | 'bear' | null | undefined
  /** Bullish band value (active when trend == 1, for line rendering) */
  up?: number | undefined
  /** Bearish band value (active when trend == -1, for line rendering) */
  dn?: number | undefined
  /** Switch dot value on trend change bar */
  switchDot?: number | undefined
  /** Band value when NOT in noise mode (Pine solid line) */
  solidBand?: number | undefined
  /** Band value when in noise mode (Pine dotted line) */
  dottedBand?: number | undefined
  /** ATR value on this bar */
  atr?: number | undefined
  /** Upper base level (hl2 + multiplier * atr) */
  upperBase?: number | undefined
  /** Lower base level (hl2 - multiplier * atr) */
  lowerBase?: number | undefined
}

export const EVASIVE_ST_DEFAULTS = {
  lengthInput: 10,
  multiplierInput: 3.0,
  thresholdInput: 1.0,
  alphaInput: 0.5,
  bullColor: '#089981',
  bearColor: '#f23645',
} as const

/**
 * Pure calculation function for Evasive SuperTrend.
 */
export function calculateEvasiveSuperTrend(
  candles: readonly Candle[],
  options?: EvasiveSuperTrendOptions,
): EvasiveSuperTrendResult[] {
  const n = candles.length
  // ponytail: pre-allocated typed result array; upgrade to streaming generator if memory is constrained on >100k bars
  const out: EvasiveSuperTrendResult[] = new Array(n)

  const length = options?.lengthInput ?? options?.length ?? EVASIVE_ST_DEFAULTS.lengthInput
  const multiplier = options?.multiplierInput ?? options?.multiplier ?? EVASIVE_ST_DEFAULTS.multiplierInput
  const threshold = options?.thresholdInput ?? options?.threshold ?? EVASIVE_ST_DEFAULTS.thresholdInput
  const alpha = options?.alphaInput ?? options?.alpha ?? EVASIVE_ST_DEFAULTS.alphaInput

  if (length < 1 || n === 0) {
    for (let i = 0; i < n; i++) out[i] = {}
    return out
  }

  let atr: number | undefined
  let trSum = 0
  let stBand: number | undefined
  let trend: 1 | -1 = 1 // Pine: var int trend = 1

  for (let i = 0; i < n; i++) {
    const { high, low, close } = candles[i]!
    const prevClose = i > 0 ? candles[i - 1]!.close : close

    // ta.tr(true)
    const tr = i === 0
      ? high - low
      : Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose))

    // ta.atr(lengthInput) -> RMA / Wilder's MA
    if (atr !== undefined) {
      atr = (atr * (length - 1) + tr) / length
    } else {
      trSum += tr
      if (i === length - 1) {
        atr = trSum / length
      }
    }

    if (atr === undefined) {
      out[i] = {}
      continue
    }

    const src = (high + low) / 2 // hl2
    const upperBase = src + multiplier * atr
    const lowerBase = src - multiplier * atr

    // Pine: float prevBand = nz(stBand[1], trend == 1 ? lowerBase : upperBase)
    const prevTrend = trend
    const prevBand = stBand !== undefined ? stBand : (prevTrend === 1 ? lowerBase : upperBase)

    // Pine: bool isNoisy = math.abs(close - prevBand) < (atr * thresholdInput)
    const isNoisy = Math.abs(close - prevBand) < (atr * threshold)

    if (prevTrend === 1) {
      // BULL TREND: If noisy, move band DOWN (away from price)
      if (isNoisy) {
        stBand = prevBand - (atr * alpha)
      } else {
        stBand = Math.max(lowerBase, prevBand)
      }

      // Check for Trend Flip
      if (close < stBand) {
        trend = -1
        stBand = upperBase
      } else {
        trend = 1
      }
    } else {
      // BEAR TREND: If noisy, move band UP (away from price)
      if (isNoisy) {
        stBand = prevBand + (atr * alpha)
      } else {
        stBand = Math.min(upperBase, prevBand)
      }

      // Check for Trend Flip
      if (close > stBand) {
        trend = 1
        stBand = lowerBase
      } else {
        trend = -1
      }
    }

    const trendChanged = trend !== prevTrend
    const signal: 'bull' | 'bear' | null = trendChanged
      ? (trend === 1 ? 'bull' : 'bear')
      : null

    out[i] = {
      stBand,
      trend,
      isNoisy,
      trendChanged,
      signal,
      up: trend === 1 ? stBand : undefined,
      dn: trend === -1 ? stBand : undefined,
      switchDot: trendChanged ? stBand : undefined,
      solidBand: isNoisy ? undefined : stBand,
      dottedBand: isNoisy ? stBand : undefined,
      atr,
      upperBase,
      lowerBase,
    }
  }

  return out
}

/**
 * Drop-in wrapper with positional arguments.
 */
export function evasiveSuperTrend(
  bars: readonly Candle[],
  lengthATR = EVASIVE_ST_DEFAULTS.lengthInput,
  multiplier = EVASIVE_ST_DEFAULTS.multiplierInput,
  threshold = EVASIVE_ST_DEFAULTS.thresholdInput,
  alpha = EVASIVE_ST_DEFAULTS.alphaInput,
): EvasiveSuperTrendResult[] {
  return calculateEvasiveSuperTrend(bars, {
    lengthInput: lengthATR,
    multiplierInput: multiplier,
    thresholdInput: threshold,
    alphaInput: alpha,
  })
}

/**
 * Klinecharts indicator registration template for Evasive SuperTrend.
 */
export const evasiveSuperTrendIndicator = {
  name: 'EVASIVE_ST',
  shortName: '避险ST',
  series: 'price' as const,
  precision: 2,
  calcParams: [
    EVASIVE_ST_DEFAULTS.lengthInput,
    EVASIVE_ST_DEFAULTS.multiplierInput,
    EVASIVE_ST_DEFAULTS.thresholdInput,
    EVASIVE_ST_DEFAULTS.alphaInput,
  ],
  figures: [
    { key: 'up', type: 'line' },
    { key: 'dn', type: 'line' },
  ],
  styles: {
    lines: [
      { color: 'transparent', size: 0, style: 'solid', smooth: false, dashedValue: [2, 2] },
      { color: 'transparent', size: 0, style: 'solid', smooth: false, dashedValue: [2, 2] },
    ],
  },
  calc: (dataList: Candle[], indicator?: { calcParams?: number[] }) => {
    const params = indicator?.calcParams ?? []
    return calculateEvasiveSuperTrend(dataList, {
      lengthInput: params[0] ?? EVASIVE_ST_DEFAULTS.lengthInput,
      multiplierInput: params[1] ?? EVASIVE_ST_DEFAULTS.multiplierInput,
      thresholdInput: params[2] ?? EVASIVE_ST_DEFAULTS.thresholdInput,
      alphaInput: params[3] ?? EVASIVE_ST_DEFAULTS.alphaInput,
    })
  },
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { calcParams: number[]; result: EvasiveSuperTrendResult[] }
    crosshair: { dataIndex?: number }
  }) => {
    const row = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1]
    const v = row?.stBand ?? row?.up ?? row?.dn
    return {
      calcParamsText: `(${indicator.calcParams.join(', ')})`,
      values: v === undefined ? [] : [
        { title: '', value: { text: v.toFixed(2), color: row?.trend === 1 ? EVASIVE_ST_DEFAULTS.bullColor : EVASIVE_ST_DEFAULTS.bearColor } },
        row?.isNoisy
          ? { title: '', value: { text: '[虚线·避险]', color: '#ffa726' } }
          : { title: '', value: { text: '[实线·主趋势]', color: row?.trend === 1 ? EVASIVE_ST_DEFAULTS.bullColor : EVASIVE_ST_DEFAULTS.bearColor } },
        row?.trendChanged ? { title: '', value: { text: row.trend === 1 ? '▲ 转多' : '▼ 转空', color: row.trend === 1 ? EVASIVE_ST_DEFAULTS.bullColor : EVASIVE_ST_DEFAULTS.bearColor } } : null,
      ].filter((x): x is NonNullable<typeof x> => x !== null),
      icons: [],
    }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, kLineDataList }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: EvasiveSuperTrendResult[] }
    xAxis: { convertToPixel: (val: number) => number }
    yAxis: { convertToPixel: (val: number) => number }
    visibleRange: { from: number; to: number }
    kLineDataList: { high?: number; low?: number }[]
  }) => {
    const results = indicator.result
    if (!results || results.length === 0) return false
    const from = Math.max(0, visibleRange.from)
    const to = Math.min(results.length - 1, visibleRange.to)
    if (from >= to) return false

    ctx.save()

    // 1. Draw SuperTrend band segments with solid (stable) vs dotted (noise evasion) styling
    ctx.lineWidth = 2
    for (let i = from + 1; i <= to; i++) {
      const prev = results[i - 1]
      const curr = results[i]
      if (!prev || !curr) continue
      // Do not connect across trend flips
      if (prev.trend !== curr.trend) continue

      const val0 = prev.stBand ?? (prev.trend === 1 ? prev.up : prev.dn)
      const val1 = curr.stBand ?? (curr.trend === 1 ? curr.up : curr.dn)
      if (val0 === undefined || val1 === undefined) continue

      const x0 = xAxis.convertToPixel(i - 1)
      const x1 = xAxis.convertToPixel(i)
      const y0 = yAxis.convertToPixel(val0)
      const y1 = yAxis.convertToPixel(val1)

      ctx.beginPath()
      ctx.moveTo(x0, y0)
      ctx.lineTo(x1, y1)
      ctx.strokeStyle = curr.trend === 1 ? EVASIVE_ST_DEFAULTS.bullColor : EVASIVE_ST_DEFAULTS.bearColor

      // In Pine Script LuxAlgo Evasive SuperTrend:
      // When in noise mode (isNoisy = true), band is rendered as dotted/dashed line.
      // When normal (isNoisy = false), band is rendered as solid line.
      if (curr.isNoisy) {
        ctx.setLineDash([4, 3])
      } else {
        ctx.setLineDash([])
      }
      ctx.stroke()
    }

    // 2. Draw BULL and BEAR rounded badges on trendChanged bars (matching TradingView)
    for (let i = from; i <= to; i++) {
      const r = results[i]
      if (!r || !r.trendChanged) continue
      const x = xAxis.convertToPixel(i)
      const k = kLineDataList[i]
      const isBull = r.trend === 1
      const text = isBull ? '多' : '空'
      const bg = isBull ? EVASIVE_ST_DEFAULTS.bullColor : EVASIVE_ST_DEFAULTS.bearColor

      ctx.font = 'bold 9px sans-serif'
      const textWidth = ctx.measureText(text).width
      const pWidth = textWidth + 8
      const pHeight = 14
      const pRadius = 3

      // Center horizontally on candle
      const left = x - pWidth / 2
      // Place BULL below low, BEAR above high
      const top = isBull
        ? yAxis.convertToPixel(k?.low ?? r.stBand ?? 0) + 8
        : yAxis.convertToPixel(k?.high ?? r.stBand ?? 0) - pHeight - 8

      // Draw rounded rectangle badge
      ctx.beginPath()
      ctx.roundRect(left, top, pWidth, pHeight, pRadius)
      ctx.fillStyle = bg
      ctx.fill()

      // Draw text
      ctx.fillStyle = '#ffffff'
      ctx.textAlign = 'center'
      ctx.textBaseline = 'middle'
      ctx.fillText(text, x, top + pHeight / 2)
    }

    ctx.restore()
    return false
  },
}
