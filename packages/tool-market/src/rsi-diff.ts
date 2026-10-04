/**
 * RSI fast/slow difference indicator: RSI(6) − RSI(12).
 *
 * Classic momentum spread analysis:
 * - Positive difference: bulls in control (fast RSI above slow RSI).
 * - Negative difference: bears in control.
 * - Zero crossovers: trend inflection. A golden cross below 30 is an oversold
 *   bounce signal; a death cross above 70 is an overbought exhaustion signal.
 * - Absolute delta trajectory: expanding (|diff| growing) indicates accelerating
 *   momentum; contracting indicates momentum decay.
 *
 * Pure; browser chart and market_snapshot share the same code.
 * @module @dsh-trading/tool-market
 */

import { rsi } from './indicators.js'

export const RSI_DIFF_DEFAULTS = [6, 12] as const

export type RsiDiffCross = {
  type: 'golden' | 'death'
  barsAgo: number
  tag: string
}

export type RsiDiffReport = {
  rsi6: number | null
  rsi12: number | null
  diff: number | null
  dominance: 'bullish' | 'bearish' | 'neutral' | null
  momentum: 'expanding' | 'contracting' | 'flat' | null
  lastCross: RsiDiffCross | null
}

const r2 = (v: number): number => {
  const r = Math.round(v * 100) / 100
  return r === 0 ? 0 : r
}

/**
 * Compute the element-wise difference series: RSI(fast) − RSI(slow).
 */
export function rsiDiffSeries(closes: readonly number[], fast = 6, slow = 12): (number | null)[] {
  const r6 = rsi(closes, fast)
  const r12 = rsi(closes, slow)
  const out: (number | null)[] = new Array(closes.length).fill(null)
  for (let i = 0; i < closes.length; i++) {
    const v6 = r6[i]
    const v12 = r12[i]
    if (v6 !== null && v6 !== undefined && v12 !== null && v12 !== undefined) {
      out[i] = r2(v6 - v12)
    }
  }
  return out
}

/**
 * Report current RSI difference, momentum state, and recent crossover event.
 */
export function rsiDiffReport(closes: readonly number[], fast = 6, slow = 12, lookback = 48): RsiDiffReport {
  const n = closes.length
  if (n === 0) {
    return { rsi6: null, rsi12: null, diff: null, dominance: null, momentum: null, lastCross: null }
  }
  const r6Series = rsi(closes, fast)
  const r12Series = rsi(closes, slow)
  const diffs: (number | null)[] = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    const a = r6Series[i]
    const b = r12Series[i]
    if (a != null && b != null) diffs[i] = a - b
  }

  const cur6 = r6Series[n - 1] ?? null
  const cur12 = r12Series[n - 1] ?? null
  const curDiff = diffs[n - 1] ?? null

  let dominance: RsiDiffReport['dominance'] = null
  if (curDiff !== null) {
    dominance = curDiff > 0.05 ? 'bullish' : curDiff < -0.05 ? 'bearish' : 'neutral'
  }

  let momentum: RsiDiffReport['momentum'] = null
  const prevDiff = n > 1 ? (diffs[n - 2] ?? null) : null
  if (curDiff !== null && prevDiff !== null) {
    // 动能方向判断：沿当前主导方向扩张还是收敛
    const sign = curDiff >= 0 ? 1 : -1
    const delta = sign * (curDiff - prevDiff)
    momentum = delta > 0.05 ? 'expanding' : delta < -0.05 ? 'contracting' : 'flat'
  }

  let lastCross: RsiDiffCross | null = null
  const start = Math.max(1, n - 1 - lookback)
  for (let i = n - 1; i >= start; i--) {
    const c = diffs[i]
    const p = diffs[i - 1]
    if (c == null || p == null) continue
    if (c > 0 && p <= 0) {
      const rVal = r6Series[i] ?? 50
      const tag = rVal < 30 ? '超卖金叉' : rVal > 70 ? '高位金叉' : '金叉'
      lastCross = { type: 'golden', barsAgo: n - 1 - i, tag }
      break
    } else if (c < 0 && p >= 0) {
      const rVal = r6Series[i] ?? 50
      const tag = rVal > 70 ? '超买死叉' : rVal < 30 ? '低位死叉' : '死叉'
      lastCross = { type: 'death', barsAgo: n - 1 - i, tag }
      break
    }
  }

  return {
    rsi6: cur6 == null ? null : r2(cur6),
    rsi12: cur12 == null ? null : r2(cur12),
    diff: curDiff == null ? null : r2(curDiff),
    dominance,
    momentum,
    lastCross,
  }
}

export function renderRsiDiff(r: RsiDiffReport): string {
  const domZh = r.dominance === 'bullish' ? '多头占优' : r.dominance === 'bearish' ? '空头占优' : '多空平衡'
  const momZh = r.momentum === 'expanding' ? '动能扩张' : r.momentum === 'contracting' ? '动能收敛' : '动能走平'
  const crossZh = r.lastCross ? `${r.lastCross.barsAgo}根前${r.lastCross.tag}` : '无近期交叉'
  const r6Txt = r.rsi6 === null ? '–' : String(r.rsi6)
  const r12Txt = r.rsi12 === null ? '–' : String(r.rsi12)
  const diffTxt = r.diff === null ? '–' : `${r.diff > 0 ? '+' : ''}${r.diff}`
  return `  RSI快慢差 (6-12): RSI6 ${r6Txt} | RSI12 ${r12Txt} | 差值 ${diffTxt} (${domZh}·${momZh}) | 信号: ${crossZh}`
}
