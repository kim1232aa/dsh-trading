/**
 * Nadaraya-Watson Trend [QuantAlgo] — 1:1 port of packages/client-chart/pine/nadaraya-watson.pine.
 *
 * calcParams map 1:1 to the Pine inputs (L31-49) in source order, followed by
 * one toggle per alertcondition (L159-163), see NW_DEFAULTS. Pine semantics kept:
 *   - preset overrides lookback/bandwidth/h_mult (L51-53);
 *   - src[i] is na for i > bar_index, so nw_trend is na until bar_index >= lookback (L90-95);
 *   - trend colour, reversal markers, residual bands, 6-step gradient fill,
 *     barcolor and bgcolor exactly as plotted (L116-153); nothing is drawn that Pine does not draw.
 */

import { formatPrice } from '../precision.js'
import { resolveDrawContext, type ChartDrawApi } from './draw-context.js'

export type KernelType = 'Gaussian' | 'Epanechnikov' | 'Triangular' | 'Quartic' | 'Cosine' | 'Rational Quadratic'
export type PresetType = 'Default' | 'Fast Response' | 'Smooth Trend'
/** input.source options offered by TradingView. */
export type PriceSource = 'close' | 'open' | 'high' | 'low' | 'hl2' | 'hlc3' | 'ohlc4' | 'hlcc4'

export const NW_PRESET_NAMES: readonly PresetType[] = ['Default', 'Fast Response', 'Smooth Trend']
export const NW_SOURCES: readonly PriceSource[] = ['close', 'open', 'high', 'low', 'hl2', 'hlc3', 'ohlc4', 'hlcc4']
export const NW_KERNELS: readonly KernelType[] = ['Gaussian', 'Epanechnikov', 'Triangular', 'Quartic', 'Cosine', 'Rational Quadratic']
export const NW_COLOR_PRESETS = ['Classic', 'Aqua', 'Cosmic', 'Cyber', 'Neon', 'Custom'] as const

/** Pine L51-53. */
export const NW_PRESETS: Record<PresetType, { lookback: number; bandwidth: number; multiplier: number } | null> = {
  Default: null,
  'Fast Response': { lookback: 25, bandwidth: 5, multiplier: 1.5 },
  'Smooth Trend': { lookback: 100, bandwidth: 12, multiplier: 2.5 },
}

/** Pine L55-61 ([bullish, bearish]); Custom = the two colour inputs. */
const COLOR_PAIRS: Record<typeof NW_COLOR_PRESETS[number], readonly [number, number] | null> = {
  Classic: [0x00ff00, 0xff0000],
  Aqua: [0x00d4ff, 0xff8c00],
  Cosmic: [0x49ffce, 0x9932cc],
  Cyber: [0x00cccc, 0xff6600],
  Neon: [0xffff00, 0xff00ff],
  Custom: null,
}

/** Pine alertconditions L159-163, in order. */
export const NW_ALERTS = [
  { key: 'turnedBullish', title: 'Bullish Kernel Reversal', cn: '看涨核反转', msg: 'Nadaraya-Watson Trend: BULLISH kernel reversal' },
  { key: 'turnedBearish', title: 'Bearish Kernel Reversal', cn: '看跌核反转', msg: 'Nadaraya-Watson Trend: BEARISH kernel reversal' },
  { key: 'trendChanged', title: 'Any Kernel Reversal', cn: '核路径方向改变', msg: 'Nadaraya-Watson Trend: Kernel path direction changed' },
  { key: 'bandCrossUp', title: 'Source Cross Above Upper Band', cn: '源上穿上残差带', msg: 'Nadaraya-Watson Trend: Source crossed above upper residual band' },
  { key: 'bandCrossDn', title: 'Source Cross Below Lower Band', cn: '源下穿下残差带', msg: 'Nadaraya-Watson Trend: Source crossed below lower residual band' },
] as const
export type NwAlertKey = typeof NW_ALERTS[number]['key']

/**
 * calcParams layout (Pine input order L31-49, then alert toggles):
 *  0 preset  1 source  2 kernel_type  3 lookback  4 bandwidth  5 h_mult  6 rel_weight
 *  7 show_bands  8 band_mult  9 show_fill  10 show_markers  11 color_preset
 *  12 bullish colour  13 bearish colour  14 show_candles  15 bar_trans  16 show_bgcolor  17 bg_trans
 *  18..22 alert toggles (NW_ALERTS order)
 */
export const NW_DEFAULTS: readonly number[] = [0, 0, 0, 50, 8, 2.0, 8.0, 0, 1.5, 1, 1, 5, 0x00ffaa, 0xff0000, 0, 0, 0, 90, 0, 0, 0, 0, 0]

/** Settings saved before the 1:1 port were [lookback, bandwidth, h_mult, band_mult]. */
export function migrateNwParams(old: readonly unknown[]): unknown[] {
  if (old.length !== 4) return [...old]
  const p: unknown[] = [...NW_DEFAULTS]
  p[3] = old[0]; p[4] = old[1]; p[5] = old[2]; p[8] = old[3]
  return p
}

export interface NwParams {
  preset: PresetType
  source: PriceSource
  kernel: KernelType
  lookback: number
  bandwidth: number
  hMult: number
  relWeight: number
  showBands: boolean
  bandMult: number
  showFill: boolean
  showMarkers: boolean
  colorPreset: typeof NW_COLOR_PRESETS[number]
  bull: number
  bear: number
  showCandles: boolean
  barTrans: number
  showBg: boolean
  bgTrans: number
  alertOn: boolean[]
}

const num = (v: unknown, d: number): number => typeof v === 'number' && Number.isFinite(v) ? v : d
const intIn = (v: unknown, d: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, Math.round(num(v, d))))
const flag = (v: unknown, d: number): boolean => intIn(v, d, 0, 1) === 1

/** Input constraints (minval/maxval) + preset override (L51-53) + colour preset (L55-61). */
export function sanitizeNwParams(p: readonly unknown[]): NwParams {
  const d = NW_DEFAULTS
  const preset = NW_PRESET_NAMES[intIn(p[0], d[0]!, 0, 2)]!
  const ov = NW_PRESETS[preset]
  const colorPreset = NW_COLOR_PRESETS[intIn(p[11], d[11]!, 0, 5)]!
  const bullIn = intIn(p[12], d[12]!, 0, 0xffffff)
  const bearIn = intIn(p[13], d[13]!, 0, 0xffffff)
  const pair = COLOR_PAIRS[colorPreset] ?? [bullIn, bearIn]
  return {
    preset,
    source: NW_SOURCES[intIn(p[1], d[1]!, 0, NW_SOURCES.length - 1)]!,
    kernel: NW_KERNELS[intIn(p[2], d[2]!, 0, NW_KERNELS.length - 1)]!,
    lookback: ov ? ov.lookback : intIn(p[3], d[3]!, 1, 500),
    bandwidth: ov ? ov.bandwidth : Math.max(1, Math.round(num(p[4], d[4]!))),
    hMult: ov ? ov.multiplier : Math.max(0.1, num(p[5], d[5]!)),
    relWeight: Math.max(0.1, num(p[6], d[6]!)),
    showBands: flag(p[7], d[7]!),
    bandMult: Math.max(0.1, num(p[8], d[8]!)),
    showFill: flag(p[9], d[9]!),
    showMarkers: flag(p[10], d[10]!),
    colorPreset,
    bull: pair[0],
    bear: pair[1],
    showCandles: flag(p[14], d[14]!),
    barTrans: intIn(p[15], d[15]!, 0, 100),
    showBg: flag(p[16], d[16]!),
    bgTrans: intIn(p[17], d[17]!, 0, 100),
    alertOn: NW_ALERTS.map((_, k) => flag(p[18 + k], 0)),
  }
}

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
  relativeWeight?: number | undefined
  bandMultiplier?: number | undefined
  source?: PriceSource | undefined
  showBands?: boolean | undefined
}

export interface NadarayaWatsonBarResult {
  /** src (L32) */
  price: number
  /** nw_trend (L95); undefined = Pine na */
  value?: number | undefined
  /** residual (L105) */
  residual?: number | undefined
  /** upper/lower (L106-107), always computed (alerts use them even when hidden) */
  upperBand?: number | undefined
  lowerBand?: number | undefined
  /** trend_color == bullish_color (L116) */
  isBullish: boolean
  turnedBullish: boolean
  turnedBearish: boolean
  trendChanged: boolean
  bandCrossUp: boolean
  bandCrossDn: boolean
  /** Plotted series (figure keys): NW Trend (L122), NW Upper/Lower Band only when show_bands (L145-146). */
  nw?: number | undefined
  upper?: number | undefined
  lower?: number | undefined
}

/** Consecutive bars sharing one trend colour, [start, end] inclusive. na bars break a run. */
export interface NwTrendRun { start: number; end: number; bullish: boolean }

export function nwTrendRuns(results: readonly (NadarayaWatsonBarResult | undefined)[], from: number, to: number): NwTrendRun[] {
  const runs: NwTrendRun[] = []
  let cur: NwTrendRun | null = null
  for (let i = from; i <= to; i++) {
    const r = results[i]
    if (!r || r.value === undefined) { cur = null; continue }
    const bullish = r.isBullish === true
    if (cur !== null && cur.bullish === bullish && cur.end === i - 1) { cur.end = i; continue }
    cur = { start: i, end: i, bullish }
    runs.push(cur)
  }
  return runs
}

/** Pine kernel_weight (L67-84). */
export function kernelWeight(dist: number, h: number, ktype: KernelType, rq = 8.0): number {
  let w = 0
  if (h > 0) {
    const u = dist / h
    if (ktype === 'Gaussian') w = Math.exp(-(dist * dist) / (2 * h * h))
    else if (ktype === 'Rational Quadratic') w = Math.pow(1 + (dist * dist) / (2 * rq * h * h), -rq)
    else if (Math.abs(u) <= 1) {
      if (ktype === 'Epanechnikov') w = 0.75 * (1 - u * u)
      else if (ktype === 'Triangular') w = 1 - Math.abs(u)
      else if (ktype === 'Quartic') w = (15 / 16) * Math.pow(1 - u * u, 2)
      else if (ktype === 'Cosine') w = (Math.PI / 4) * Math.cos((Math.PI * u) / 2)
    }
  }
  return w
}
export const gaussianKernel = (d: number, h: number): number => kernelWeight(d, h, 'Gaussian')
export const rationalQuadraticKernel = (d: number, h: number, rq = 8.0): number => kernelWeight(d, h, 'Rational Quadratic', rq)
export const epanechnikovKernel = (d: number, h: number): number => kernelWeight(d, h, 'Epanechnikov')
export const triangularKernel = (d: number, h: number): number => kernelWeight(d, h, 'Triangular')
export const quarticKernel = (d: number, h: number): number => kernelWeight(d, h, 'Quartic')
export const cosineKernel = (d: number, h: number): number => kernelWeight(d, h, 'Cosine')

export function extractPrice(bar: CandleInput, source: PriceSource = 'close'): number {
  if (typeof bar === 'number') return bar
  const c = bar.close
  const o = bar.open ?? c
  const h = bar.high ?? c
  const l = bar.low ?? c
  switch (source) {
    case 'open': return o
    case 'high': return h
    case 'low': return l
    case 'hl2': return (h + l) / 2
    case 'hlc3': return (h + l + c) / 3
    case 'ohlc4': return (o + h + l + c) / 4
    case 'hlcc4': return (h + l + c + c) / 4
    default: return c
  }
}

type CalcCfg = Pick<NwParams, 'source' | 'kernel' | 'lookback' | 'bandwidth' | 'hMult' | 'relWeight' | 'bandMult' | 'showBands'>

function calc(candles: readonly CandleInput[], P: CalcCfg): NadarayaWatsonBarResult[] {
  const n = candles.length
  const L = P.lookback
  const h = P.bandwidth * P.hMult // L86
  const weights = new Float64Array(L + 1)
  for (let i = 0; i <= L; i++) weights[i] = kernelWeight(i, h, P.kernel, P.relWeight)
  const src = new Float64Array(n)
  for (let t = 0; t < n; t++) src[t] = extractPrice(candles[t]!, P.source)

  const out: NadarayaWatsonBarResult[] = new Array(n)
  for (let t = 0; t < n; t++) {
    // L88-95: any src[i] with i > bar_index is na, which makes sum_p (and nw_trend) na.
    let nw: number | undefined
    if (t >= L) {
      let sumW = 0
      let sumP = 0
      for (let i = 0; i <= L; i++) { const w = weights[i]!; sumW += w; sumP += src[t - i]! * w }
      nw = sumW !== 0 ? sumP / sumW : undefined
    }
    // L97-107
    let residual: number | undefined
    if (nw !== undefined) {
      let sumAbs = 0
      let sumResW = 0
      for (let i = 0; i <= L; i++) {
        const w = weights[i]!
        if (w > 0) { sumAbs += w * Math.abs(src[t - i]! - nw); sumResW += w }
      }
      residual = sumResW !== 0 ? sumAbs / sumResW : undefined
    }
    const upper = nw !== undefined && residual !== undefined ? nw + residual * P.bandMult : undefined
    const lower = nw !== undefined && residual !== undefined ? nw - residual * P.bandMult : undefined

    // L109-114
    const p1 = t > 0 ? out[t - 1]!.value : undefined
    const p2 = t > 1 ? out[t - 2]!.value : undefined
    const turnedBullish = nw !== undefined && p1 !== undefined && p2 !== undefined && p1 < p2 && nw > p1
    const turnedBearish = nw !== undefined && p1 !== undefined && p2 !== undefined && p1 > p2 && nw < p1
    const prevUpper = t > 0 ? out[t - 1]!.upperBand : undefined
    const prevLower = t > 0 ? out[t - 1]!.lowerBand : undefined
    // ta.crossover(a, b): a > b and a[1] <= b[1]; na on either bar → false.
    const bandCrossUp = upper !== undefined && prevUpper !== undefined && src[t]! > upper && src[t - 1]! <= prevUpper
    const bandCrossDn = lower !== undefined && prevLower !== undefined && src[t]! < lower && src[t - 1]! >= prevLower
    // L116
    const isBullish = nw === undefined || p1 === undefined ? true : nw > p1

    out[t] = {
      price: src[t]!,
      value: nw,
      residual,
      upperBand: upper,
      lowerBand: lower,
      isBullish,
      turnedBullish,
      turnedBearish,
      trendChanged: turnedBullish || turnedBearish,
      bandCrossUp,
      bandCrossDn,
      nw,
      upper: P.showBands ? upper : undefined,
      lower: P.showBands ? lower : undefined,
    }
  }
  return out
}

/** Computation from calcParams (the klinecharts path). */
export function calculateNwFromParams(candles: readonly CandleInput[], params: readonly unknown[]): NadarayaWatsonBarResult[] {
  return calc(candles, sanitizeNwParams(params))
}

/**
 * Named-option API. Same rules as Pine: a non-Default preset overrides lookback/bandwidth/multiplier.
 * showBands defaults to true here so callers get the band series; the chart uses calcParams instead.
 */
export function calculateNadarayaWatson(candles: readonly CandleInput[], options: NadarayaWatsonOptions = {}): NadarayaWatsonBarResult[] {
  const p: unknown[] = [...NW_DEFAULTS]
  p[0] = NW_PRESET_NAMES.indexOf(options.preset ?? 'Default')
  p[1] = NW_SOURCES.indexOf(options.source ?? 'close')
  p[2] = NW_KERNELS.indexOf(options.kernelType ?? 'Gaussian')
  if (options.lookback !== undefined) p[3] = options.lookback
  if (options.bandwidth !== undefined) p[4] = options.bandwidth
  if (options.multiplier !== undefined) p[5] = options.multiplier
  if (options.relativeWeight !== undefined) p[6] = options.relativeWeight
  p[7] = options.showBands === false ? 0 : 1
  if (options.bandMultiplier !== undefined) p[8] = options.bandMultiplier
  return calc(candles, sanitizeNwParams(p))
}

/** Positional wrapper kept for existing callers. */
export function nadarayaWatsonTrend(bars: readonly CandleInput[], lookback = 50, bandwidth = 8, mult = 2.0, bandMult = 1.5): NadarayaWatsonBarResult[] {
  return calculateNadarayaWatson(bars, { lookback, bandwidth, multiplier: mult, bandMultiplier: bandMult })
}

/** Enabled alertconditions true on the latest closed bar (second to last; last is forming). */
export function nwAlertEvents(candles: readonly (CandleLike & { time: string })[], params: readonly unknown[]): { id: string; text: string }[] {
  if (candles.length < 2) return []
  const P = sanitizeNwParams(params)
  if (!P.alertOn.some(Boolean)) return []
  const i = candles.length - 2
  const row = calc(candles, P)[i]
  if (!row) return []
  const t = candles[i]!.time
  return NW_ALERTS.filter((a, k) => P.alertOn[k] && row[a.key]).map(a => ({ id: t + '|nw.' + a.key, text: a.cn + ' · ' + a.msg + ' (' + t + ')' }))
}

export const intToHex = (n: number): string => '#' + Math.max(0, Math.min(0xffffff, Math.round(n))).toString(16).padStart(6, '0')
/** Pine color.new(c, transp): alpha = (100 - transp) / 100. */
export const pineRgba = (c: number, transp: number): string =>
  'rgba(' + ((c >> 16) & 255) + ', ' + ((c >> 8) & 255) + ', ' + (c & 255) + ', ' + ((100 - transp) / 100) + ')'

/** Gradient fills L138-143: transparency per band from the path out to price. */
export const NW_FILL_TRANSP = [60, 68, 76, 84, 92, 96] as const

export const nadarayaWatsonFigures = [
  { key: 'nw', title: 'NW Trend: ', type: 'line' },
  { key: 'upper', title: 'NW Upper Band: ', type: 'line' },
  { key: 'lower', title: 'NW Lower Band: ', type: 'line' },
]

export function createNadarayaWatsonTooltipDataSource({ indicator, crosshair }: {
  indicator: { calcParams: number[]; result: NadarayaWatsonBarResult[] }
  crosshair: { dataIndex?: number | undefined }
}) {
  const P = sanitizeNwParams(indicator.calcParams ?? [])
  const i = crosshair.dataIndex
  const row = i !== undefined ? indicator.result?.[i] : undefined
  const trend = row?.isBullish === false ? P.bear : P.bull
  const legends: { title: string; value: { text: string; color: string } }[] = []
  if (row?.value !== undefined) {
    legends.push({ title: 'NW Trend: ', value: { text: formatPrice(row.value), color: intToHex(trend) } })
    if (P.showBands && row.upper !== undefined && row.lower !== undefined) {
      legends.push({ title: 'NW Upper Band: ', value: { text: formatPrice(row.upper), color: pineRgba(trend, 55) } })
      legends.push({ title: 'NW Lower Band: ', value: { text: formatPrice(row.lower), color: pineRgba(trend, 55) } })
    }
  }
  return {
    name: '核回归趋势',
    calcParamsText: '(' + [P.preset, P.source, P.kernel, P.lookback, P.bandwidth, P.hMult].join(', ') + ')',
    legends,
    features: [],
  }
}

interface DrawArgs {
  ctx: CanvasRenderingContext2D
  chart: ChartDrawApi
  indicator: { calcParams: number[]; result: NadarayaWatsonBarResult[] }
  xAxis: { convertToPixel: (val: number) => number }
  yAxis: { convertToPixel: (val: number) => number }
  bounding: { width: number; height: number }
}

/** Draws exactly the Pine visuals (L122-153). Returns true: the default figure renderer is replaced. */
export function drawNadarayaWatson({ ctx, chart, indicator, xAxis, yAxis, bounding }: DrawArgs): boolean {
  const { visibleRange, kLineDataList, barSpace } = resolveDrawContext(chart)
  const rows = indicator.result
  if (!rows || rows.length === 0) return true
  const P = sanitizeNwParams(indicator.calcParams ?? [])
  const from = Math.max(0, visibleRange.from)
  const to = Math.min(rows.length - 1, visibleRange.to)
  if (from > to) return true
  const X = (i: number): number => xAxis.convertToPixel(i)
  const Y = (v: number): number => yAxis.convertToPixel(v)
  const col = (bull: boolean): number => (bull ? P.bull : P.bear)
  const runs = nwTrendRuns(rows, Math.max(0, from - 1), to)
  /** Segments (i-1 → i) inside a run; each takes bar i's colour, like a Pine series-colour plot/fill. */
  const segs = (run: NwTrendRun): number[] => {
    const s: number[] = []
    for (let i = Math.max(run.start, from, 1); i <= run.end; i++) if (rows[i - 1]?.value !== undefined) s.push(i)
    return s
  }
  ctx.save()

  // bgcolor (L153): behind everything already on the canvas.
  if (P.showBg) {
    ctx.save()
    ctx.globalCompositeOperation = 'destination-over'
    for (const run of runs) {
      const a = Math.max(0, X(Math.max(run.start, from) - 0.5))
      const b = Math.min(bounding.width, X(run.end + 0.5))
      if (b <= a) continue
      ctx.fillStyle = pineRgba(col(run.bullish), P.bgTrans)
      ctx.fillRect(a, 0, b - a, bounding.height)
    }
    ctx.restore()
  }

  const band = (run: NwTrendRun, lo: (r: NadarayaWatsonBarResult) => number | undefined, hi: (r: NadarayaWatsonBarResult) => number | undefined, fill: string): void => {
    ctx.beginPath()
    let any = false
    for (const i of segs(run)) {
      const A = rows[i - 1]!; const B = rows[i]!
      const a0 = lo(A); const a1 = hi(A); const b0 = lo(B); const b1 = hi(B)
      if (a0 === undefined || a1 === undefined || b0 === undefined || b1 === undefined) continue
      ctx.moveTo(X(i - 1), Y(a0)); ctx.lineTo(X(i), Y(b0)); ctx.lineTo(X(i), Y(b1)); ctx.lineTo(X(i - 1), Y(a1)); ctx.closePath()
      any = true
    }
    if (any) { ctx.fillStyle = fill; ctx.fill() }
  }

  // Gradient fill (L125-143): nw → nw + step*k → src, step = (src - nw) / 6.
  if (P.showFill) {
    const lvl = (k: number) => (r: NadarayaWatsonBarResult): number | undefined =>
      r.value === undefined ? undefined : k === 6 ? r.price : r.value + ((r.price - r.value) / 6) * k
    for (const run of runs) {
      for (let k = 0; k < 6; k++) band(run, lvl(k), lvl(k + 1), pineRgba(col(run.bullish), NW_FILL_TRANSP[k]!))
    }
  }

  const line = (run: NwTrendRun, get: (r: NadarayaWatsonBarResult) => number | undefined, stroke: string, width: number): void => {
    ctx.beginPath()
    let any = false
    for (const i of segs(run)) {
      const a = get(rows[i - 1]!); const b = get(rows[i]!)
      if (a === undefined || b === undefined) continue
      ctx.moveTo(X(i - 1), Y(a)); ctx.lineTo(X(i), Y(b))
      any = true
    }
    if (any) { ctx.strokeStyle = stroke; ctx.lineWidth = width; ctx.stroke() }
  }

  // Residual bands (L145-147).
  if (P.showBands) {
    for (const run of runs) {
      band(run, r => r.lowerBand, r => r.upperBand, pineRgba(col(run.bullish), 90))
      line(run, r => r.upperBand, pineRgba(col(run.bullish), 55), 1)
      line(run, r => r.lowerBand, pineRgba(col(run.bullish), 55), 1)
    }
  }

  // NW Trend path (L122), linewidth 3.
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const run of runs) line(run, r => r.value, pineRgba(col(run.bullish), 0), 3)

  // barcolor (L152): candles repainted with the trend colour.
  const gap = barSpace?.gapBar ?? Math.max(1, Math.abs(X(from + 1) - X(from)) * 0.7)
  if (P.showCandles) {
    for (let i = from; i <= to; i++) {
      const r = rows[i]; const k = kLineDataList[i]
      if (!r || r.value === undefined || !k || k.open === undefined || k.close === undefined || k.high === undefined || k.low === undefined) continue
      const x = X(i)
      ctx.strokeStyle = ctx.fillStyle = pineRgba(col(r.isBullish), P.barTrans)
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, Y(k.high)); ctx.lineTo(x, Y(k.low)); ctx.stroke()
      const top = Math.min(Y(k.open), Y(k.close))
      ctx.fillRect(x - gap / 2, top, gap, Math.max(1, Math.abs(Y(k.close) - Y(k.open))))
    }
  }

  // plotshape triangles (L149-150), size.small, below/above the bar.
  if (P.showMarkers) {
    const s = 6
    for (let i = from; i <= to; i++) {
      const r = rows[i]; const k = kLineDataList[i]
      if (!r || !k) continue
      const x = X(i)
      if (r.turnedBullish && k.low !== undefined) {
        const y = Y(k.low) + 6
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y + s * 1.6); ctx.lineTo(x - s, y + s * 1.6); ctx.closePath()
        ctx.fillStyle = pineRgba(P.bull, 0); ctx.fill()
      }
      if (r.turnedBearish && k.high !== undefined) {
        const y = Y(k.high) - 6
        ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y - s * 1.6); ctx.lineTo(x - s, y - s * 1.6); ctx.closePath()
        ctx.fillStyle = pineRgba(P.bear, 0); ctx.fill()
      }
    }
  }

  ctx.restore()
  return true
}

/** klinecharts registration. */
export const nadarayaWatsonIndicator = {
  name: 'NW_TREND',
  shortName: 'NW Trend',
  series: 'price' as const,
  precision: 2,
  calcParams: [...NW_DEFAULTS],
  figures: nadarayaWatsonFigures,
  calc: (dataList: readonly CandleInput[], ind: { calcParams: number[] }) => calculateNwFromParams(dataList, ind.calcParams ?? []),
  createTooltipDataSource: createNadarayaWatsonTooltipDataSource,
  draw: drawNadarayaWatson,
}
