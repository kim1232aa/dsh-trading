/**
 * Port of the Pine v5 strategy "RSI策略网格现货" (user-supplied), logic unchanged:
 *
 *   rsi = ta.rsi(close, len)                       // Wilder/RMA, same as ./indicators rsi
 *   cumulative_diff: rsi < low ? += (low - rsi) : := 0
 *   entry  = rsi < low and cumulative_diff > cumThreshold        → strategy.entry long
 *   exit   = rsi >= high and not (strategy.openprofit < 0)       → strategy.close
 *
 * Strategy semantics reproduced: orders fire on bar close and fill at the NEXT
 * bar's open (process_orders_on_close=false); pyramiding=1, so an entry while
 * already long is ignored; strategy.close while flat is a no-op; openprofit is
 * marked at the bar's close. There is no stop loss: a losing position is held
 * until it is back in profit with RSI ≥ high.
 *
 * Pure; the browser chart imports this file directly.
 * @module @dsh-trading/tool-market
 */

import { rsi as rsiSeries } from './indicators.js'

export const RSI_GRID_DEFAULTS = [7, 30, 60, 10] as const

type Bar = { open: number; close: number }

export type RsiGridBar = {
  rsi: number | null
  cum: number
  /** Condition fired on this bar's close (order fills next bar). */
  signal?: 'entry' | 'exit'
  /** Fill price on this bar's open. */
  entry?: number
  exit?: number
}

export type RsiGridTrade = { entryIndex: number; entry: number; exitIndex: number; exit: number }

export type RsiGridResult = {
  bars: RsiGridBar[]
  trades: RsiGridTrade[]
  open: { entryIndex: number; entry: number } | null
}

export function rsiGrid(bars: readonly Bar[], length = 7, low = 30, high = 60, cumThreshold = 10): RsiGridResult {
  const rs = rsiSeries(bars.map(b => b.close), length)
  const out: RsiGridBar[] = []
  const trades: RsiGridTrade[] = []
  let cum = 0
  let pos: { entryIndex: number; entry: number } | null = null
  let pendingEntry = false
  let pendingExit = false
  for (let i = 0; i < bars.length; i++) {
    const b = bars[i]!
    const row: RsiGridBar = { rsi: rs[i] ?? null, cum: 0 }
    if (pendingExit && pos !== null) {
      trades.push({ ...pos, exitIndex: i, exit: b.open })
      row.exit = b.open
      pos = null
    }
    if (pendingEntry && pos === null) {
      pos = { entryIndex: i, entry: b.open }
      row.entry = b.open
    }
    pendingEntry = false
    pendingExit = false

    const r = row.rsi
    // Pine: `na < low` is false, so the warm-up bars reset the accumulator.
    if (r !== null && r < low) cum += low - r
    else cum = 0
    row.cum = cum

    const isLoss = pos !== null && b.close < pos.entry
    if (r !== null && r < low && cum > cumThreshold && pos === null) { pendingEntry = true; row.signal = 'entry' }
    if (r !== null && r >= high && !isLoss && pos !== null) { pendingExit = true; row.signal = 'exit' }
    out.push(row)
  }
  return { bars: out, trades, open: pos }
}

export type RsiGridReport = {
  params: number[]
  rsi: number | null
  cum: number
  /** Order fired on the last close, fills at the next open. */
  pending: 'entry' | 'exit' | null
  position: { entry: number; barsHeld: number; pnlPct: number } | null
  record: { closed: number; wins: number; avgPct: number | null }
}

const r2 = (v: number): number => {
  const r = Math.round(v * 100) / 100
  return r === 0 ? 0 : r
}

export function rsiGridReport(bars: readonly Bar[], params: readonly number[] = RSI_GRID_DEFAULTS): RsiGridReport {
  const [len, low, high, th] = params as [number, number, number, number]
  const g = rsiGrid(bars, len, low, high, th)
  const last = g.bars.at(-1)
  const close = bars.at(-1)?.close ?? 0
  const pcts = g.trades.map(t => 100 * (t.exit - t.entry) / t.entry)
  return {
    params: [...params],
    rsi: last?.rsi == null ? null : r2(last.rsi),
    cum: r2(last?.cum ?? 0),
    pending: last?.signal ?? null,
    position: g.open === null ? null : {
      entry: r2(g.open.entry),
      barsHeld: bars.length - 1 - g.open.entryIndex,
      pnlPct: r2(100 * (close - g.open.entry) / g.open.entry),
    },
    record: {
      closed: g.trades.length,
      wins: pcts.filter(p => p > 0).length,
      avgPct: pcts.length === 0 ? null : r2(pcts.reduce((a, b) => a + b, 0) / pcts.length),
    },
  }
}

export function renderRsiGrid(r: RsiGridReport): string {
  const [len, low, high, th] = r.params as [number, number, number, number]
  const rec = r.record.closed === 0 ? '无已平样本'
    : `本序列已平 ${r.record.closed} 笔，盈利 ${r.record.wins} 笔，均 ${r.record.avgPct! >= 0 ? '+' : ''}${r.record.avgPct}%/笔`
  const head = `  RSI网格 [RSI(${len})<${low} 且累计差值>${th} 进多；RSI≥${high} 且不亏才平；无止损｜未验证，${rec}]: `
  const rsiTxt = r.rsi === null ? `RSI${len} 未就绪` : `RSI${len} ${r.rsi}`
  const state: string[] = [`${rsiTxt} | 累计差值 ${r.cum}`]
  if (r.position !== null) {
    const p = r.position
    state.push(`持多 @${p.entry} ${p.barsHeld}根 ${p.pnlPct >= 0 ? '浮盈' : '浮亏'} ${p.pnlPct}%`)
    if (p.pnlPct < 0) state.push('浮亏中不会平仓，须回到成本上方且 RSI≥' + high)
  } else {
    state.push('空仓')
    if (r.rsi !== null && r.rsi < low && r.pending !== 'entry') state.push(`已进超卖区，累计 ${r.cum}/${th} 未达标`)
  }
  if (r.pending === 'entry') state.push('本根触发进多，下根开盘成交')
  if (r.pending === 'exit') state.push('本根触发平仓，下根开盘成交')
  return head + state.join(' | ')
}
