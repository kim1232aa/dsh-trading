/**
 * Rule-based long/short entry signals. Research output, not an order: the
 * rules are fixed and printed with every signal so a reader can check them.
 *
 * Rules (per bar, closed bars only):
 *   trend   SuperTrend(period, factor) direction
 *   trigger flip  — direction changed on this bar
 *           pullback — price tagged the band (within 0.5×ATR) and closed back
 *                      in trend direction vs the previous close
 *   filters close vs WMA60 on the trend side, ADX14 ≥ 20, RSI14 < 70 (long) / > 30 (short)
 *   risk    stop = band ∓ 0.25×ATR14, T1 = 1.5R, T2 = 3R
 *   cooldown one signal per side per 6 bars
 *
 * Pure; no imports beyond the indicator modules, so the browser chart can
 * import this file directly and draw exactly what the model reads.
 * ponytail: one fixed rule set; add per-user rule configs when someone asks for them.
 * @module @dsh-trading/tool-market
 */

import { adx, atr, supertrend } from './candle-indicators.js'
import { rsi, wma } from './indicators.js'

export interface SignalBar { time: string; open: number; high: number; low: number; close: number; volume: number }

export type SignalSide = 'long' | 'short'
export type SignalStatus = 'open' | 'target1' | 'target2' | 'stopped'

export type EntrySignal = {
  index: number
  time: string
  side: SignalSide
  kind: 'flip' | 'pullback'
  entry: number
  stop: number
  target1: number
  target2: number
}

export type SignalReport = {
  /** Most recent signal within the lookback, with how price has treated it since. */
  latest: (EntrySignal & { status: SignalStatus; barsAgo: number }) | null
  /** Trend side on the last bar, and the filters that currently block a fresh entry on that side. */
  trend: SignalSide | null
  blockers: string[]
  /** This rule set's own record over the series: finished signals and how many reached T1 before the stop. */
  record: { finished: number; hitT1: number }
}

export const SIGNAL_RULES = 'ST趋势 + 翻转/回踩触发 + WMA60同侧 + ADX≥20 + RSI未极端；止损=ST轨外0.25ATR，T1=1.5R，T2=3R'

const ADX_MIN = 20
const COOLDOWN = 6
const r2 = (v: number): number => Math.round(v * 100) / 100

/** Every signal in the series, oldest first. */
export function entrySignals(bars: readonly SignalBar[], period = 60, factor = 4): EntrySignal[] {
  const n = bars.length
  if (n < period + 2) return []
  const closes = bars.map(b => b.close)
  const st = supertrend(bars, period, factor)
  const a = atr(bars, 14)
  const w = wma(closes, 60)
  const rs = rsi(closes, 14)
  const ax = adx(bars, 14).adx
  const out: EntrySignal[] = []
  const lastAt: Record<SignalSide, number> = { long: -Infinity, short: -Infinity }

  for (let i = 1; i < n; i++) {
    const dir = st.direction[i]
    const band = st.values[i]
    const atrI = a[i]
    const wI = w[i]
    const rI = rs[i]
    const aI = ax[i]
    if (dir == null || band == null || atrI == null || wI == null || rI == null || aI == null) continue
    const b = bars[i]!
    const prev = bars[i - 1]!
    const side: SignalSide = dir === 'bullish' ? 'long' : 'short'
    if (i - lastAt[side] < COOLDOWN) continue

    const flip = st.direction[i - 1] != null && st.direction[i - 1] !== dir
    const pullback = side === 'long'
      ? b.low <= band + 0.5 * atrI && b.close > prev.close && b.close > band
      : b.high >= band - 0.5 * atrI && b.close < prev.close && b.close < band
    if (!flip && !pullback) continue

    const ok = side === 'long'
      ? b.close > wI && aI >= ADX_MIN && rI < 70
      : b.close < wI && aI >= ADX_MIN && rI > 30
    if (!ok) continue

    const stop = side === 'long' ? band - 0.25 * atrI : band + 0.25 * atrI
    const risk = Math.abs(b.close - stop)
    if (!(risk > 0)) continue
    const sgn = side === 'long' ? 1 : -1
    out.push({
      index: i,
      time: b.time,
      side,
      kind: flip ? 'flip' : 'pullback',
      entry: r2(b.close),
      stop: r2(stop),
      target1: r2(b.close + sgn * 1.5 * risk),
      target2: r2(b.close + sgn * 3 * risk),
    })
    lastAt[side] = i
  }
  return out
}

/** How price has treated a signal since it fired. Stop is checked first on a bar that hits both (conservative). */
export function signalStatus(bars: readonly SignalBar[], s: EntrySignal): SignalStatus {
  let status: SignalStatus = 'open'
  for (let i = s.index + 1; i < bars.length; i++) {
    const b = bars[i]!
    if (s.side === 'long') {
      if (b.low <= s.stop) return 'stopped'
      if (b.high >= s.target2) return 'target2'
      if (b.high >= s.target1) status = 'target1'
    } else {
      if (b.high >= s.stop) return 'stopped'
      if (b.low <= s.target2) return 'target2'
      if (b.low <= s.target1) status = 'target1'
    }
  }
  return status
}

/** Whether T1 printed before the stop (same bar → stop first, as in signalStatus). */
export function reachedT1(bars: readonly SignalBar[], s: EntrySignal): boolean {
  for (let i = s.index + 1; i < bars.length; i++) {
    const b = bars[i]!
    if (s.side === 'long' ? b.low <= s.stop : b.high >= s.stop) return false
    if (s.side === 'long' ? b.high >= s.target1 : b.low <= s.target1) return true
  }
  return false
}

/** Latest signal (within `lookback` bars) plus why the current bar is or isn't an entry. */
export function signalReport(bars: readonly SignalBar[], period = 60, factor = 4, lookback = 48): SignalReport {
  const n = bars.length
  const all = entrySignals(bars, period, factor)
  const last = all.at(-1)
  const latest = last !== undefined && n - 1 - last.index <= lookback
    ? { ...last, status: signalStatus(bars, last), barsAgo: n - 1 - last.index }
    : null

  const st = supertrend(bars, period, factor)
  const dir = st.direction[n - 1] ?? null
  const trend: SignalSide | null = dir === null ? null : dir === 'bullish' ? 'long' : 'short'
  const blockers: string[] = []
  if (trend !== null) {
    const closes = bars.map(b => b.close)
    const c = closes[n - 1]!
    const wI = wma(closes, 60)[n - 1] ?? null
    const rI = rsi(closes, 14)[n - 1] ?? null
    const aI = adx(bars, 14).adx[n - 1] ?? null
    if (wI !== null && (trend === 'long' ? c <= wI : c >= wI)) blockers.push(`收盘${trend === 'long' ? '未站上' : '未跌破'}WMA60(${r2(wI)})`)
    if (aI !== null && aI < ADX_MIN) blockers.push(`ADX ${r2(aI)}<${ADX_MIN} 趋势不足`)
    if (rI !== null && (trend === 'long' ? rI >= 70 : rI <= 30)) blockers.push(`RSI ${r2(rI)} ${trend === 'long' ? '超买' : '超卖'}，不追`)
  }
  // A trade that tags T1 and later stops still reached T1; signalStatus alone would count it as a loss.
  const done = all.filter(s => signalStatus(bars, s) !== 'open')
  const record = { finished: done.length, hitT1: done.filter(s => reachedT1(bars, s)).length }
  return { latest, trend, blockers, record }
}

const SIDE_ZH: Record<SignalSide, string> = { long: '做多', short: '做空' }
const STATUS_ZH: Record<SignalStatus, string> = { open: '持有中', target1: '已到T1', target2: '已到T2', stopped: '已止损' }

/** One line for the model-facing snapshot text. */
export function renderSignal(r: SignalReport): string {
  // T1 = 1.5R, so below 40% hit rate the rule loses money before costs. Printed every time so nobody reads it as advice.
  // Expectancy assumes a full exit at T1 (+1.5R) or the stop (−1R), before fees.
  const { finished: f, hitT1: h } = r.record
  const rec = f === 0 ? '无历史样本' : `本序列已结束 ${f} 个，到T1 ${h} 个(${Math.round(100 * h / f)}%，盈亏平衡需≥40%，期望 ${((1.5 * h - (f - h)) / f).toFixed(2)}R/笔${f < 30 ? '，样本<30不可信' : ''})`
  const head = `  Signal [${SIGNAL_RULES}｜未验证规则，${rec}]: `
  if (r.latest !== null) {
    const s = r.latest
    return `${head}${SIDE_ZH[s.side]}(${s.kind === 'flip' ? '翻转' : '回踩'}) @${s.entry} ${s.barsAgo}根前 | 止损 ${s.stop} T1 ${s.target1} T2 ${s.target2} | ${STATUS_ZH[s.status]}`
  }
  const why = r.blockers.length > 0 ? `；当前受阻: ${r.blockers.join('，')}` : '；等待回踩ST轨或翻转'
  return `${head}近期无信号，趋势${r.trend === null ? '未定' : SIDE_ZH[r.trend]}${why}`
}
