/**
 * Compact Chinese formatting for large-order tool / overlay labels.
 * @module
 */

import type { LargeOrderWall, LargeOrdersSnapshot } from './types.js'

/** Compact USDT print: 亿 / 万. */
export function formatUsdCn(n: number): string {
  if (!Number.isFinite(n)) return '–'
  const sign = n < 0 ? '-' : ''
  const abs = Math.abs(n)
  if (abs >= 1e8) return `${sign}${(abs / 1e8).toFixed(2)}亿`
  if (abs >= 1e4) return `${sign}${(abs / 1e4).toFixed(1)}万`
  if (abs >= 100) return `${sign}${abs.toFixed(0)}`
  return `${sign}${abs.toFixed(0)}`
}

/** Age of a wall as 短标签. */
export function formatAge(startMs: number, nowMs = Date.now()): string {
  if (!(startMs > 0)) return ''
  const sec = Math.max(0, Math.floor((nowMs - startMs) / 1000))
  if (sec < 60) return `${sec}s`
  if (sec < 3600) return `${Math.floor(sec / 60)}m`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h`
  return `${Math.floor(sec / 86400)}d`
}

export function formatWallLine(w: LargeOrderWall): string {
  const side = w.side === 'buy' ? '买墙' : '卖墙'
  const age = formatAge(w.startTime)
  const ageTxt = age ? ` · 挂${age}` : ''
  const venue = `${w.exchange}${w.market === 'spot' ? '现货' : w.market === 'perp' ? '合约' : ''}`
  return `${venue} ${side} $${formatUsdCn(w.currentUsd)} @ ${w.price}${ageTxt}`
}

/** One-line / multi-line summary for the large_orders tool. */
export function renderLargeOrders(snap: LargeOrdersSnapshot, top = 40): string {
  const buys = snap.walls.filter(w => w.side === 'buy')
  const sells = snap.walls.filter(w => w.side === 'sell')
  const lines: string[] = [
    `大额挂单 ${snap.pair}（${snap.cgSymbol}，窗口 ${snap.startTime}..${snap.endTime}，共 ${snap.orderCount} 堵，展示 Top ${Math.min(top, snap.walls.length)}）`,
  ]
  if (snap.statistics.length > 0) {
    for (const s of snap.statistics.slice(0, 5)) {
      const venue = `${s.exchange}${s.market === 'spot' ? '现货' : s.market === 'perp' ? '合约' : ''}`
      lines.push(
        `  统计 ${venue}: 挂买 $${formatUsdCn(s.bidsTotalUsd)} / 挂卖 $${formatUsdCn(s.asksTotalUsd)}`,
      )
    }
  }
  lines.push('卖墙:')
  for (const w of sells.slice(0, Math.ceil(top / 2))) lines.push(`  ${formatWallLine(w)}`)
  if (sells.length === 0) lines.push('  （无）')
  lines.push('买墙:')
  for (const w of buys.slice(0, Math.ceil(top / 2))) lines.push(`  ${formatWallLine(w)}`)
  if (buys.length === 0) lines.push('  （无）')
  return lines.join('\n')
}
