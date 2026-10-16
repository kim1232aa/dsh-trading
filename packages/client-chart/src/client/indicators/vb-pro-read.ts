/**
 * Volatility Bands Pro-Read [Indicatr] — TypeScript port of the Pine v6 source
 * (pine/vb-pro-read.pine). Bar-by-bar, no look-ahead: every value at bar i uses
 * bars <= i only. Alerts (alertcondition) are not ported; the tooltip shows state.
 */
import { formatPrice } from '../precision.js'

export interface VbCandle { high: number; low: number; close: number; open?: number; timestamp?: number }

export interface VbParams {
  bandType: 0 | 1 | 2 // 0=Bollinger 1=Keltner 2=Donchian
  len: number
  bbMult: number
  kcMult: number
  walkN: number
  walkK: number
  outerPct: number
  adxLen: number
  adxThr: number
  showSqz: boolean
  showMR: boolean
}

export const VB_DEFAULTS = [0, 20, 2.0, 1.5, 5, 3, 0.8, 14, 20, 1, 1]
export const VB_COLORS = {
  up: '#1B5E40', upBright: '#2E9E6A', dn: '#C0412F', neutral: '#8A8A8A',
}

export interface VbRow {
  upper?: number | undefined
  lower?: number | undefined
  basis?: number | undefined
  pos?: number | undefined
  adx?: number | undefined
  state: 1 | -1 | 0
  walkUp: boolean
  walkDn: boolean
  sqz: boolean
  fireUp: boolean
  fireDn: boolean
  mrShort: boolean
  mrLong: boolean
  /** plotshape gating (showSqz applied) */
  showSqz: boolean
}

const intIn = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? Math.round(v) : d
const numIn = (v: unknown, d: number, lo: number, hi: number) =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : d

export function sanitizeVbParams(p: readonly unknown[] = []): VbParams {
  const D = VB_DEFAULTS
  return {
    bandType: intIn(p[0], 0, 0, 2) as 0 | 1 | 2,
    len: intIn(p[1], D[1]!, 2, 500),
    bbMult: numIn(p[2], D[2]!, 0.1, 20),
    kcMult: numIn(p[3], D[3]!, 0.1, 20),
    walkN: intIn(p[4], D[4]!, 2, 500),
    walkK: intIn(p[5], D[5]!, 1, 500),
    outerPct: numIn(p[6], D[6]!, 0.5, 1),
    adxLen: intIn(p[7], D[7]!, 2, 500),
    adxThr: numIn(p[8], D[8]!, 1, 100),
    showSqz: intIn(p[9], 1, 0, 1) === 1,
    showMR: intIn(p[10], 1, 0, 1) === 1,
  }
}

type S = (number | undefined)[]

export function sma(src: S, len: number): S {
  return src.map((_, i) => {
    if (i < len - 1) return undefined
    let s = 0
    for (let j = i - len + 1; j <= i; j++) { const v = src[j]; if (v === undefined) return undefined; s += v }
    return s / len
  })
}
/** Pine ta.stdev (biased / population). */
export function stdev(src: S, len: number): S {
  const m = sma(src, len)
  return src.map((_, i) => {
    const mu = m[i]
    if (mu === undefined) return undefined
    let s = 0
    for (let j = i - len + 1; j <= i; j++) s += (src[j]! - mu) ** 2
    return Math.sqrt(s / len)
  })
}
/** Pine-style recursive MA seeded with SMA of the first `len` non-na values. */
function seeded(src: S, len: number, alpha: number): S {
  const out: S = new Array(src.length).fill(undefined)
  let prev: number | undefined
  let buf: number[] = []
  for (let i = 0; i < src.length; i++) {
    const v = src[i]
    if (v === undefined) { out[i] = prev; continue }
    if (prev === undefined) {
      buf.push(v)
      if (buf.length === len) { prev = buf.reduce((a, b) => a + b, 0) / len; out[i] = prev; buf = [] }
      continue
    }
    prev = alpha * v + (1 - alpha) * prev
    out[i] = prev
  }
  return out
}
export const ema = (src: S, len: number) => seeded(src, len, 2 / (len + 1))
export const rma = (src: S, len: number) => seeded(src, len, 1 / len)

/** ta.tr(handle_na): bar 0 is high-low when true, na when false. */
export function trueRange(c: readonly VbCandle[], handleNa: boolean): S {
  return c.map((b, i) => {
    if (i === 0) return handleNa ? b.high - b.low : undefined
    const pc = c[i - 1]!.close
    return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc))
  })
}
export const atr = (c: readonly VbCandle[], len: number) => rma(trueRange(c, true), len)

/** ta.dmi(len, len) → ADX (Wilder). */
export function adx(c: readonly VbCandle[], len: number): S {
  const plusDM: S = [], minusDM: S = []
  for (let i = 0; i < c.length; i++) {
    if (i === 0) { plusDM.push(undefined); minusDM.push(undefined); continue }
    const up = c[i]!.high - c[i - 1]!.high
    const down = c[i - 1]!.low - c[i]!.low
    plusDM.push(up > down && up > 0 ? up : 0)
    minusDM.push(down > up && down > 0 ? down : 0)
  }
  const tr = rma(trueRange(c, false), len)
  const pR = rma(plusDM, len), mR = rma(minusDM, len)
  const dx: S = c.map((_, i) => {
    const t = tr[i], p = pR[i], m = mR[i]
    if (t === undefined || p === undefined || m === undefined || t === 0) return undefined
    const plus = 100 * p / t, minus = 100 * m / t
    const sum = plus + minus
    return Math.abs(plus - minus) / (sum === 0 ? 1 : sum)
  })
  return rma(dx, len).map(v => v === undefined ? undefined : 100 * v)
}

function highest(c: readonly VbCandle[], len: number, hi: boolean): S {
  return c.map((_, i) => {
    if (i < len - 1) return undefined
    let r = hi ? -Infinity : Infinity
    for (let j = i - len + 1; j <= i; j++) r = hi ? Math.max(r, c[j]!.high) : Math.min(r, c[j]!.low)
    return r
  })
}

export function calculateVbProRead(candles: readonly VbCandle[], params: readonly unknown[] = [], tick = 1e-10): VbRow[] {
  const p = sanitizeVbParams(params)
  const n = candles.length
  const close: S = candles.map(c => c.close)
  const basisSMA = sma(close, p.len), dev = stdev(close, p.len), emaB = ema(close, p.len)
  const atrV = atr(candles, p.len)
  const dcU = highest(candles, p.len, true), dcL = highest(candles, p.len, false)
  const adxV = adx(candles, p.adxLen)
  const add = (a?: number, b?: number, k = 1) => a === undefined || b === undefined ? undefined : a + k * b

  const rows: VbRow[] = []
  const upFlag: number[] = [], dnFlag: number[] = []
  for (let i = 0; i < n; i++) {
    const bbU = add(basisSMA[i], dev[i], p.bbMult), bbL = add(basisSMA[i], dev[i], -p.bbMult)
    const kcU = add(emaB[i], atrV[i], p.kcMult), kcL = add(emaB[i], atrV[i], -p.kcMult)
    let upper: number | undefined, lower: number | undefined, basis: number | undefined
    if (p.bandType === 0) { upper = bbU; lower = bbL; basis = basisSMA[i] }
    else if (p.bandType === 1) { upper = kcU; lower = kcL; basis = emaB[i] }
    else { upper = dcU[i]; lower = dcL[i]; basis = upper === undefined || lower === undefined ? undefined : (upper + lower) / 2 }
    const c = candles[i]!.close
    const pos = upper === undefined || lower === undefined ? undefined : (c - lower) / Math.max(upper - lower, tick)
    // na comparisons are false in Pine → 0 in the sums
    upFlag.push(pos !== undefined && pos >= p.outerPct ? 1 : 0)
    dnFlag.push(pos !== undefined && pos <= 1 - p.outerPct ? 1 : 0)
    let upCnt: number | undefined, dnCnt: number | undefined
    if (i >= p.walkN - 1) {
      upCnt = 0; dnCnt = 0
      for (let j = i - p.walkN + 1; j <= i; j++) { upCnt += upFlag[j]!; dnCnt += dnFlag[j]! }
    }
    const a = adxV[i]
    const trending = a !== undefined && a > p.adxThr
    const walkUp = trending && upCnt !== undefined && upCnt >= p.walkK
    const walkDn = trending && dnCnt !== undefined && dnCnt >= p.walkK
    const prev = rows[i - 1]
    const pc = i > 0 ? candles[i - 1]!.close : undefined
    const mrShort = p.showMR && !trending && pc !== undefined && prev?.upper !== undefined && upper !== undefined && pc > prev.upper && c < upper
    const mrLong = p.showMR && !trending && pc !== undefined && prev?.lower !== undefined && lower !== undefined && pc < prev.lower && c > lower
    const sqz = bbU !== undefined && kcU !== undefined && bbL !== undefined && kcL !== undefined && bbU < kcU && bbL > kcL
    const fired = (prev?.sqz ?? false) && !sqz
    const fireUp = fired && basis !== undefined && c > basis
    const fireDn = fired && basis !== undefined && c < basis
    rows.push({
      upper, lower, basis, pos, adx: a,
      state: walkUp ? 1 : walkDn ? -1 : 0,
      walkUp, walkDn, sqz, fireUp, fireDn, mrShort, mrLong, showSqz: p.showSqz,
    })
  }
  return rows
}

function tickFor(list: readonly VbCandle[]): number {
  const last = list[list.length - 1]?.close
  return last === undefined ? 1e-10 : Math.max(Math.abs(last) * 1e-10, 1e-12)
}

const rgba = (hex: string, alpha: number) => {
  const h = hex.replace('#', '')
  return `rgba(${parseInt(h.slice(0, 2), 16)}, ${parseInt(h.slice(2, 4), 16)}, ${parseInt(h.slice(4, 6), 16)}, ${alpha})`
}
const stateColor = (s: number) => s === 1 ? VB_COLORS.upBright : s === -1 ? VB_COLORS.dn : VB_COLORS.neutral
// Pine transparency 88/94 → alpha 0.12/0.06
const fillColor = (s: number) => s === 1 ? rgba(VB_COLORS.upBright, 0.12) : s === -1 ? rgba(VB_COLORS.dn, 0.12) : rgba(VB_COLORS.neutral, 0.06)

/** Consecutive same-state runs with defined bands (for batched fills/lines). */
export function vbRuns(rows: readonly VbRow[], from: number, to: number): { state: number; start: number; end: number }[] {
  const runs: { state: number; start: number; end: number }[] = []
  for (let i = from; i <= to; i++) {
    const r = rows[i]
    if (r?.upper === undefined || r.lower === undefined) continue
    const last = runs[runs.length - 1]
    if (last && last.state === r.state && last.end === i - 1) last.end = i
    else runs.push({ state: r.state, start: i, end: i })
  }
  return runs
}

export const vbProReadIndicator = {
  name: 'VB_PRO_READ',
  shortName: '波动带Pro',
  series: 'price' as const,
  precision: 2,
  calcParams: [...VB_DEFAULTS],
  figures: [],
  calc: (dataList: VbCandle[], indicator?: { calcParams?: number[] }) =>
    calculateVbProRead(dataList, indicator?.calcParams ?? [], tickFor(dataList)),
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { calcParams: number[]; result: VbRow[] }
    crosshair: { dataIndex?: number }
  }) => {
    const r = indicator.result[crosshair.dataIndex ?? indicator.result.length - 1]
    const name = ['布林', '肯特纳', '唐奇安'][sanitizeVbParams(indicator.calcParams).bandType]
    const v = (title: string, x: number | undefined, color: string) => ({ title, value: { text: x === undefined ? '--' : formatPrice(x), color } })
    const values = r === undefined || r.upper === undefined ? [] : [
      v('上轨: ', r.upper, stateColor(r.state)),
      v('中轨: ', r.basis, VB_COLORS.neutral),
      v('下轨: ', r.lower, stateColor(r.state)),
      { title: '', value: { text: r.state === 1 ? '走带上' : r.state === -1 ? '走带下' : '中性', color: stateColor(r.state) } },
      ...(r.sqz ? [{ title: '', value: { text: '挤压中', color: '#ffa726' } }] : []),
      ...(r.fireUp ? [{ title: '', value: { text: '▲挤压释放', color: VB_COLORS.upBright } }] : []),
      ...(r.fireDn ? [{ title: '', value: { text: '▼挤压释放', color: VB_COLORS.dn } }] : []),
      ...(r.mrLong ? [{ title: '', value: { text: '×均值回归多', color: VB_COLORS.upBright } }] : []),
      ...(r.mrShort ? [{ title: '', value: { text: '×均值回归空', color: VB_COLORS.dn } }] : []),
    ]
    return { name: `波动带Pro·${name}`, calcParamsText: `(${indicator.calcParams.join(', ')})`, values, icons: [] }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, bounding, kLineDataList }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: VbRow[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    visibleRange: { from: number; to: number }
    bounding: { height: number }
    kLineDataList: { high?: number; low?: number }[]
  }) => {
    const rows = indicator.result
    if (!rows || rows.length === 0) return false
    const from = Math.max(0, visibleRange.from - 1)
    const to = Math.min(rows.length - 1, visibleRange.to)
    if (from > to) return false
    const X = (i: number) => xAxis.convertToPixel(i), Y = (v: number) => yAxis.convertToPixel(v)
    ctx.save()
    // Fill + band lines: one path per same-state run; each run extends back one
    // bar so segments join (Pine colors a segment by the later bar's state).
    for (const run of vbRuns(rows, from, to)) {
      const s = run.start > from && rows[run.start - 1]?.upper !== undefined ? run.start - 1 : run.start
      if (run.end === s) continue
      ctx.beginPath()
      for (let i = s; i <= run.end; i++) i === s ? ctx.moveTo(X(i), Y(rows[i]!.upper!)) : ctx.lineTo(X(i), Y(rows[i]!.upper!))
      for (let i = run.end; i >= s; i--) ctx.lineTo(X(i), Y(rows[i]!.lower!))
      ctx.closePath()
      ctx.fillStyle = fillColor(run.state)
      ctx.fill()
      ctx.strokeStyle = stateColor(run.state)
      ctx.lineWidth = 1.2
      for (const k of ['upper', 'lower'] as const) {
        ctx.beginPath()
        for (let i = s; i <= run.end; i++) i === s ? ctx.moveTo(X(i), Y(rows[i]![k]!)) : ctx.lineTo(X(i), Y(rows[i]![k]!))
        ctx.stroke()
      }
    }
    // Basis
    ctx.beginPath()
    let pen = false
    for (let i = from; i <= to; i++) {
      const b = rows[i]?.basis
      if (b === undefined) { pen = false; continue }
      pen ? ctx.lineTo(X(i), Y(b)) : ctx.moveTo(X(i), Y(b)); pen = true
    }
    ctx.strokeStyle = rgba(VB_COLORS.neutral, 0.6)
    ctx.lineWidth = 1
    ctx.stroke()
    // Shapes
    for (let i = Math.max(0, visibleRange.from); i <= to; i++) {
      const r = rows[i]!, k = kLineDataList[i], x = X(i)
      if (r.showSqz && r.sqz) {
        ctx.beginPath(); ctx.arc(x, bounding.height - 6, 2.2, 0, Math.PI * 2)
        ctx.fillStyle = VB_COLORS.neutral; ctx.fill()
      }
      const yl = k?.low !== undefined ? Y(k.low) : undefined
      const yh = k?.high !== undefined ? Y(k.high) : undefined
      if (r.showSqz && r.fireUp && yl !== undefined) {
        ctx.beginPath(); ctx.moveTo(x, yl + 6); ctx.lineTo(x - 5, yl + 14); ctx.lineTo(x + 5, yl + 14); ctx.closePath()
        ctx.fillStyle = VB_COLORS.upBright; ctx.fill()
      }
      if (r.showSqz && r.fireDn && yh !== undefined) {
        ctx.beginPath(); ctx.moveTo(x, yh - 6); ctx.lineTo(x - 5, yh - 14); ctx.lineTo(x + 5, yh - 14); ctx.closePath()
        ctx.fillStyle = VB_COLORS.dn; ctx.fill()
      }
      const cross = (cy: number, color: string) => {
        ctx.beginPath(); ctx.moveTo(x - 3, cy - 3); ctx.lineTo(x + 3, cy + 3); ctx.moveTo(x + 3, cy - 3); ctx.lineTo(x - 3, cy + 3)
        ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke()
      }
      if (r.mrShort && yh !== undefined) cross(yh - (r.fireDn ? 20 : 8), rgba(VB_COLORS.dn, 0.8))
      if (r.mrLong && yl !== undefined) cross(yl + (r.fireUp ? 20 : 8), rgba(VB_COLORS.upBright, 0.8))
    }
    ctx.restore()
    return false
  },
}
