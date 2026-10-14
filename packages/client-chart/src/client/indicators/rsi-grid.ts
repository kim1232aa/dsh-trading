/**
 * "RSI策略网格现货" in three parts: RSI_GRID (RSI 0–100 + 30/60 hlines),
 * RSI_GRID_CUM (累计差值 on its own pane/axis) and RSI_GRID_MARKS
 * (strategy.entry/close markers on the candle pane).
 * The logic is imported from tool-market/src/rsi-grid.ts so the chart and
 * market_snapshot cannot disagree.
 */
import { rsiGrid, RSI_GRID_DEFAULTS } from '../../../../tool-market/src/rsi-grid.js'
import type { RsiGridBar } from '../../../../tool-market/src/rsi-grid.js'
import { formatPrice } from '../precision.js'

type K = { open: number; high: number; low: number; close: number; timestamp?: number }
type Row = RsiGridBar & { inPos: boolean; posEntry?: number }

const RSI_C = '#539bf5'
const CUM_C = '#ffa726'
const LOW_C = '#f47067'
const HIGH_C = '#3ddc97'
const FONT = '11px system-ui, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif'

export function rsiGridRows(list: readonly K[], p: readonly number[]): Row[] {
  const [len, low, high, th] = p.length === 4 ? p : RSI_GRID_DEFAULTS
  const g = rsiGrid(list, len, low, high, th, 'long', { closedOnly: true })
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
  // Pine plots RSI against 0–100; cum lives in its own pane (RSI_GRID_CUM) so it can't squash RSI.
  minValue: 0,
  maxValue: 100,
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [
    { key: 'rsi', title: 'RSI: ', type: 'line', styles: () => ({ color: RSI_C }) },
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
      values.push({ title: '持多 ', value: { text: `@${formatPrice(r.posEntry)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%`, color: pnl >= 0 ? HIGH_C : LOW_C } })
    }
    if (r?.provisional) values.push({ title: '', value: { text: '未收盘·不出信号', color: '#768390' } })
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
    ctx.restore()
    return false
  },
}

type DrawArgs = {
  ctx: CanvasRenderingContext2D
  indicator: { calcParams: number[]; result: Row[] }
  xAxis: { convertToPixel: (v: number) => number }
  yAxis: { convertToPixel: (v: number) => number }
  visibleRange: { from: number; to: number }
  bounding: { width: number }
  kLineDataList: K[]
}

/** 累计差值 on its own pane and own y-axis, with the entry threshold as a dashed line. */
export const rsiGridCumIndicator = {
  name: 'RSI_GRID_CUM',
  shortName: '累计差值',
  precision: 2,
  minValue: 0,
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [{ key: 'cum', title: '累计差值: ', type: 'line', styles: () => ({ color: CUM_C }) }],
  calc: (list: K[], ind: { calcParams: number[] }) => rsiGridRows(list, ind.calcParams),
  draw: ({ ctx, indicator, yAxis, bounding }: DrawArgs) => {
    const th = indicator.calcParams[3] ?? 10
    const y = yAxis.convertToPixel(th)
    ctx.save()
    ctx.strokeStyle = CUM_C
    ctx.globalAlpha = 0.6
    ctx.setLineDash([4, 3])
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke()
    ctx.globalAlpha = 1
    ctx.fillStyle = CUM_C; ctx.font = FONT; ctx.textAlign = 'right'
    ctx.fillText(`阈值${th}`, bounding.width - 4, y - 3)
    ctx.restore()
    return false
  },
}

/**
 * strategy.entry / strategy.close markers on the CANDLE pane, at the fill bar
 * (next open after the signal close), like TradingView draws strategy orders.
 */
export const rsiGridMarksIndicator = {
  name: 'RSI_GRID_MARKS',
  shortName: 'RSI网格信号',
  series: 'price',
  calcParams: [...RSI_GRID_DEFAULTS],
  figures: [],
  calc: (list: K[], ind: { calcParams: number[] }) => rsiGridRows(list, ind.calcParams),
  createTooltipDataSource: () => ({ name: '', calcParamsText: '', values: [], icons: [] }),
  draw: ({ ctx, indicator, xAxis, yAxis, visibleRange, kLineDataList, bounding }: DrawArgs) => {
    const res = indicator.result ?? []
    ctx.save()
    ctx.font = FONT
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    for (let i = Math.max(0, visibleRange.from); i < Math.min(res.length, visibleRange.to); i++) {
      const r = res[i]!
      const k = kLineDataList[i]
      if (!k || (r.entry === undefined && r.exit === undefined)) continue
      const x = xAxis.convertToPixel(i)
      for (const isEntry of [true, false]) {
        const px = isEntry ? r.entry : r.exit
        if (px === undefined) continue
        const yBar = yAxis.convertToPixel(isEntry ? k.low : k.high)
        const y = yBar + (isEntry ? 16 : -16)
        const col = isEntry ? HIGH_C : LOW_C
        ctx.fillStyle = col
        ctx.beginPath()
        // arrow pointing at the bar
        if (isEntry) { ctx.moveTo(x, yBar + 4); ctx.lineTo(x - 5, yBar + 9); ctx.lineTo(x + 5, yBar + 9) }
        else { ctx.moveTo(x, yBar - 4); ctx.lineTo(x - 5, yBar - 9); ctx.lineTo(x + 5, yBar - 9) }
        ctx.fill()
        const txt = `${isEntry ? 'RSI多头' : '平仓'} ${formatPrice(px)}`
        const w = ctx.measureText(txt).width + 8
        ctx.beginPath(); ctx.roundRect?.(x - w / 2, y - 8, w, 16, 3); if (!ctx.roundRect) ctx.rect(x - w / 2, y - 8, w, 16); ctx.fill()
        ctx.fillStyle = '#fff'
        ctx.fillText(txt, x, y)
      }
    }
    // Open position whose entry bar may be scrolled out of view: Pine keeps holding
    // (no exit while openprofit < 0, pyramiding = 1 ignores new entries), so show
    // the cost line — otherwise a 累计差值 spike with no marker looks like a bug.
    const last = res.at(-1)
    if (last?.inPos && last.posEntry !== undefined) {
      const y = yAxis.convertToPixel(last.posEntry)
      const c = kLineDataList.at(-1)?.close ?? last.posEntry
      const pnl = 100 * (c - last.posEntry) / last.posEntry
      ctx.strokeStyle = HIGH_C
      ctx.setLineDash([6, 4])
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(bounding.width, y); ctx.stroke()
      ctx.setLineDash([])
      ctx.textAlign = 'left'
      ctx.fillStyle = HIGH_C
      ctx.fillText(`RSI网格持多 @${formatPrice(last.posEntry)} ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)}%（浮亏不平、不加仓）`, 6, y - 8)
    }
    ctx.restore()
    return false
  },
}
