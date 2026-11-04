/**
 * 合约/现货 CVD: cumulative taker delta (主动买 − 主动卖) of the perp and spot
 * books on the chart's own bars, plus four signals:
 *  - 现货顶背离 / 现货底背离: price prints a new lookback high (low) but spot CVD
 *    sits below (above) where it was at the prior high (low).
 *  - 合约CVD停涨 / 停跌: perp CVD rose (fell) meaningfully over the previous
 *    `stall` bars, then went flat or reversed over the last `stall` bars while
 *    price is still in the top (bottom) quarter of the lookback range.
 * Signals are evaluated on closed bars only (the newest bar is still forming).
 * Spot is drawn rescaled onto the perp axis (perp volume is ~100× spot); the
 * tooltip always shows raw cumulative values.
 */
import { resolveDrawContext } from './draw-context.js'
import type { ChartDrawApi } from './draw-context.js'

export interface CvdBarLike { time: string; perp: number | null; spot: number | null }
export type CvdSignalKind = '现货顶背离' | '现货底背离' | '合约CVD停涨' | '合约CVD停跌'
export interface CvdSignal { kind: CvdSignalKind; bearish: boolean }
export interface CvdRow {
  perp?: number
  spot?: number
  /** Spot CVD mapped onto the perp axis, for drawing only. */
  spotScaled?: number
  perpDelta?: number
  spotDelta?: number
  signals?: CvdSignal[]
}

type K = { timestamp?: number; high?: number; low?: number; close?: number }

const SHORT: Record<CvdSignalKind, string> = { 现货顶背离: '现货顶背', 现货底背离: '现货底背', 合约CVD停涨: '合约停涨', 合约CVD停跌: '合约停跌' }

export function calcCvdRows(list: readonly K[], bars: readonly CvdBarLike[] | undefined, lookback = 20, stall = 3): CvdRow[] {
  const byTime = new Map<number, CvdBarLike>()
  for (const b of bars ?? []) byTime.set(Date.parse(b.time), b)
  let perpCum: number | undefined
  let spotCum: number | undefined
  const rows: CvdRow[] = list.map(k => {
    const b = k.timestamp === undefined ? undefined : byTime.get(k.timestamp)
    const row: CvdRow = {}
    if (b?.perp != null && Number.isFinite(b.perp)) { perpCum = (perpCum ?? 0) + b.perp; row.perpDelta = b.perp }
    if (b?.spot != null && Number.isFinite(b.spot)) { spotCum = (spotCum ?? 0) + b.spot; row.spotDelta = b.spot }
    // A bar the feed skipped keeps the running total but draws no point.
    if (b !== undefined && perpCum !== undefined) row.perp = perpCum
    if (b !== undefined && spotCum !== undefined) row.spot = spotCum
    return row
  })

  let pMin = Infinity, pMax = -Infinity, sMin = Infinity, sMax = -Infinity
  for (const r of rows) {
    if (r.perp !== undefined) { pMin = Math.min(pMin, r.perp); pMax = Math.max(pMax, r.perp) }
    if (r.spot !== undefined) { sMin = Math.min(sMin, r.spot); sMax = Math.max(sMax, r.spot) }
  }
  const scale = pMax > pMin && sMax > sMin ? (pMax - pMin) / (sMax - sMin) : undefined
  for (const r of rows) {
    if (r.spot === undefined) continue
    r.spotScaled = scale === undefined ? r.spot : pMin + (r.spot - sMin) * scale
  }

  const n = rows.length
  const num = (v: number | undefined): v is number => typeof v === 'number' && Number.isFinite(v)
  const last: Partial<Record<CvdSignalKind, number>> = {}
  const cooldown = Math.max(2, stall * 2)
  const push = (i: number, kind: CvdSignalKind, bearish: boolean): void => {
    if (last[kind] !== undefined && i - last[kind]! < cooldown) return
    last[kind] = i
    ;(rows[i]!.signals ??= []).push({ kind, bearish })
  }
  // n - 1: the newest bar is still forming and cannot carry a signal.
  for (let i = Math.max(lookback, 2 * stall); i < n - 1; i++) {
    const k = list[i]!
    if (!num(k.high) || !num(k.low) || !num(k.close)) continue
    let hiIdx = -1, loIdx = -1
    for (let j = i - lookback; j < i; j++) {
      const h = list[j]?.high, l = list[j]?.low
      if (num(h) && (hiIdx < 0 || h > list[hiIdx]!.high!)) hiIdx = j
      if (num(l) && (loIdx < 0 || l < list[loIdx]!.low!)) loIdx = j
    }
    const s = rows[i]!.spot
    if (num(s) && hiIdx >= 0 && k.high > list[hiIdx]!.high! && num(rows[hiIdx]!.spot) && s < rows[hiIdx]!.spot!) push(i, '现货顶背离', true)
    if (num(s) && loIdx >= 0 && k.low < list[loIdx]!.low! && num(rows[loIdx]!.spot) && s > rows[loIdx]!.spot!) push(i, '现货底背离', false)

    const p0 = rows[i - 2 * stall]!.perp, p1 = rows[i - stall]!.perp, p2 = rows[i]!.perp
    if (!num(p0) || !num(p1) || !num(p2)) continue
    let absSum = 0, cnt = 0, maxH = -Infinity, minL = Infinity
    for (let j = i - lookback + 1; j <= i; j++) {
      const d = rows[j]!.perpDelta
      if (num(d)) { absSum += Math.abs(d); cnt++ }
      const h = list[j]!.high, l = list[j]!.low
      if (num(h)) maxH = Math.max(maxH, h)
      if (num(l)) minL = Math.min(minL, l)
    }
    if (cnt === 0 || !(maxH > minL)) continue
    const meaningful = 0.5 * stall * (absSum / cnt)
    const prevLeg = p1 - p0, lastLeg = p2 - p1, range = maxH - minL
    if (prevLeg > meaningful && lastLeg <= 0 && k.close >= maxH - 0.25 * range) push(i, '合约CVD停涨', true)
    if (prevLeg < -meaningful && lastLeg >= 0 && k.close <= minL + 0.25 * range) push(i, '合约CVD停跌', false)
  }
  return rows
}

function fmt(v: number | undefined): string {
  if (v === undefined || !Number.isFinite(v)) return '–'
  const a = Math.abs(v)
  return a >= 1e8 ? `${(v / 1e8).toFixed(2)}亿` : a >= 1e4 ? `${(v / 1e4).toFixed(2)}万` : v.toFixed(0)
}

const BEAR = '#f47067'
const BULL = '#3ddc97'

export const cvdFlowIndicator = {
  name: 'CVD_FLOW',
  shortName: '合约/现货CVD',
  series: 'normal' as const,
  precision: 0,
  calcParams: [20, 3],
  figures: [
    { key: 'perp', title: '合约CVD: ', type: 'line', styles: () => ({ color: '#f0b90b', size: 1.5 }) },
    { key: 'spotScaled', title: '现货CVD: ', type: 'line', styles: () => ({ color: '#27C6DA', size: 1.2 }) },
  ],
  calc: (list: K[], ind: { calcParams?: number[]; extendData?: unknown }) =>
    calcCvdRows(list, Array.isArray(ind.extendData) ? ind.extendData as CvdBarLike[] : undefined,
      Math.max(2, Math.round(ind.calcParams?.[0] ?? 20)), Math.max(1, Math.round(ind.calcParams?.[1] ?? 3))),
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { result?: CvdRow[] }
    crosshair: { dataIndex?: number }
  }) => {
    const res = indicator.result ?? []
    const row = res[Math.max(0, Math.min(crosshair.dataIndex ?? res.length - 1, res.length - 1))]
    if (row === undefined || (row.perp === undefined && row.spot === undefined)) {
      return { name: '合约/现货CVD', calcParamsText: ' 无数据(仅币安)', legends: [], features: [] }
    }
    const legends = [
      { title: '合约CVD: ', value: { text: `${fmt(row.perp)} (本根${fmt(row.perpDelta)})`, color: '#f0b90b' } },
      { title: '现货CVD: ', value: { text: `${fmt(row.spot)} (本根${fmt(row.spotDelta)})`, color: '#27C6DA' } },
    ]
    for (const s of row.signals ?? []) legends.push({ title: '信号: ', value: { text: s.kind, color: s.bearish ? BEAR : BULL } })
    return { name: '合约/现货CVD', calcParamsText: '', legends, features: [] }
  },
  draw: ({ ctx, chart, indicator, xAxis, yAxis }: {
    ctx: CanvasRenderingContext2D
    chart: ChartDrawApi
    indicator: { result?: CvdRow[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
  }) => {
    const res = indicator.result ?? []
    const { visibleRange } = resolveDrawContext(chart)
    ctx.save()
    ctx.font = '10px sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = Math.max(0, visibleRange.from); i < Math.min(res.length, visibleRange.to); i++) {
      const row = res[i]!
      ;(row.signals ?? []).forEach((s, k) => {
        const v = s.kind.startsWith('现货') ? row.spotScaled : row.perp
        if (v === undefined) return
        const x = xAxis.convertToPixel(i)
        const y = yAxis.convertToPixel(v)
        const d = s.bearish ? -1 : 1
        const tip = y - d * 4
        ctx.fillStyle = s.bearish ? BEAR : BULL
        ctx.beginPath()
        ctx.moveTo(x, tip)
        ctx.lineTo(x - 4, tip - d * 7)
        ctx.lineTo(x + 4, tip - d * 7)
        ctx.closePath()
        ctx.fill()
        ctx.fillText(SHORT[s.kind], x, tip - d * (14 + k * 11))
      })
    }
    ctx.restore()
    return false
  },
}
