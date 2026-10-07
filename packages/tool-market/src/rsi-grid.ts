/**
 * Port and extension of the Pine v5 strategy "RSI策略网格", supporting both
 * Long (现货抄底 / 做多网格) and Short (期货做空 / 逢高做空网格):
 *
 * Long logic:
 *   rsi = ta.rsi(close, len)
 *   cumulative_diff: rsi < low ? += (low - rsi) : := 0
 *   entry  = rsi < low and cumulative_diff > cumThreshold        → strategy.entry long
 *   exit   = rsi >= high and not (strategy.openprofit < 0)       → strategy.close
 *
 * Short logic:
 *   rsi = ta.rsi(close, len)
 *   cumulative_diff: rsi > high ? += (rsi - high) : := 0
 *   entry  = rsi > high and cumulative_diff > cumThreshold       → strategy.entry short
 *   exit   = rsi <= low and not (strategy.openprofit < 0)        → strategy.close
 *
 * Strategy semantics reproduced: orders fire on bar close and fill at the NEXT
 * bar's open (process_orders_on_close=false); pyramiding=1, so an entry while
 * already in position is ignored; strategy.close while flat is a no-op; openprofit is
 * marked at the bar's close.
 *
 * Pure; the browser chart imports this file directly.
 * @module @dsh-trading/tool-market
 */

import { rsi as rsiSeries } from './indicators.js'

export const RSI_GRID_DEFAULTS = [7, 30, 60, 10] as const
export const RSI_GRID_SHORT_DEFAULTS = [7, 40, 70, 10] as const

type Bar = { open: number; close: number }

export type RsiGridSide = 'long' | 'short'

export type RsiGridBar = {
  rsi: number | null
  cum: number
  /** Condition fired on this bar's close (order fills next bar). */
  signal?: 'entry' | 'exit'
  /** Fill price on this bar's open. */
  entry?: number
  exit?: number
}

export type RsiGridTrade = {
  entryIndex: number
  entry: number
  exitIndex: number
  exit: number
  side?: RsiGridSide
}

export type RsiGridResult = {
  bars: RsiGridBar[]
  trades: RsiGridTrade[]
  open: { entryIndex: number; entry: number; side?: RsiGridSide } | null
  side: RsiGridSide
}

export function rsiGrid(
  bars: readonly Bar[],
  length = 7,
  low = 30,
  high = 60,
  cumThreshold = 10,
  side: RsiGridSide = 'long',
): RsiGridResult {
  const rs = rsiSeries(bars.map(b => b.close), length)
  const out: RsiGridBar[] = []
  const trades: RsiGridTrade[] = []
  let cum = 0
  let pos: { entryIndex: number; entry: number; side: RsiGridSide } | null = null
  let pendingEntry = false
  let pendingExit = false
  const isShort = side === 'short'

  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!
    const row: RsiGridBar = { rsi: rs[i] ?? null, cum: 0 }
    if (pendingExit && pos !== null) {
      trades.push({ ...pos, exitIndex: i, exit: b.open, side })
      row.exit = b.open
      pos = null
    }
    if (pendingEntry && pos === null) {
      pos = { entryIndex: i, entry: b.open, side }
      row.entry = b.open
    }
    pendingEntry = false
    pendingExit = false

    const r = row.rsi
    if (isShort) {
      if (r !== null && r > high) cum += r - high
      else cum = 0
    } else {
      if (r !== null && r < low) cum += low - r
      else cum = 0
    }
    row.cum = cum

    const isLoss = pos !== null && (isShort ? b.close > pos.entry : b.close < pos.entry)
    if (isShort) {
      if (r !== null && r > high && cum > cumThreshold && pos === null) { pendingEntry = true; row.signal = 'entry' }
      if (r !== null && r <= low && !isLoss && pos !== null) { pendingExit = true; row.signal = 'exit' }
    } else {
      if (r !== null && r < low && cum > cumThreshold && pos === null) { pendingEntry = true; row.signal = 'entry' }
      if (r !== null && r >= high && !isLoss && pos !== null) { pendingExit = true; row.signal = 'exit' }
    }
    out.push(row)
  }
  return { bars: out, trades, open: pos, side }
}

export type RsiGridReport = {
  params: number[]
  side: RsiGridSide
  rsi: number | null
  cum: number
  /** Order fired on the last close, fills at the next open. */
  pending: 'entry' | 'exit' | null
  position: { entry: number; barsHeld: number; pnlPct: number; side: RsiGridSide } | null
  record: { closed: number; wins: number; avgPct: number | null }
}

const r2 = (v: number): number => {
  const r = Math.round(v * 100) / 100
  return r === 0 ? 0 : r
}

export function rsiGridReport(
  bars: readonly Bar[],
  params: readonly number[] = RSI_GRID_DEFAULTS,
  side: RsiGridSide = 'long',
): RsiGridReport {
  const [len, low, high, th] = params as [number, number, number, number]
  const g = rsiGrid(bars, len, low, high, th, side)
  const last = g.bars.at(-1)
  const close = bars.at(-1)?.close ?? 0
  const isShort = side === 'short'
  const pcts = g.trades.map(t =>
    isShort ? 100 * (t.entry - t.exit) / t.entry : 100 * (t.exit - t.entry) / t.entry,
  )
  const pnlPct = g.open === null ? 0
    : isShort ? 100 * (g.open.entry - close) / g.open.entry
    : 100 * (close - g.open.entry) / g.open.entry

  return {
    params: [...params],
    side,
    rsi: last?.rsi == null ? null : r2(last.rsi),
    cum: r2(last?.cum ?? 0),
    pending: last?.signal ?? null,
    position: g.open === null ? null : {
      entry: r2(g.open.entry),
      barsHeld: bars.length - 1 - g.open.entryIndex,
      pnlPct: r2(pnlPct),
      side,
    },
    record: {
      closed: g.trades.length,
      wins: pcts.filter(p => p > 0).length,
      avgPct: pcts.length === 0 ? null : r2(pcts.reduce((a, b) => a + b, 0) / pcts.length),
    },
  }
}

export function renderRsiGrid(r: RsiGridReport, shortReport?: RsiGridReport): string {
  if (shortReport) {
    const [len, low, high, th] = r.params as [number, number, number, number]
    const sParams = shortReport.params
    const sLow = sParams[1] ?? 40
    const sHigh = sParams[2] ?? 70
    const sTh = sParams[3] ?? th

    const formatState = (item: RsiGridReport) => {
      const isShort = item.side === 'short'
      if (item.position !== null) {
        const p = item.position
        return `${isShort ? '持空' : '持多'} @${p.entry} (${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%)`
      }
      if (item.pending === 'entry') return `触发${isShort ? '进空' : '进多'}`
      if (item.pending === 'exit') return '触发平仓'
      if (item.rsi !== null) {
        if (!isShort && item.rsi < low) return `超卖累计 ${item.cum}/${th}`
        if (isShort && item.rsi > sHigh) return `超买累计 ${item.cum}/${sTh}`
      }
      return '空仓'
    }

    return `  RSI双向网格 [多: <${low}平≥${high} | ${formatState(r)}] [空: >${sHigh}平≤${sLow} | ${formatState(shortReport)}]`
  }

  const [len, low, high, th] = r.params as [number, number, number, number]
  const isShort = r.side === 'short'
  const rec = r.record.closed === 0 ? '无已平样本'
    : `本序列已平 ${r.record.closed} 笔，盈利 ${r.record.wins} 笔，均 ${r.record.avgPct! >= 0 ? '+' : ''}${r.record.avgPct}%/笔`
  const trigger = isShort ? `RSI(${len})>${high} 且累计差值>${th} 进空` : `RSI(${len})<${low} 且累计差值>${th} 进多`
  const exitRule = isShort ? `RSI≤${low} 且不亏才平` : `RSI≥${high} 且不亏才平`
  const head = `  RSI${isShort ? '空头' : ''}网格 [${trigger}；${exitRule}；无止损｜未验证，${rec}]: `
  const rsiTxt = r.rsi === null ? `RSI${len} 未就绪` : `RSI${len} ${r.rsi}`
  const state: string[] = [`${rsiTxt} | 累计差值 ${r.cum}`]
  if (r.position !== null) {
    const p = r.position
    state.push(`${p.side === 'short' ? '持空' : '持多'} @${p.entry} ${p.barsHeld}根 ${p.pnlPct >= 0 ? '浮盈' : '浮亏'} ${p.pnlPct}%`)
    if (p.pnlPct < 0) {
      state.push(`浮亏中不会平仓，须回到成本${isShort ? '下方且 RSI≤' + low : '上方且 RSI≥' + high}`)
    }
  } else {
    state.push('空仓')
    if (r.rsi !== null) {
      if (isShort && r.rsi > high && r.pending !== 'entry') {
        state.push(`已进超买区，累计 ${r.cum}/${th} 未达标`)
      } else if (!isShort && r.rsi < low && r.pending !== 'entry') {
        state.push(`已进超卖区，累计 ${r.cum}/${th} 未达标`)
      }
    }
  }
  if (r.pending === 'entry') state.push(`本根触发${isShort ? '进空' : '进多'}，下根开盘成交`)
  if (r.pending === 'exit') state.push('本根触发平仓，下根开盘成交')
  return head + state.join(' | ')
}
