/**
 * Long/short entry markers on the price pane: arrow + entry/stop/targets on
 * each signal bar, and the latest signal's levels extended to the right edge.
 * The rules live in tool-market/src/signal.ts and are imported, not copied, so
 * the chart draws exactly the signals market_snapshot reports to the model.
 *
 * EXPERIMENTAL / 未验证: SuperTrend-based observer only — not a validated
 * entry system. Kept in 指标参数 with defaultVisible:false and title
 * 「多空观察信号(未验证)」; do not treat markers as trade advice.
 * ponytail: cross-package relative import of a pure file; publish a subpath export if a third package needs it.
 */
import { advanceSignal, confirmedBarCount, entrySignals, signalStatus } from '../../../../tool-market/src/signal.js'
import type { EntrySignal, SignalOptions, SignalStatus } from '../../../../tool-market/src/signal.js'
import { detectPricePrecision, formatPrice } from '../precision.js'

type K = { timestamp: number; open: number; high: number; low: number; close: number; volume?: number }
type Row = { signal?: EntrySignal; status?: SignalStatus; tracked?: EntrySignal; asOfStatus?: SignalStatus; confirmed?: boolean; precision?: number }

const LONG = '#22c55e'
const SHORT = '#ef4444'
const STATUS_ZH: Record<SignalStatus, string> = { open: '信号跟踪中', target1: '触及T1·继续跟踪', target2: '触及T2·结束', stopped: '触及止损·结束' }

function signalPrecision(s: EntrySignal, base: number): number {
  const gap = Math.min(Math.abs(s.entry - s.stop), Math.abs(s.target1 - s.entry), Math.abs(s.target2 - s.target1))
  return gap > 0 && Number.isFinite(gap) ? Math.max(base, Math.ceil(-Math.log10(gap)) + 1) : base
}

function formatSignalPrice(value: number, precision: number): string {
  // Number's round-trip representation remains nonzero and distinct beyond fixed decimal display.
  return precision > 20 ? String(value) : formatPrice(value, precision)
}

export function signalRows(list: readonly K[], period: number, factor: number, options: SignalOptions = {}): Row[] {
  const bars = list.map(k => ({ time: String(k.timestamp), open: k.open, high: k.high, low: k.low, close: k.close, volume: k.volume ?? 0 }))
  const precision = detectPricePrecision([...list])
  const rows: Row[] = list.map(() => ({ confirmed: false, precision }))
  const n = confirmedBarCount(list.length, options)
  for (const s of entrySignals(bars, period, factor, options)) {
    rows[s.index]!.signal = s
    rows[s.index]!.status = signalStatus(bars, s, options)
  }
  let tracked: EntrySignal | undefined
  let status: SignalStatus = 'open'
  for (let i = 0; i < list.length; i++) {
    const row = rows[i]!
    row.confirmed = i < n
    if (row.signal !== undefined) {
      tracked = row.signal
      status = 'open'
    } else if (tracked !== undefined && i < n) {
      status = advanceSignal(tracked, status, list[i]!)
    }
    if (tracked !== undefined) {
      row.tracked = tracked
      row.asOfStatus = status
      row.precision = signalPrecision(tracked, precision)
    }
  }
  return rows
}

export const entrySignalIndicator = {
  name: 'ENTRY_SIGNAL',
  shortName: '信号观察',
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
    const i = Math.max(0, Math.min(crosshair.dataIndex ?? res.length - 1, res.length - 1))
    const row = res[i]
    const s = row?.tracked
    const status = row?.asOfStatus
    const precision = row?.precision ?? 2
    const c = s?.side === 'long' ? LONG : SHORT
    return {
      calcParamsText: `(${indicator.calcParams.join(', ')})`,
      values: [
        ...s === undefined ? [] : [
          { title: '', value: { text: `${s.side === 'long' ? '多头观察' : '空头观察'}·已确认·${s.kind === 'flip' ? '翻转' : '回踩'}`, color: c } },
          { title: '参考: ', value: { text: formatSignalPrice(s.entry, precision), color: c } },
          { title: '损: ', value: { text: formatSignalPrice(s.stop, precision), color: '#a475e0' } },
          { title: 'T1: ', value: { text: formatSignalPrice(s.target1, precision), color: '#539bf5' } },
          { title: 'T2: ', value: { text: formatSignalPrice(s.target2, precision), color: '#539bf5' } },
          { title: '当时: ', value: { text: STATUS_ZH[status ?? 'open'], color: '#ffa726' } },
        ],
        ...row?.confirmed === false
          ? [{ title: '当前K线: ', value: { text: '等待收盘，不确认新信号', color: '#ffa726' } }]
          : [],
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
    const basePrecision = detectPricePrecision(kLineDataList)
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
      const precision = signalPrecision(s, basePrecision)
      const label = `${long ? '多' : '空'}·确认 ${formatSignalPrice(s.entry, precision)}`
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
      const precision = signalPrecision(s, basePrecision)
      const x0 = Math.max(0, xAxis.convertToPixel(last))
      const lines: [number, string, string][] = [
        [s.entry, s.side === 'long' ? LONG : SHORT, `${s.side === 'long' ? '多' : '空'}参考 ${formatSignalPrice(s.entry, precision)}`],
        [s.stop, '#a475e0', `止损 ${formatSignalPrice(s.stop, precision)}`],
        [s.target1, '#539bf5', `T1 ${formatSignalPrice(s.target1, precision)}`],
        [s.target2, '#539bf5', `T2 ${formatSignalPrice(s.target2, precision)}`],
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
