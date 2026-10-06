/**
 * Long/short entry markers on the price pane: arrow + entry/stop/targets on
 * each signal bar, and the latest signal's levels extended to the right edge.
 * The rules live in tool-market/src/signal.ts and are imported, not copied, so
 * the chart draws exactly the signals market_snapshot reports to the model.
 * ponytail: cross-package relative import of a pure file; publish a subpath export if a third package needs it.
 */
import { entrySignals, signalStatus } from '../../../../tool-market/src/signal.js'
import type { EntrySignal } from '../../../../tool-market/src/signal.js'
import { formatPrice } from '../precision.js'

type K = { timestamp: number; open: number; high: number; low: number; close: number; volume?: number }
type Row = { signal?: EntrySignal; status?: string }

const LONG = '#22c55e'
const SHORT = '#ef4444'
const STATUS_ZH: Record<string, string> = { open: '持有中', target1: '已到T1', target2: '已到T2', stopped: '已止损' }

export function signalRows(list: readonly K[], period: number, factor: number): Row[] {
  const bars = list.map(k => ({ time: String(k.timestamp), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0 }))
  const rows: Row[] = list.map(() => ({}))
  for (const s of entrySignals(bars, period, factor)) rows[s.index] = { signal: s, status: signalStatus(bars, s) }
  return rows
}

export const entrySignalIndicator = {
  name: 'ENTRY_SIGNAL',
  shortName: '进场信号',
  series: 'price' as const,
  precision: 2,
  calcParams: [60, 4],
  figures: [],
  calc: (list: K[], ind: { calcParams: number[] }) => signalRows(list, ind.calcParams[0] ?? 60, ind.calcParams[1] ?? 4),
  createTooltipDataSource: ({ indicator, crosshair }: {
    indicator: { calcParams: number[]; result: Row[] }
    crosshair: { dataIndex?: number }
  }) => {
    const res = indicator.result ?? []
    const i = crosshair.dataIndex ?? res.length - 1
    // Nearest signal at or before the hovered bar.
    let s: EntrySignal | undefined
    let status: string | undefined
    for (let j = Math.min(i, res.length - 1); j >= 0; j--) if (res[j]?.signal) { s = res[j]!.signal; status = res[j]!.status; break }
    const c = s?.side === 'long' ? LONG : SHORT
    return {
      calcParamsText: `(${indicator.calcParams.join(', ')})`,
      values: s === undefined ? [] : [
        { title: '', value: { text: `${s.side === 'long' ? '做多' : '做空'}·${s.kind === 'flip' ? '翻转' : '回踩'}`, color: c } },
        { title: '入: ', value: { text: formatPrice(s.entry), color: c } },
        { title: '损: ', value: { text: formatPrice(s.stop), color: '#a475e0' } },
        { title: 'T1: ', value: { text: formatPrice(s.target1), color: '#539bf5' } },
        { title: 'T2: ', value: { text: formatPrice(s.target2), color: '#539bf5' } },
        { title: '', value: { text: STATUS_ZH[status ?? 'open'] ?? '', color: '#ffa726' } },
      ],
      icons: [],
    }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, kLineDataList, bounding }: {
    ctx: CanvasRenderingContext2D
    indicator: { result: Row[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    visibleRange: { from: number; to: number }
    kLineDataList: K[]
    bounding: { width: number }
  }) => {
    const res = indicator.result ?? []
    ctx.save()
    ctx.font = '11px sans-serif'
    ctx.textBaseline = 'middle'
    for (let i = Math.max(0, visibleRange.from); i < Math.min(res.length, visibleRange.to); i++) {
      const s = res[i]?.signal
      if (s === undefined) continue
      const k = kLineDataList[i]!
      const x = xAxis.convertToPixel(i)
      const long = s.side === 'long'
      const color = long ? LONG : SHORT
      const tip = yAxis.convertToPixel(long ? k.low : k.high) + (long ? 6 : -6)
      const d = long ? 1 : -1
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.moveTo(x, tip)
      ctx.lineTo(x - 6, tip + d * 10)
      ctx.lineTo(x + 6, tip + d * 10)
      ctx.closePath()
      ctx.fill()
      const label = `${long ? '多' : '空'} ${s.entry}`
      const w = ctx.measureText(label).width + 8
      const y = tip + d * 20
      ctx.fillRect(x - w / 2, y - 8, w, 16)
      ctx.fillStyle = '#fff'
      ctx.textAlign = 'center'
      ctx.fillText(label, x, y)
    }
    // Latest signal still in play: entry / stop / T1 / T2 out to the right edge.
    let last = -1
    for (let i = res.length - 1; i >= 0; i--) if (res[i]?.signal) { last = i; break }
    const s = last >= 0 ? res[last]!.signal! : undefined
    const status = last >= 0 ? res[last]!.status : undefined
    if (s !== undefined && (status === 'open' || status === 'target1')) {
      const x0 = Math.max(0, xAxis.convertToPixel(last))
      const lines: [number, string, string][] = [
        [s.entry, s.side === 'long' ? LONG : SHORT, `${s.side === 'long' ? '多' : '空'}入 ${s.entry}`],
        [s.stop, '#a475e0', `止损 ${s.stop}`],
        [s.target1, '#539bf5', `T1 ${s.target1}`],
        [s.target2, '#539bf5', `T2 ${s.target2}`],
      ]
      ctx.textAlign = 'right'
      for (const [price, color, text] of lines) {
        const y = yAxis.convertToPixel(price)
        ctx.strokeStyle = color
        ctx.fillStyle = color
        ctx.setLineDash(price === s.entry ? [] : [4, 3])
        ctx.beginPath()
        ctx.moveTo(x0, y)
        ctx.lineTo(bounding.width, y)
        ctx.stroke()
        ctx.fillText(text, bounding.width - 4, y - 7)
      }
    }
    ctx.restore()
    return false
  },
}
