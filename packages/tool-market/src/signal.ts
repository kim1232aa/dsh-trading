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
 *   cooldown one signal per side per 6 bars; only one active signal overall
 *   tracking T1 is a milestone; stop or T2 ends tracking before another entry
 *   boundary an unknown last bar is excluded; historical callers can explicitly mark it closed
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

export type SignalOptions = {
  /** Unknown tails are treated as live. Opt in only for fully closed historical data. */
  lastBarClosed?: boolean
  /** Inclusive historical observation index; never reads later bars. */
  asOfIndex?: number
}

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
  /** Trend side and filters at the last confirmed bar. */
  trend: SignalSide | null
  blockers: string[]
  /** Touch counts only, not fills or PnL; T1 does not end tracking. */
  record: { finished: number; hitT1: number; hitT2: number; stopped: number; active: number }
}

export const SIGNAL_RULES = '收盘确认 + ST翻转/回踩 + WMA60同侧 + ADX≥20 + RSI未极端；止损=ST轨外0.25ATR，T1=1.5R，T2=3R；单信号跟踪至止损/T2'

const ADX_MIN = 20
const COOLDOWN = 6
const r2 = (v: number): number => Math.round(v * 100) / 100 || 0

export function confirmedBarCount(length: number, options: SignalOptions = {}): number {
  const count = Math.max(0, length - (options.lastBarClosed === true ? 0 : 1))
  if (options.asOfIndex === undefined) return count
  if (!Number.isFinite(options.asOfIndex)) return 0
  return Math.max(0, Math.min(count, Math.floor(options.asOfIndex) + 1))
}

/** Stop wins when OHLC cannot establish which boundary was hit first. */
export function advanceSignal(s: EntrySignal, status: SignalStatus, bar: Pick<SignalBar, 'high' | 'low'>): SignalStatus {
  if (status === 'stopped' || status === 'target2') return status
  if (s.side === 'long') {
    if (bar.low <= s.stop) return 'stopped'
    if (bar.high >= s.target2) return 'target2'
    if (bar.high >= s.target1) return 'target1'
  } else {
    if (bar.high >= s.stop) return 'stopped'
    if (bar.low <= s.target2) return 'target2'
    if (bar.low <= s.target1) return 'target1'
  }
  return status
}

const priceText = (value: number): string => String(Number(value.toPrecision(12)))

/** Every signal in the series, oldest first. */
export function entrySignals(bars: readonly SignalBar[], period = 60, factor = 4, options: SignalOptions = {}): EntrySignal[] {
  const n = confirmedBarCount(bars.length, options)
  // Eligibility is checked per index below; a series-length guard would backfill past signals.
  if (n < 2) return []
  const closes = bars.map(b => b.close)
  const st = supertrend(bars, period, factor)
  const a = atr(bars, 14)
  const w = wma(closes, 60)
  const rs = rsi(closes, 14)
  const ax = adx(bars, 14).adx
  const out: EntrySignal[] = []
  const lastAt: Record<SignalSide, number> = { long: -Infinity, short: -Infinity }
  let active: EntrySignal | null = null
  let status: SignalStatus = 'open'

  for (let i = 1; i < n; i++) {
    const b = bars[i]!
    if (active !== null) {
      status = advanceSignal(active, status, b)
      if (status === 'open' || status === 'target1') continue
      active = null
    }
    const dir = st.direction[i]
    const band = st.values[i]
    const atrI = a[i]
    const wI = w[i]
    const rI = rs[i]
    const aI = ax[i]
    if (dir == null || band == null || atrI == null || wI == null || rI == null || aI == null) continue
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
    const sgn = side === 'long' ? 1 : -1
    const risk = sgn * (b.close - stop)
    if (!(risk > 0) || !Number.isFinite(risk)) continue
    active = {
      index: i,
      time: b.time,
      side,
      kind: flip ? 'flip' : 'pullback',
      entry: b.close,
      stop,
      target1: b.close + sgn * 1.5 * risk,
      target2: b.close + sgn * 3 * risk,
    }
    out.push(active)
    status = 'open'
    lastAt[side] = i
  }
  return out
}

/** How price has treated a signal since it fired. Stop is checked first on a bar that hits both (conservative). */
export function signalStatus(bars: readonly SignalBar[], s: EntrySignal, options: SignalOptions = {}): SignalStatus {
  let status: SignalStatus = 'open'
  const n = confirmedBarCount(bars.length, options)
  for (let i = s.index + 1; i < n; i++) {
    status = advanceSignal(s, status, bars[i]!)
    if (status === 'stopped' || status === 'target2') break
  }
  return status
}

/** Whether T1 printed before the stop (same bar → stop first, as in signalStatus). */
export function reachedT1(bars: readonly SignalBar[], s: EntrySignal, options: SignalOptions = {}): boolean {
  const n = confirmedBarCount(bars.length, options)
  for (let i = s.index + 1; i < n; i++) {
    const b = bars[i]!
    if (s.side === 'long' ? b.low <= s.stop : b.high >= s.stop) return false
    if (s.side === 'long' ? b.high >= s.target1 : b.low <= s.target1) return true
  }
  return false
}

/** Latest signal (within `lookback` bars) plus why the current bar is or isn't an entry. */
export function signalReport(bars: readonly SignalBar[], period = 60, factor = 4, lookback = 48, options: SignalOptions = {}): SignalReport {
  const n = confirmedBarCount(bars.length, options)
  const all = entrySignals(bars, period, factor, options)
  const states = all.map(s => ({ signal: s, status: signalStatus(bars, s, options) }))
  const last = states.at(-1)
  const latest = last !== undefined && n - 1 - last.signal.index <= lookback
    ? { ...last.signal, status: last.status, barsAgo: n - 1 - last.signal.index }
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
    if (wI !== null && (trend === 'long' ? c <= wI : c >= wI)) blockers.push(`收盘${trend === 'long' ? '未站上' : '未跌破'}WMA60(${priceText(wI)})`)
    if (aI !== null && aI < ADX_MIN) blockers.push(`ADX ${r2(aI)}<${ADX_MIN} 趋势不足`)
    if (rI !== null && (trend === 'long' ? rI >= 70 : rI <= 30)) blockers.push(`RSI ${r2(rI)} ${trend === 'long' ? '超买' : '超卖'}，不追`)
  }
  const done = states.filter(s => s.status === 'stopped' || s.status === 'target2')
  const record = {
    finished: done.length,
    hitT1: done.filter(s => reachedT1(bars, s.signal, options)).length,
    hitT2: done.filter(s => s.status === 'target2').length,
    stopped: done.filter(s => s.status === 'stopped').length,
    active: states.length - done.length,
  }
  if (record.active > 0) blockers.push('已有信号跟踪中，等待止损或T2结束')
  return { latest, trend, blockers, record }
}

const SIDE_ZH: Record<SignalSide, string> = { long: '多头观察', short: '空头观察' }
const STATUS_ZH: Record<SignalStatus, string> = { open: '信号跟踪中', target1: '触及T1·继续跟踪', target2: '触及T2·结束', stopped: '触及止损·结束' }

/** One line for the model-facing snapshot text. */
export function renderSignal(r: SignalReport): string {
  const { finished: f, hitT1: h, hitT2, stopped, active } = r.record
  const rec = `本窗口结束 ${f} 条，其中触及T1 ${h} 条、T2 ${hitT2} 条、止损 ${stopped} 条；跟踪中 ${active} 条；仅触价统计，非成交/收益回测，未计手续费/滑点`
  const head = `  Signal [${SIGNAL_RULES}｜未验证规则，${rec}]: `
  if (r.latest !== null) {
    const s = r.latest
    return `${head}${SIDE_ZH[s.side]}(${s.kind === 'flip' ? '翻转' : '回踩'}) @${priceText(s.entry)} ${s.barsAgo}根前 | 止损 ${priceText(s.stop)} T1 ${priceText(s.target1)} T2 ${priceText(s.target2)} | ${STATUS_ZH[s.status]}`
  }
  const why = r.blockers.length > 0 ? `；当前受阻: ${r.blockers.join('，')}` : '；等待回踩ST轨或翻转'
  return `${head}近期无信号，趋势${r.trend === null ? '未定' : SIDE_ZH[r.trend]}${why}`
}
