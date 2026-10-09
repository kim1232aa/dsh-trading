/**
 * Price structure the dashboard numbers can't show: swing pivots with
 * HH/LH/HL/LL labels, RSI divergence between pivots, and volume spikes.
 *
 * A pivot needs `span` closed bars on each side. Excluding the potentially live
 * tail leaves the newest `span + 1` bars unconfirmed; live divergence is reported
 * separately as "未确认".
 * ponytail: fixed span=3, RSI-only divergence; add MACD/OBV variants when asked.
 * @module @dsh-trading/tool-market
 */

import { rsi } from './indicators.js'
import { trendlineCandidate } from './trendlines.js'
import { detectSwingPoints, type SwingPoint } from './swing-points.js'

type Bar = { time: string; high: number; low: number; close: number; volume: number }

export type Swing = { index: number; time: string; price: number; rsi: number | null; label: 'HH' | 'LH' | 'EQ' | 'HL' | 'LL' | null }

export type Structure = {
  /** Last three confirmed swing highs / lows, oldest first. */
  highs: Swing[]
  lows: Swing[]
  trend: 'up' | 'down' | 'range' | null
  /** Price already beyond the last confirmed swing, before a new pivot can confirm it. */
  breakOut: string | null
  divergence: string[]
  /** Volume ÷ median volume of up to 288 prior bars (24h of 5m). */
  volume: { lastRatio: number | null; peakRatio: number | null; peakTime: string | null }
  trendlines: Trendline[]
}

export type Trendline = {
  direction: 'up' | 'down'
  p1: { time: string; price: number; index: number }
  p2: { time: string; price: number; index: number }
  touches: number
  retests: number
  status: 'candidate' | 'confirmed' | 'broken'
  currentValue: number
  broken: boolean
}

const r2 = (v: number): number => Math.round(v * 100) / 100
const r1 = (v: number): number => Math.round(v * 10) / 10
/** Within 0.05% counts as an equal high/low (double top/bottom), not a new extreme. */
const EQ_TOL = 0.0005

/** Same wick/independent-pivot validation as find_swing_points. */
export function detectTrendlines(bars: readonly Bar[], allHighs: Swing[], allLows: Swing[]): Trendline[] {
  if (bars.length < 10) return []
  // Swing prices are display-rounded; use the actual wick for line geometry.
  const raw = (points: Swing[], kind: 'high' | 'low') => points.map(p => ({
    ...p, price: kind === 'high' ? bars[p.index]!.high : bars[p.index]!.low,
  }))
  return [
    trendlineCandidate(bars, raw(allLows, 'low'), 'support'),
    trendlineCandidate(bars, raw(allHighs, 'high'), 'resistance'),
  ].filter((line): line is NonNullable<typeof line> => line !== null).map(line => ({
    direction: line.kind === 'support' ? 'up' : 'down',
    p1: { ...line.anchors[0], index: line.anchorIndices[0] },
    p2: { ...line.anchors[1], index: line.anchorIndices[1] },
    touches: line.touches, retests: line.retests, status: line.status,
    currentValue: r2(line.projectedNow), broken: line.status === 'broken',
  }))
}

export function priceStructure(bars: readonly Bar[], span = 3): Structure {
  const n = bars.length
  const rs = rsi(bars.map(b => b.close), 14)
  const highs: Swing[] = []
  const lows: Swing[] = []
  // Same strict extrema and live-tail policy as find_swing_points.
  const swings = detectSwingPoints(bars.slice(0, -1), span, span)
  const display = (p: SwingPoint): Swing => ({
    ...p, price: r2(p.price), rsi: rs[p.index] == null ? null : r2(rs[p.index]!), label: null,
  })
  highs.push(...swings.swingHighs.map(display))
  lows.push(...swings.swingLows.map(display))
  const label = (a: Swing[], up: 'HH' | 'HL', down: 'LH' | 'LL'): void => {
    for (let k = 1; k < a.length; k++) {
      const d = (a[k]!.price - a[k - 1]!.price) / a[k - 1]!.price
      a[k]!.label = Math.abs(d) <= EQ_TOL ? 'EQ' : d > 0 ? up : down
    }
  }
  label(highs, 'HH', 'LH')
  label(lows, 'HL', 'LL')

  const h = highs.slice(-3)
  const l = lows.slice(-3)
  const lh = h.at(-1)?.label ?? null
  const ll = l.at(-1)?.label ?? null
  const trend = lh === null || ll === null ? null
    : lh === 'HH' && ll === 'HL' ? 'up'
    : lh === 'LH' && ll === 'LL' ? 'down'
    : 'range'

  // Pivots confirm `span` bars late, so a crash can leave `trend` reading 'up'. Price beyond the last
  // confirmed swing is a break of structure the labels can't show yet.
  let breakOut: string | null = null
  const lo = l.at(-1)
  const hi = h.at(-1)
  if (lo) {
    const m = Math.min(...bars.slice(lo.index + 1).map(b => b.low))
    if (m < lo.price) breakOut = `已跌破前低 ${lo.price}(最低 ${r2(m)})`
  }
  if (hi) {
    const m = Math.max(...bars.slice(hi.index + 1).map(b => b.high))
    // Both broken (outside bar / whipsaw): report whichever came last.
    if (m > hi.price) {
      const lastIdx = (f: (b: Bar) => boolean): number => { for (let i = n - 1; i >= 0; i--) if (f(bars[i]!)) return i; return -1 }
      const lastUp = lastIdx(b => b.high > hi.price)
      const lastDn = lo ? lastIdx(b => b.low < lo.price) : -1
      if (breakOut === null || lastUp > lastDn) breakOut = `已突破前高 ${hi.price}(最高 ${r2(m)})`
    }
  }

  const divergence: string[] = []
  const t = (s: string): string => s.length > 10 ? s.slice(5, 16).replace('T', ' ') : s
  const [pl, cl] = l.slice(-2)
  if (pl && cl && cl.price < pl.price && pl.rsi !== null && cl.rsi !== null && cl.rsi > pl.rsi) {
    divergence.push(`底背离 ${t(pl.time)}→${t(cl.time)} 价 ${pl.price}→${cl.price} RSI ${pl.rsi}→${cl.rsi}`)
  }
  const [ph, ch] = h.slice(-2)
  if (ph && ch && ch.price > ph.price && ph.rsi !== null && ch.rsi !== null && ch.rsi < ph.rsi) {
    divergence.push(`顶背离 ${t(ph.time)}→${t(ch.time)} 价 ${ph.price}→${ch.price} RSI ${ph.rsi}→${ch.rsi}`)
  }
  // Live bar vs the last confirmed pivot: the earliest a divergence can be seen, and the least reliable.
  const last = bars[n - 1]
  const lastRsi = rs[n - 1] ?? null
  if (last && lastRsi !== null) {
    if (cl && cl.rsi !== null && last.low < cl.price && lastRsi > cl.rsi) divergence.push(`潜在底背离(未确认): 新低 ${r2(last.low)}<${cl.price}，RSI ${r2(lastRsi)}>${cl.rsi}`)
    if (ch && ch.rsi !== null && last.high > ch.price && lastRsi < ch.rsi) divergence.push(`潜在顶背离(未确认): 新高 ${r2(last.high)}>${ch.price}，RSI ${r2(lastRsi)}<${ch.rsi}`)
  }

  const volume: Structure['volume'] = { lastRatio: null, peakRatio: null, peakTime: null }
  const prior = bars.slice(Math.max(0, n - 1 - 288), n - 1).map(b => b.volume).sort((a, b) => a - b)
  const med = prior.length >= 20 ? prior[Math.floor(prior.length / 2)]! : 0
  if (med > 0) {
    volume.lastRatio = r1(bars[n - 1]!.volume / med)
    for (const b of bars.slice(-24)) {
      const ratio = r1(b.volume / med)
      if (volume.peakRatio === null || ratio > volume.peakRatio) { volume.peakRatio = ratio; volume.peakTime = b.time }
    }
  }
  const tlines = detectTrendlines(bars, highs, lows)
  return { highs: h, lows: l, trend, breakOut, divergence, volume, trendlines: tlines }
}

const TREND_ZH = { up: '上升(高低点抬高)', down: '下降(高低点降低)', range: '震荡' } as const

/** A break in the trend's own direction continues it; against it, the confirmed labels are stale. */
function brk(s: Structure): string {
  if (!s.breakOut) return ''
  const withTrend = (s.trend === 'down' && s.breakOut.startsWith('已跌破')) || (s.trend === 'up' && s.breakOut.startsWith('已突破'))
  return withTrend ? `，延续中(${s.breakOut})` : `，但${s.breakOut}，结构待确认`
}

export function renderStructure(s: Structure): string {
  const t = (x: string): string => x.length > 10 ? x.slice(5, 16).replace('T', ' ') : x
  // '无'/'未定', not '–': an empty pivot list is a real answer (monotonic move), not missing data.
  const list = (a: Swing[]): string => a.length === 0 ? '无' : a.map(x => `${t(x.time)} ${x.price}${x.label ? `(${x.label})` : ''}`).join(' → ')
  const v = s.volume
  const vol = v.lastRatio === null ? '样本不足'
    : `最新根 ${v.lastRatio}×中位数${v.peakRatio !== null ? `，近24根峰值 ${v.peakRatio}× @${t(v.peakTime!)}` : ''}`
  const base = `  Structure: 高点 ${list(s.highs)} | 低点 ${list(s.lows)} | 结构 ${s.trend ? TREND_ZH[s.trend] : '未定'}${brk(s)} | 背离 ${s.divergence.length > 0 ? s.divergence.join('；') : '无'} | 量 ${vol}`
  if (s.trendlines.length === 0) return base
  const tl = s.trendlines.map(l => {
    const dir = l.direction === 'up' ? '上行支撑' : '下行压力'
    const conf = `${l.touches}个独立摆动触点，${l.retests}次后续回测，${l.status === 'broken' ? '已破线' : l.status === 'confirmed' ? '回测确认（非保证）' : '候选待回测'}`
    return `${dir} ${t(l.p1.time)} ${l.p1.price}→${t(l.p2.time)} ${l.p2.price}, 现值 ${l.currentValue}, ${conf}, ${l.broken ? '已破' : '未破'}`
  }).join(' | ')
  return `${base}\n  趋势线: ${tl}`
}
