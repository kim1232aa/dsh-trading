/**
 * Price structure the dashboard numbers can't show: swing pivots with
 * HH/LH/HL/LL labels, RSI divergence between pivots, and volume spikes.
 *
 * A pivot needs `span` bars on each side, so the newest `span` bars can never
 * confirm one; divergence against the live bar is therefore reported
 * separately as "未确认".
 * ponytail: fixed span=3, RSI-only divergence; add MACD/OBV variants when asked.
 * @module @dsh-trading/tool-market
 */

import { rsi } from './indicators.js'

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
  currentValue: number
  broken: boolean
}

const r2 = (v: number): number => Math.round(v * 100) / 100
const r1 = (v: number): number => Math.round(v * 10) / 10
/** Within 0.05% counts as an equal high/low (double top/bottom), not a new extreme. */
const EQ_TOL = 0.0005

/**
 * Find the best trendline through confirmed swing pivots.
 * Uptrend: connect two rising swing lows; downtrend: two falling swing highs.
 * A line is valid if no bar's close crosses it between the anchors.
 * Touches: bars whose extreme comes within 0.15% of the line value.
 * 3+ touches = confirmed; broken = a close beyond the line after p2.
 */
export function detectTrendlines(bars: readonly Bar[], allHighs: Swing[], allLows: Swing[]): Trendline[] {
  if (bars.length < 10) return []
  const lines: Trendline[] = []

  const lineAt = (p1: Swing, p2: Swing, idx: number): number => {
    const t1 = p1.index, t2 = p2.index
    if (t2 === t1) return p1.price
    return p1.price + (p2.price - p1.price) * (idx - t1) / (t2 - t1)
  }

  const TOUCH_TOL = 0.0015 // 0.15% of price

  // Try uptrend: pairs of rising lows (newest first for priority)
  for (let j = allLows.length - 1; j >= 1; j--) {
    for (let k = j - 1; k >= 0; k--) {
      const p1 = allLows[k]!, p2 = allLows[j]!
      if (p2.price <= p1.price) continue // not rising
      // Validate: no close below the line between p1 and p2
      let valid = true
      for (let i = p1.index + 1; i < p2.index && i < bars.length; i++) {
        const lv = lineAt(p1, p2, i)
        if (bars[i]!.close < lv * (1 - TOUCH_TOL * 2)) { valid = false; break }
      }
      if (!valid) continue
      // Count touches (bars whose low is within tolerance of the line)
      let touches = 2
      for (let i = p1.index; i < bars.length; i++) {
        if (i === p1.index || i === p2.index) continue
        const lv = lineAt(p1, p2, i)
        if (Math.abs(bars[i]!.low - lv) / lv < TOUCH_TOL) touches++
      }
      // Check if broken after p2
      let broken = false
      for (let i = p2.index + 1; i < bars.length; i++) {
        if (bars[i]!.close < lineAt(p1, p2, i) * (1 - TOUCH_TOL)) { broken = true; break }
      }
      const currentValue = r2(lineAt(p1, p2, bars.length - 1))
      lines.push({
        direction: 'up', touches, broken, currentValue,
        p1: { time: p1.time, price: p1.price, index: p1.index },
        p2: { time: p2.time, price: p2.price, index: p2.index },
      })
      break // best uptrend found
    }
    if (lines.some(l => l.direction === 'up')) break
  }

  // Try downtrend: pairs of falling highs (newest first)
  for (let j = allHighs.length - 1; j >= 1; j--) {
    for (let k = j - 1; k >= 0; k--) {
      const p1 = allHighs[k]!, p2 = allHighs[j]!
      if (p2.price >= p1.price) continue // not falling
      let valid = true
      for (let i = p1.index + 1; i < p2.index && i < bars.length; i++) {
        const lv = lineAt(p1, p2, i)
        if (bars[i]!.close > lv * (1 + TOUCH_TOL * 2)) { valid = false; break }
      }
      if (!valid) continue
      let touches = 2
      for (let i = p1.index; i < bars.length; i++) {
        if (i === p1.index || i === p2.index) continue
        const lv = lineAt(p1, p2, i)
        if (Math.abs(bars[i]!.high - lv) / lv < TOUCH_TOL) touches++
      }
      let broken = false
      for (let i = p2.index + 1; i < bars.length; i++) {
        if (bars[i]!.close > lineAt(p1, p2, i) * (1 + TOUCH_TOL)) { broken = true; break }
      }
      const currentValue = r2(lineAt(p1, p2, bars.length - 1))
      lines.push({
        direction: 'down', touches, broken, currentValue,
        p1: { time: p1.time, price: p1.price, index: p1.index },
        p2: { time: p2.time, price: p2.price, index: p2.index },
      })
      break
    }
    if (lines.some(l => l.direction === 'down')) break
  }

  return lines
}

export function priceStructure(bars: readonly Bar[], span = 3): Structure {
  const n = bars.length
  const rs = rsi(bars.map(b => b.close), 14)
  const highs: Swing[] = []
  const lows: Swing[] = []
  for (let i = span; i < n - span; i++) {
    let isH = true
    let isL = true
    for (let j = i - span; j <= i + span; j++) {
      if (j === i) continue
      // An equal extreme to the left disqualifies; to the right it doesn't, so a double bottom keeps its first pivot.
      if (j < i ? bars[j]!.high >= bars[i]!.high : bars[j]!.high > bars[i]!.high) isH = false
      if (j < i ? bars[j]!.low <= bars[i]!.low : bars[j]!.low < bars[i]!.low) isL = false
    }
    const r = rs[i] ?? null
    if (isH) highs.push({ index: i, time: bars[i]!.time, price: r2(bars[i]!.high), rsi: r === null ? null : r2(r), label: null })
    if (isL) lows.push({ index: i, time: bars[i]!.time, price: r2(bars[i]!.low), rsi: r === null ? null : r2(r), label: null })
  }
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
    const conf = l.touches >= 3 ? `${l.touches}触已确认` : `${l.touches}触待确认`
    return `${dir} ${t(l.p1.time)} ${l.p1.price}→${t(l.p2.time)} ${l.p2.price}, 现值 ${l.currentValue}, ${conf}, ${l.broken ? '已破' : '未破'}`
  }).join(' | ')
  return `${base}\n  趋势线: ${tl}`
}
