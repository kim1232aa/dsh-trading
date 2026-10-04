/**
 * "RSI策略网格现货" on its own pane: RSI line, 累计差值 line, the low/high
 * threshold lines (Pine hline), and markers where the strategy enters/exits.
 * The logic is imported from tool-market/src/rsi-grid.ts so the chart and
 * market_snapshot cannot disagree.
 */
import { rsiGrid, RSI_GRID_DEFAULTS } from '../../../../tool-market/src/rsi-grid.js'
import type { RsiGridBar } from '../../../../tool-market/src/rsi-grid.js'

type K = { open: number; high: number; low: number; close: number }
type Row = RsiGridBar & { inPos: boolean; posEntry?: number }

const RSI_C = '#539bf5'
const CUM_C = '#ffa726'
const LOW_C = '#f47067'
const HIGH_C = '#3ddc97'
const FONT = '11px system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'

export function rsiGridRows(list: readonly K[], p: readonly number[]): Row[] {
  const [len, low, high, th] = p.length === 4 ? p : RSI_GRID_DEFAULTS
  const g = rsiGrid(list, len, low, high, th)
  let pos: number | undefined
  return g.bars.map(b => {
    if (b.exit !== undefined) pos = undefined
    if (b.entry !== undefined) pos = b.entry
    return { ...b, inPos: pos !== undefined, ...(pos !== undefined ? { posEntry: pos } : {}) }
  })
}

export const rsiGridIndicator = {
  name: 'RSI_GRID',
  shortName: 'RSI策略网格现货',
  precision: 2,
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [
    { key: 'rsi', title: 'RSI: ', type: 'line', styles: () => ({ color: RSI_C }) },
    { key: 'cum', title: '累计差值: ', type: 'line', styles: () => ({ color: CUM_C }) },
  ],
  calc: (list: K[], ind: { calcParams: number[] }) => rsiGridRows(list, ind.calcParams),
  createTooltipDataSource: ({ indicator, crosshair, kLineDataList }: {
    indicator: { calcParams: number[]; result: Row[] }
    crosshair: { dataIndex?: number }
    kLineDataList: K[]
  }) => {
    const res = indicator.result ?? []
    const i = Math.min(crosshair.dataIndex ?? res.length - 1, res.length - 1)
    const r = res[i]
    const [, low, high, th] = indicator.calcParams
    const values: { title: string; value: { text: string; color: string } }[] = r === undefined ? [] : [
      { title: 'RSI: ', value: { text: r.rsi === null ? '–' : r.rsi.toFixed(2), color: RSI_C } },
      { title: '累计差值: ', value: { text: `${r.cum.toFixed(2)}/${th}`, color: CUM_C } },
    ]
    if (r?.inPos && r.posEntry !== undefined) {
      const c = kLineDataList[i]?.close ?? r.posEntry
      const pnl = 100 * (c - r.posEntry) / r.posEntry
      values.push({ title: '持多 ', value: { text: `@${r.posEntry.toFixed(2)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, color: pnl >= 0 ? HIGH_C : LOW_C } })
    }
    if (r?.signal) values.push({ title: '', value: { text: r.signal === 'entry' ? '触发进多' : '触发平仓', color: r.signal === 'entry' ? HIGH_C : LOW_C } })
    return { calcParamsText: `(${indicator.calcParams.join(',')}｜低${low} 高${high})`, values, icons: [] }
  },
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, bounding }: {
    ctx: CanvasRenderingContext2D
    indicator: { calcParams: number[]; result: Row[] }
    xAxis: { convertToPixel: (v: number) => number }
    yAxis: { convertToPixel: (v: number) => number }
    visibleRange: { from: number; to: number }
    bounding: { width: number }
  }) => {
    const res = indicator.result ?? []
    const [, low, high] = indicator.calcParams as [number, number, number, number]
    ctx.save()
    // hline(threshold_rsi_low / threshold_rsi_high)
    for (const [v, c, t] of [[low, LOW_C, `低${low}`], [high, HIGH_C, `高${high}`]] as [number, string, string][]) {
      const y = yAxis.convertToPixel(v)
      ctx.strokeStyle = c
      ctx.setLineDash([4, 3])
      ctx.beginPath()
      ctx.moveTo(0, y)
      ctx.lineTo(bounding.width, y)
      ctx.stroke()
      ctx.fillStyle = c
      ctx.font = FONT
      ctx.textAlign = 'right'
      ctx.fillText(t, bounding.width - 4, y - 3)
    }
    ctx.setLineDash([])
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    // Fills happen on the bar after the signal; mark the fill bar, as strategy() does.
    for (let i = Math.max(0, visibleRange.from); i < Math.min(res.length, visibleRange.to); i++) {
      const r = res[i]!
      if (r.entry === undefined && r.exit === undefined) continue
      const x = xAxis.convertToPixel(i)
      const isEntry = r.entry !== undefined
      const y = yAxis.convertToPixel(isEntry ? low : high) + (isEntry ? 10 : -10)
      ctx.fillStyle = isEntry ? HIGH_C : LOW_C
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#fff'
      ctx.fillText(isEntry ? '多' : '平', x, y)
    }
    ctx.restore()
    return false
  },
}
